// 工作台状态:激活模块 + chrome 可见性 + 主题/字体预设 + 跨组件 flag (新/重命名/
// 聚焦/存当前笔记)。settings 是单一真实来源,本地 zustand 副本做乐观更新,持久化
// 后台 200ms debounce;关窗由 pagehide/beforeunload 同步 flush。
// 已下线:home / recent / trash / ActivityBar / detailCollapsed / toggleDetail
// / toggleActivityBar / toggleZen / teardown 钩子
// r242:sidebarCollapsed / toggleSidebar **复活** —— 只管「左侧列表面板折叠」
//   (标题栏按钮 + ⌘B / Ctrl+B),与已下线的 detailCollapsed / zenMode 无关。

import { create } from 'zustand';
import type { WorkspaceLayout, FontFamily, ThemePreset, ModuleKey } from '@shared/types';
import { FONT_FAMILIES, THEME_PRESETS } from '@shared/types';
import { useSettingsStore } from './settings';
import { PENDING_LAYOUT_LS_KEY } from './constants';
import { useToast } from '../lib/toast';
import { createLogger } from '../lib/logger-client';
import { errMsg } from '../lib/error';
import type { PendingCommandFields } from './pendingCommand';
import { initPendingFields, pendingRequest, pendingConsume, pendingPeek } from './pendingCommand';

const log = createLogger('useWorkspaceStore');

// audit-r138:删 `export type { ModuleKey }` re-export(0 caller)。
// audit-r217:ModuleKey 单源从 chrome.tsx 下沉到 @shared/types —— 该 union
//   是领域词汇,定义在 UI 组件层造成 store → components 的 type 级反向依赖
//   (层级倒挂);本文件与 command/registry 现直接 import 自 @shared/types。
//   FontFamily / ThemePreset 保留 re-export:SettingsPage.tsx:31 走本 re-export
//   二次绕道(其他调用方走直接 import),强删会让 settings 页面类型报错。

// FontFamily / ThemePreset 类型 + readonly tuple 搬到 @shared/types 作单一真相源;
// 这里 re-export 不断既有 6 处调用方
export type { FontFamily, ThemePreset };

const VALID_FONT_FAMILY: ReadonlySet<FontFamily> = new Set(FONT_FAMILIES);
const VALID_THEME_PRESET: ReadonlySet<ThemePreset> = new Set(THEME_PRESETS);

// 通用 enum 收窄:typeof string + Set.has + as-cast,新增 preset(例如 density)
// 只写一份;未来 VALID_* Set 换 typed tuple 内部 cast 只改一处
function narrowEnum<T extends string>(v: unknown, valid: ReadonlySet<T>, fallback: T): T {
  return typeof v === 'string' && (valid as ReadonlySet<string>).has(v) ? (v as T) : fallback;
}

// hydrateLayout 入口防御:settings 路径上 union 已被收窄(validate.ts VALID_*),
// 但测试 mock / 第三方入口可能传 raw 字符串 — 不收窄会进 zustand 状态,
// 下游 applyFontFamily / applyThemePreset 用作 map key 拿到 undefined
const narrowFontFamily = (v: unknown, fallback: FontFamily): FontFamily =>
  narrowEnum(v, VALID_FONT_FAMILY, fallback);
const narrowThemePreset = (v: unknown, fallback: ThemePreset): ThemePreset =>
  narrowEnum(v, VALID_THEME_PRESET, fallback);

export interface WorkspaceState {
  active: ModuleKey;
  setActive: (m: ModuleKey) => void;

  statusBarHidden: boolean;
  /**
   * 左侧列表面板(文献 / 笔记 Tab)是否折叠。
   * r242:WorkbenchListPanel 据此决定自己渲不渲染 —— 折叠 = 面板整个
   *   不进 DOM(主区自然占满),不是「宽度设成 0」(后者会留下一条
   *   分隔条 + 边框死白条,同 r237 的 scrollbar-gutter 教训)。
   */
  sidebarCollapsed: boolean;
  fontFamily: FontFamily;
  themePreset: ThemePreset;

  // chrome 切换(乐观更新 + 后台持久化)
  toggleStatusBar: () => void;
  /** 折叠 / 展开左侧列表面板(r242) */
  toggleSidebar: () => void;
  setFontFamily: (f: FontFamily) => void;
  setThemePreset: (p: ThemePreset) => void;

  /** 单向入口:从 settings hydrate 一次性写入。UI 操作不要反向调 */
  hydrateLayout: (layout: WorkspaceLayout | undefined) => void;

  // 跨 tab 通讯:NotesList 只在 active='notes' 挂载,但 ⌘N/菜单 新建笔记要求
  // 不论当前 tab 都能触发 — 原 CustomEvent 在 library tab 时 listener 未注册事件丢,
  // 改用 store flag(全局入口 + 挂载时 consume 一次性)
  pendingNewNote: PendingCommandFields<true>;
  requestNewNote: () => void;
  consumeNewNoteRequest: () => boolean;

  // 跨 tab 通讯:右键菜单「重命名」— NotesList 选重命名 → setActive('notes')
  // + requestRenameNote(id) → NotesView 挂载/pendingRenameNote.version 变化
  // → consume + 弹 Modal(避免把 NotesView rename 逻辑复制到 NotesList)
  // 跨 tab 兜底:library tab 时右键重命名笔记也能跳到 notes tab + 弹 Modal
  pendingRenameNote: PendingCommandFields<string>;
  requestRenameNote: (id: string) => void;
  // audit-r148 (2026-10-19):peek + 条件 consume 取代直接 consume。
  //   NotesView rename effect 之前在 id !== selectedId 检查之前就
  //   consumeRenameNoteRequest(),若 id 不匹配(React 18 batching 让
  //   setSelected 与 requestRename 顺序不保证)请求被静默丢,用户右键
  //   重命名无 modal。peek 只读不重置,等下次 effect 重跑再决定。
  peekRenameNoteRequest: () => string | null;
  consumeRenameNoteRequest: () => string | null;

  // 跨组件通讯:新建/拖入 后「希望聚焦 body」 — 走 store flag 跨
  // NotesList → NotesView → StandaloneNoteEditorCore → MarkdownEditor
  // 与 pendingRenameNote 同款 flag 模式但语义不同:rename 丢一次可接受
  // (用户重右键即可),focus 丢用户完全无反馈(光标卡 list 不知为何打不上字),
  // race 必须保留 armed 等下次 activeNoteFullId 变化,不能 consume。
  // peek + 条件 consume 取代旧 consume + rearm(rearm 会 version++ 让 effect
  // 重跑,IPC 卡死时撞 React nested-update limit)
  pendingFocusNote: PendingCommandFields<string>;
  requestFocusNote: (id: string) => void;
  peekFocusNoteRequest: () => string | null;
  consumeFocusNoteRequest: () => string | null;

  // 跨组件通讯:⌘S 存当前笔记。原 WORKBENCH_EVENT.SaveActiveNote CustomEvent
  // 迁移到这里 — renderer 已无 CustomEvent 跨组件通讯,全部走 store flag
  pendingSaveActiveNote: PendingCommandFields<true>;
  requestSaveActiveNote: () => void;
  consumeSaveActiveNoteRequest: () => boolean;
}

const initialLayout: WorkspaceLayout = {
  statusBarHidden: false,
  sidebarCollapsed: false,
  fontFamily: 'system',
  themePreset: 'default',
};

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  // audit-r236 (2026-10-20):默认从 'notes' 改回 'library'(用户要求「软件启动
  //   的时候,左侧栏默认在文献 tab」)。
  //   历史:audit-r69 (2026-10-16) 曾把默认从 'library' 改成 'notes',理由是
  //   library 模块随 audit-r56 下线后两 panel 都拿不到内容、首屏白屏。该前提
  //   早已失效:audit-r71 (2026-10-17) 恢复了 WorkbenchListPanel 的 library
  //   分支(LiteratureList 接管),2026-10-18 主区双列解耦后 WorkbenchContentPanel
  //   的开列分支也不再看 active。现在 'library' 首屏与 'notes' 首屏同样可用,
  //   纯产品选择 —— 本系统是文献管理工具,启动落在文献 tab 更合直觉。
  //   行为锁:tests/unit/renderer/store/workspace-default-tab.test.ts
  active: 'library',
  setActive: (m) => set({ active: m }),

  statusBarHidden: initialLayout.statusBarHidden ?? false,
  // r242:默认展开 —— 用户要的是「能藏起来」,不是「默认藏起来」。
  sidebarCollapsed: initialLayout.sidebarCollapsed ?? false,
  // 字面值是已知合法 union 成员,写明让 TS 不再抱怨「string 不可赋给 FontFamily」
  fontFamily: narrowFontFamily(initialLayout.fontFamily, 'system'),
  themePreset: narrowThemePreset(initialLayout.themePreset, 'default'),

  toggleStatusBar: () => {
    const next = !get().statusBarHidden;
    set({ statusBarHidden: next });
    persistLayout({ statusBarHidden: next });
  },
  // r242:折叠 / 展开左栏。与 toggleStatusBar 同款 —— 乐观 set + 后台落盘
  //   (persistLayout 200ms debounce,关窗由 flushPendingWorkspaceLayout 兜底)。
  toggleSidebar: () => {
    const next = !get().sidebarCollapsed;
    set({ sidebarCollapsed: next });
    persistLayout({ sidebarCollapsed: next });
  },
  setFontFamily: (f) => {
    set({ fontFamily: f });
    persistLayout({ fontFamily: f });
  },
  setThemePreset: (p) => {
    set({ themePreset: p });
    persistLayout({ themePreset: p });
  },
  hydrateLayout: (layout) => {
    if (!layout) return;
    set({
      // 防御:settings 已 sanitize,但测试/第三方入口可能传 raw 字符串,
      // narrow* 收窄失败落回默认值,坏 union 不进 zustand
      statusBarHidden: layout.statusBarHidden ?? false,
      // r242:sidebarCollapsed 同款防御 —— 只有真正的 boolean 才算「折叠」,
      //   其它值(raw string / number)一律当「展开」,坏数据不把左栏永久藏掉。
      sidebarCollapsed: layout.sidebarCollapsed === true,
      fontFamily: narrowFontFamily(layout.fontFamily, 'system'),
      themePreset: narrowThemePreset(layout.themePreset, 'default'),
    });
  },

  pendingNewNote: initPendingFields<true>(),
  requestNewNote: () => pendingRequest(set, 'pendingNewNote', true),
  // 读取 + 原子性重置,后续重复触发不会重复弹输入框
  consumeNewNoteRequest: () => pendingConsume(get, set, 'pendingNewNote') === true,

  pendingRenameNote: initPendingFields<string>(),
  requestRenameNote: (id) => pendingRequest(set, 'pendingRenameNote', id),
  // audit-r148:peek 只读 —— 不重置 hasPending / payload / version,
  //   让 NotesView 在 id !== selectedId 不匹配时保留 flag armed,
  //   等下次 _pendingRenameTick 或 _pendingRenameMatchTick 触发重试。
  peekRenameNoteRequest: () => pendingPeek(get, 'pendingRenameNote') as string | null,
  consumeRenameNoteRequest: () => pendingConsume(get, set, 'pendingRenameNote') as string | null,

  pendingFocusNote: initPendingFields<string>(),
  // version tick 必带 — 同 id 二次 requestFocusNote 也要让 NotesView effect 重跑
  // (zustand 浅比较会 short-circuit 同值),已在 pendingCommand helper 统一处理
  requestFocusNote: (id) => pendingRequest(set, 'pendingFocusNote', id),
  // peek 只读:IPC 卡死/curFullId 不匹配时必须保留 flag armed 等下一次
  // activeNoteFullId 变化触发,不能 consume(丢失)也不能 re-arm(version++ 自循环)
  peekFocusNoteRequest: () => pendingPeek(get, 'pendingFocusNote') as string | null,
  consumeFocusNoteRequest: () => pendingConsume(get, set, 'pendingFocusNote') as string | null,

  pendingSaveActiveNote: initPendingFields<true>(),
  requestSaveActiveNote: () => pendingRequest(set, 'pendingSaveActiveNote', true),
  consumeSaveActiveNoteRequest: () => pendingConsume(get, set, 'pendingSaveActiveNote') === true,
}));

/** flush pending layout writes — pagehide/beforeunload 时同步刷盘 */
export function flushPendingWorkspaceLayout(): void {
  if (persistTimer !== null) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (pendingLayout) {
    // 写 localStorage 兜底:useSettingsStore.update 走异步 IPC,关窗瞬间发起
    // 但不等返回就 unload,可能丢最后 toggle。localStorage renderer-local 但
    // 跨次启动存活;hydrate 时合并(见 settings.ts:applyPendingLayoutFallback)
    try {
      localStorage.setItem(PENDING_LAYOUT_LS_KEY, JSON.stringify(pendingLayout));
    } catch {
      // 隐私模式/quota 满 → silent,主路径 IPC 仍尝试发送
    }
    // 只 log 不弹 toast:flush 在 pagehide/beforeunload 触发(关窗瞬间),
    // 弹 toast 用户看不到,反而污染 shutdown 时序。localStorage 兜底仍生效,
    // 下次启动可恢复
    const layoutSnapshot = pendingLayout;
    useSettingsStore
      .getState()
      .update({ workspaceLayout: layoutSnapshot })
      .catch((err: unknown) => {
        log.warn('flushPendingWorkspaceLayout IPC failed', err);
      });
    pendingLayout = null;
  }
}

// 挂同步刷盘,关窗瞬间不丢最后状态。
// 守卫:Node 22+ 在 worker 进程 globalThis 上有 partial `window`(Web API polyfill),
// 但不带 addEventListener — 必须双重检查 typeof === 'function' 否则 vitest 在
// node env 跑 renderer 模块直接 TypeError。
// _workspaceLifecycleInitialized 守卫:vitest + jsdom 下 module 在每个 test 重新
// 求值,listener 累加 N 个 → pagehide/beforeunload 触发时同一 handler 跑 N 次
// → 重复 flush + 偶发 race
// audit-r161 HMR 累积防御:抽函数引用 + import.meta.hot.dispose 清旧 listener
let _workspaceLifecycleInitialized = false;
let _onPageHide: (() => void) | null = null;
let _onBeforeUnload: (() => void) | null = null;
function _ensureWorkspaceLifecycle(): void {
  if (_workspaceLifecycleInitialized) return;
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  _workspaceLifecycleInitialized = true;
  _onPageHide = flushPendingWorkspaceLayout;
  _onBeforeUnload = flushPendingWorkspaceLayout;
  window.addEventListener('pagehide', _onPageHide);
  window.addEventListener('beforeunload', _onBeforeUnload);
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      if (_onPageHide) window.removeEventListener('pagehide', _onPageHide);
      if (_onBeforeUnload) window.removeEventListener('beforeunload', _onBeforeUnload);
      _onPageHide = null;
      _onBeforeUnload = null;
      _workspaceLifecycleInitialized = false;
    });
  }
}
_ensureWorkspaceLifecycle();

/** 把布局变更持久化到 settings。
 *  200ms debounce trailing-edge:用户连击 ⌘+Shift+S / setFontFamily / setThemePreset
 *  反复 toggle 时,中间状态合并成一次 settings.update IPC,而不是每个 toggle
 *  都立刻 round-trip 到主进程写盘。flushPendingWorkspaceLayout 在 pagehide/
 *  beforeunload 时同步刷掉最后一次状态,避免关窗瞬间丢字段。
 *  C3R1:workspace 本地 zustand(同步)作单一真实来源,不是 settings(异步 in-flight)。
 *  settings.update 是 async,IPC roundtrip 期间 settings.workspaceLayout 仍是旧值 —
 *  用户在 ~10ms 内连续 toggle 多个字段时,后续 persistLayout 读到 stale current
 *  会把前面已 toggle 字段覆盖回去(toggleStatusBar 后 setFontFamily,后者用 stale
 *  current 里 statusBarHidden:true 重置前面刚写的 false)。workspace 本地态 set()
 *  后 getState() 立即反映,无 in-flight 问题 */
const PERSIST_LAYOUT_DEBOUNCE_MS = 200;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingLayout: WorkspaceLayout | null = null;

function persistLayout(patch: Partial<WorkspaceLayout>): void {
  const s = useWorkspaceStore.getState();
  const layout: WorkspaceLayout = {
    statusBarHidden: s.statusBarHidden,
    // r242:左栏折叠态同款持久化 —— 走 workspaceLayout 落 settings.json,
    //   重启后保持上次折叠/展开状态(用户不必每次重开都再点一次)。
    sidebarCollapsed: s.sidebarCollapsed,
    fontFamily: s.fontFamily,
    themePreset: s.themePreset,
    ...patch, // patch 显式覆盖(语义保险,实际字段通常已反映在 s 中)
  };
  pendingLayout = layout;
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const toWrite = pendingLayout;
    pendingLayout = null;
    if (toWrite) {
      useSettingsStore
        .getState()
        .update({ workspaceLayout: toWrite })
        .catch((err: unknown) => {
          // settings.update 失败 → 提示用户。失败通常意味 IPC 桥未就绪
          // (preload 没注入 / 主进程 bridge 死),走 useToast 通用错误通道
          // workspace 本地态已翻转,只是没落盘,下次 toggle 重试,无需 rollback
          log.error('persistLayout settings.update failed', err);
          // 动态 import i18next(本回调是 200ms debounce 落盘失败处理,在正常运行
          // 期执行,等 import resolve;真正不能等的 pagehide/beforeunload 路径
          // 不需要 i18n,只 log.warn)。若本文件静态 import i18next,~80KB
          // minified 被拖回首屏 chunk,抵消 i18n/index.ts 的拆包设计
          void import('i18next')
            .then(({ default: i18n }) => {
              useToast.getState().show({
                type: 'error',
                message: i18n.t('toast.layoutPersistFailed', { msg: errMsg(err) }),
              });
            })
            .catch((i18nErr: unknown) => {
              // 连 i18n 引擎都拉不到(构建异常/chunk 缺失)→ 退回原始字符串。
              // 绝不能让「翻译失败」盖掉「持久化失败」这条真正要报的错
              log.warn('i18n lazy load failed for layoutPersistFailed toast', errMsg(i18nErr));
              useToast.getState().show({
                type: 'error',
                message: `Failed to persist layout: ${errMsg(err)}`,
              });
            });
        });
    }
  }, PERSIST_LAYOUT_DEBOUNCE_MS);
}
