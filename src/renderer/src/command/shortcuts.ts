// 全局快捷键注册表 — 工作台热键单一真实来源(registry.ts Command.shortcut 字段
// 唯一真相,buildShortcutBindings 消费)
//
// 之前 GLOBAL_SHORTCUTS 写死 5 条(spec → string action 或 inline fn),与 registry
// 的 Command.shortcut 双源漂移(例:registry 绑 'settings.open' mod+,但 shortcuts.ts
// 没绑 → ⌘, 完全不响应;'module.library' mod+1 同款死键)。修:registry.shortcut
// 字段作为唯一真相,统一走 dispatcher,行为完全等价且能享受 when 守卫 + 集中日志
//
// 懒注册 + 同步路径:App.tsx 之前 useEffect 异步 registerAll,首屏 render 同步
// 装好 useGlobalShortcuts keydown listener 但 dispatcher Map 是空 — mount 后
// 16ms 内按键 → "unknown command" warn,快捷键静默失效。
//   1) registerCommands(commands) 显式入口(避免散在多 useEffect 块)
//   2) listener 内部 ensureRegistered + invoke,即便上层 registerAll 还没跑也走得通
// 两条组合:mount → 第一次按键 → 命中已注册命令,无需等 useEffect 微任务

import { useShortcut } from '../hooks/useShortcut';
import { createLogger } from '../lib/logger-client';
import i18next from 'i18next';
import type { Command } from './registry';
import { buildCommands, type CommandActions } from './registry';
import { buildCommandActions } from './actions';

const log = createLogger('shortcuts');

let _dispatcherPromise: Promise<typeof import('./dispatcher').dispatcher> | null = null;
export function ensureDispatcher() {
  if (!_dispatcherPromise) {
    const p = import('./dispatcher').then((m) => m.dispatcher);
    // audit-r76 (2026-10-17):与 ensureRegistered 同款复位 —— 旧实现 import
    //   失败时 rejected promise 永久缓存,之后每次按键都立刻拿到同一个
    //   rejection(快捷键整会话死亡)。失败清缓存,下次按键重新 import。
    p.catch(() => {
      if (_dispatcherPromise === p) _dispatcherPromise = null;
    });
    _dispatcherPromise = p;
  }
  return _dispatcherPromise;
}

export interface ShortcutBinding {
  spec: string;
  cmdId: string;
  opts?: { allowInInput?: boolean; capture?: boolean };
}

/** 从已注册的命令里挑出带 shortcut 的命令,转成 useShortcut 能消费的 binding 列表。
 *  cmd.shortcut undefined 跳过(没绑快捷键的命令可由菜单 IPC 触发);
 *  重复 spec 后者覆盖前者(allowInInput / capture 取后者),防 last-write-wins 隐患。
 *  必须先 registerCommands 再调用 — 否则 commands Map 空,所有快捷键 silent 不响应 */
export function buildShortcutBindings(cmds: Command[]): ShortcutBinding[] {
  // 默认所有 command shortcut 都允许在 input 内触发 — 'mod+S' 等保存类命令
  // 必须在 textarea 焦点时也工作;需要收紧时 registry 单独字段控制
  const seen = new Map<string, ShortcutBinding>();
  for (const cmd of cmds) {
    if (!cmd.shortcut) continue;
    // 重复 spec 后者覆盖前者之前静默不警告,改 log.warn 显式告知被丢弃的 cmdId
    if (seen.has(cmd.shortcut)) {
      log.warn('duplicate shortcut spec, last wins', {
        spec: cmd.shortcut,
        dropped: seen.get(cmd.shortcut)!.cmdId,
        kept: cmd.id,
      });
    }
    // audit-r124:上方「默认所有 command shortcut 都允许在 input 内触发」的
    //   政策自写下起从未生效 —— 这里不填 opts、useGlobalShortcuts 不传 opts,
    //   useShortcut 缺省 falsy → mod+S/mod+N/mod+shift+F 在 CodeMirror
    //   (contentEditable)与标题 Input 里全部静默失效(与菜单 accelerator
    //   行为漂移:menu ⌘S 在输入框里照样触发)。政策落地 = 显式写进 binding。
    seen.set(cmd.shortcut, { spec: cmd.shortcut, cmdId: cmd.id, opts: { allowInInput: true } });
  }
  return Array.from(seen.values());
}

// 懒注册守卫:锁住「重复注册」避免 actions 闭包在每次 render 重 build 时覆盖
// (registerAll 是 set 语义,重复 register 不影响结果但浪费闭包构建)
let _registered = false;
let _registerPromise: Promise<void> | null = null;

/** 显式注册入口(供 App.tsx 在 useEffect 里调用,提前把命令入 dispatcher)。
 *  通常与 useGlobalShortcuts 同源调用 buildCommands(buildCommandActions()),
 *  行为等价于 dispatcher.registerAll(buildCommands(actions))。
 *  重复调用是 no-op — 避免 actions 闭包在每次 render 重 build 时覆盖注册 */
export function registerCommands(
  commands: Command[],
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _actions: CommandActions = buildCommandActions(),
): void {
  if (_registered) return;
  _registered = true;
  // dispatch 是模块级单例 — 直接 import 同步路径,listener 触发时 dispatcher
  // 一定可用(若改 dynamic import,会与 shortcuts 同款 race 复发)
  // dynamic import 拒绝时 catch 兜底,不能留 unhandled rejection;注册失败
  // 清掉 _registered 让 ensureRegistered() 还能重试
  void import('./dispatcher')
    .then((m) => {
      m.dispatcher.registerAll(commands);
    })
    .catch((err: unknown) => {
      log.error('registerCommands: dispatcher import failed', err);
      _registered = false;
    });
}

export function useGlobalShortcuts(bindings: ReadonlyArray<ShortcutBinding>): void {
  /* eslint-disable react-hooks/rules-of-hooks */
  // for 循环调 useShortcut 看似违反 rules-of-hooks(必须顶层固定数量调用),
  // 但 invariant 由 App.tsx 保证:bindings 数组长度在 App 整个生命周期内固定 —
  // buildCommands(registry GLOBAL_COMMANDS) 是 const,buildShortcutBindings 只按
  // cmd.shortcut 过滤 + dedupe,长度等于「注册了快捷键的命令数」,不随 render 变化
  // 未来若引入 context-dependent commands(同命令不同模块不同 shortcut / user pref
  // 启用禁用),bindings 长度会动态变 — 届时改成单 useEffect + forEach addEventListener
  for (const b of bindings) {
    useShortcut(b.spec, () => {
      // 首按兜底:App.tsx useEffect 还没跑完(或 HMR 重置 module-level 状态),
      // listener 触发时 dispatcher 仍可能空 — ensureRegistered 内部「未注册则
      // 补注册」,让首屏第一按也有响应
      // 整条链都加 .catch,任意环节 throw(chunk-load fail / dynamic import reject)
      // 都不再静默丢失,toast push 让用户知道快捷键为什么没反应
      // 政策消费端(audit-r124):binding.opts 此前被丢弃,补传第三参
      void ensureRegistered()
        .then(() => ensureDispatcher().then((d) => d.invoke(b.cmdId)))
        .catch((err: unknown) => {
          log.error('shortcut chain failed', { spec: b.spec, cmdId: b.cmdId, err });
          try {
            // 动态 import useToast 避免循环依赖(dispatcher 已依赖 toast,这里
            // 再静态 import 会闭环)
            void import('../lib/toast').then((m) => {
              m.useToast.getState().show({
                type: 'error',
                // i18n 走 i18next 直调(非 React 上下文);原硬编码英文 zh-CN 混排
                message: i18next.t('toast.shortcutFailed', { spec: b.spec }),
              });
            });
          } catch {
            /* toast dispatch 自己失败,只 log 不可 throw */
          }
        });
    }, b.opts);
  }
  /* eslint-enable react-hooks/rules-of-hooks */
}

// ensureRegistered 内部 lazy register:若 App.tsx useEffect 还没跑,这里用默认
// actions 兜底 registerAll;否则 no-op。闭包内 actions 只在「没人调过 registerCommands」
// 时跑一次,正常启动路径上 App.tsx useEffect 会先调,这里 fall through
function ensureRegistered(): Promise<void> {
  if (_registered) return Promise.resolve();
  if (_registerPromise) return _registerPromise;
  _registerPromise = Promise.resolve().then(() => {
    if (_registered) return; // 二次确认 — registerCommands 可能在 microtask 之间同步跑
    const cmds = buildCommands(buildCommandActions());
    // dynamic import 拒绝(chunk-load fail / sandbox build mismatch)时不能直接
    // 吞掉,否则 registerAll 永远不跑,全局快捷键全死 — catch 至少留 log
    void import('./dispatcher')
      .then((m) => {
        m.dispatcher.registerAll(cmds);
        _registered = true;
      })
      .catch((err: unknown) => {
        log.error('dispatcher dynamic import failed', err);
        // audit-r76 (2026-10-17):清缓存允许重试 —— 旧实现失败后 _registerPromise
        //   永久缓存(已 resolve 但 _registered=false),后续 ensureRegistered
        //   全部直接返回旧 promise,import 永不再试:一次瞬时 chunk-load 失败
        //   = 全局快捷键整会话死亡。registerCommands 的 catch 失败路径
        //   (audit-r103:原引「82-89 行」行号锚已漂,改语义锚)已清 _registered,
        //   本条懒注册路径当时漏了同款复位,注释里承诺的
        //   「还能重试」实际走不通。清空后下一次 ensureRegistered 重新发注册。
        _registerPromise = null;
      });
  });
  return _registerPromise;
}
