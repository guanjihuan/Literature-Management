// 全局快捷键 hook — 修饰键自动适配平台、输入态默认屏蔽、preventDefault 语义统一。
// 用例:useShortcut('mod+K', () => openPalette(), { allowInInput: true })
// 已下线:formatShortcut / prettifyKey(CommandPalette 删除后无 UI 消费者)

import { useEffect } from 'react';
import { useLatestValue } from './useLatestValue';

type Modifier = 'mod' | 'ctrl' | 'shift' | 'alt';
type ParsedShortcut = {
  /** 小写后的按键,例如 'k'、'escape'、'arrowup' */
  key: string;
  /** 需要的修饰键集合 */
  modifiers: ReadonlySet<Modifier>;
};

interface ShortcutOptions {
  /** 动态条件;返回 false 时该次按键被忽略 */
  when?: () => boolean;
  /** 焦点处于 input/textarea/contenteditable 时默认不触发;true 强制触发 */
  allowInInput?: boolean;
  /** capture 阶段拦截(bubble 默认);"我比 input 先吃下这个按键"的命令热键 */
  capture?: boolean;
  /** handler 返回非 false 时自动 preventDefault;设 false 永不阻止默认 */
  preventDefault?: boolean;
}

const MODIFIERS = new Set<Modifier>(['mod', 'ctrl', 'shift', 'alt']);

/** 把 'mod+shift+k' 这种字面量解析为结构化的 key + modifiers */
export function parseShortcut(spec: string): ParsedShortcut {
  const parts = spec
    .toLowerCase()
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean);
  const modifiers = new Set<Modifier>();
  let key = '';
  for (const p of parts) {
    if (MODIFIERS.has(p as Modifier)) {
      modifiers.add(p as Modifier);
    } else {
      key = p;
    }
  }
  if (!key) {
    throw new Error(`[useShortcut] 快捷键 spec 缺少按键: "${spec}"`);
  }
  return { key, modifiers };
}

// 走 preload 暴露的 api.platform(process.platform)而不是 navigator.platform:
// navigator.platform 是 deprecated Web API,未来 Chromium 版本可能 undefined;
// 走 preload 与主进程 menu accelerator 走同源,避免渲染层/主层因字段名分歧
// 导致"Mac 菜单显示 ⌘,useShortcut 却按 Ctrl 触发"的漂移
function isMacPlatform(): boolean {
  return typeof window !== 'undefined' && window.api?.platform === 'darwin';
}

function matchesModifiers(
  e: KeyboardEvent,
  modifiers: ReadonlySet<Modifier>,
  mac: boolean,
): boolean {
  // 'mod' 优先于 'ctrl':声明任一都算"要求主修饰键"
  const wantMod = modifiers.has('mod') || modifiers.has('ctrl');
  if (modifiers.has('mod')) {
    const hasMeta = mac ? e.metaKey : e.ctrlKey;
    if (!hasMeta) return false;
    // 只声明 'mod',不能同时按 ctrl(Mac 上 Ctrl+⌘ 也算)
    if (!mac && e.metaKey) return false;
  }
  if (modifiers.has('ctrl') && !e.ctrlKey) return false;
  if (modifiers.has('shift') && !e.shiftKey) return false;
  if (modifiers.has('alt') && !e.altKey) return false;
  // 没声明任何修饰键时,不允许随机带修饰键,避免 Cmd+K 与 Cmd+Shift+K 误触发
  if (!wantMod && (e.metaKey || e.ctrlKey)) return false;
  if (!modifiers.has('shift') && e.shiftKey) return false;
  if (!modifiers.has('alt') && e.altKey) return false;
  return true;
}

function isInEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return true;
  if (target.isContentEditable) return true;
  return false;
}

/**
 * 注册一个全局快捷键。
 *
 * @param spec 描述,如 'mod+K'、'mod+Shift+P'、'Escape'、'mod+B'、'mod+.'
 * @param handler 触发时执行;若返回非 false + preventDefault 默认开 — 阻止默认行为
 * @param opts { when, allowInInput, capture, preventDefault }
 */
export function useShortcut(
  spec: string,
  handler: (e: KeyboardEvent) => void | boolean,
  opts: ShortcutOptions = {},
): void {
  // latest-ref 模式:每次 render 把最新 handler 写到 ref,keydown 时读 ref,
  // effect deps 不需要包含 handler。caller 不用 useCallback 包(否则多处 inline
  // 箭头函数捕获 closure 每次 render 换新引用,但 effect 不重挂,会读到首次
  // render 的 stale 值)
  const handlerRef = useLatestValue(handler);
  useEffect(() => {
    const parsed = parseShortcut(spec);
    const mac = isMacPlatform();

    const onKeyDown = (e: KeyboardEvent) => {
      if (!matchesModifiers(e, parsed.modifiers, mac)) return;
      if (e.key.toLowerCase() !== parsed.key) return;
      if (opts.when && !opts.when()) return;
      if (!opts.allowInInput && isInEditableTarget(e.target)) return;
      const result = handlerRef.current(e);
      if (result !== false && opts.preventDefault !== false) {
        e.preventDefault();
      }
    };

    const phase = opts.capture ? true : false;
    document.addEventListener('keydown', onKeyDown, { capture: phase });
    return () => document.removeEventListener('keydown', onKeyDown, { capture: phase });
    // deps 字段必须包含每个 opts 开关 — opts 控制 onKeyDown 闭包内行为,改值不重挂
    // 等于沿用旧 listener(短路在闭包里但 listener 占用调度 / 顺序错位)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, opts.when, opts.allowInInput, opts.capture, opts.preventDefault]);
}
