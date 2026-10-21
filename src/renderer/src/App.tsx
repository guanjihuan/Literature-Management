// 工作台主 App:TitleBar / list+content 主区 / StatusBar;SettingsPage + SearchPanel
// 走 lazy + uiModals 控制开关。ShortcutsSheet / QuickSwitcher / TopBar / TabsBar
// / StandaloneNotes / FavoritesView / ActivityBar / RightColumn 已下线。

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import { useSettingsStore } from './store/settings';
import { useWorkspaceStore } from './store/workspace';
import { usePathsStore, subscribePathsReload } from './store/paths';
import { useUiModals } from './store/uiModals';
import { useSyncStores } from './hooks/useSyncStores';
import {
  useGlobalShortcuts,
  ensureDispatcher,
  buildShortcutBindings,
  registerCommands,
} from './command/shortcuts';
import { buildCommands } from './command/registry';
import { buildCommandActions } from './command/actions';
import { applyBootstrapOnce, bootstrapOnce } from './lib/bootstrap';
import { createLogger } from './lib/logger-client';
import { StatusBar } from './components/layout/StatusBar';
import { TitleBar } from './components/layout/TitleBar';
import { WorkbenchListPanel } from './components/layout/WorkbenchListPanel';
import { WorkbenchContentPanel } from './components/layout/WorkbenchContentPanel';

import { ConfirmHost } from './components/common/ConfirmHost';
import { ToastContainer } from './lib/toast';
import { ErrorBoundary } from './components/system/ErrorBoundary';
import { StartupOverlay } from './components/startup/StartupOverlay';
import { initI18n } from './i18n';

import { applyTheme, applyThemePreset, applyFontFamily, PRESET_IS_DARK } from './lib/theme';

const SettingsPage = lazy(() =>
  import('./components/settings/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);
// 全局搜索面板(⌘⇧F):lazy + Suspense,首次按快捷键才下载,主 bundle 体积不动
const SearchPanel = lazy(() =>
  import('./components/search/SearchPanel').then((m) => ({ default: m.SearchPanel })),
);

const log = createLogger('App');

export function App() {
  const statusBarHidden = useWorkspaceStore((s) => s.statusBarHidden);
  const themePreset = useWorkspaceStore((s) => s.themePreset);
  const fontFamily = useWorkspaceStore((s) => s.fontFamily);
  // per-field 订阅:避免订阅整 settings 对象(任意字段更新都让 App 整树重渲)
  // workspaceLayout 用 useShallow 防止 setState 换对象引用触发浅比较失配
  const settingsTheme = useSettingsStore((s) => s.settings?.theme);
  const settingsWorkspaceLayout = useSettingsStore(useShallow((s) => s.settings?.workspaceLayout));
  const settingsLanguage = useSettingsStore((s) => s.settings?.language);
  // settingsOpen / searchOpen 走 uiModals — 三处入口(TitleBar ⚙ / ⌘, / ⌘⇧F)
  // 都直接 useUiModals.setXxxOpen(true),App 只读
  const settingsOpen = useUiModals((s) => s.settingsOpen);
  const searchOpen = useUiModals((s) => s.searchOpen);

  const { t } = useTranslation();

  // i18n 实例进 React state,让 getRtl() 拿到 instance.getRtl helper
  const [initI18nValue, setInitI18nValue] = useState<Awaited<ReturnType<typeof initI18n>> | null>(
    null,
  );
  useEffect(() => {
    let cancelled = false;
    initI18n()
      .then((i) => {
        if (!cancelled) setInitI18nValue(i);
      })
      .catch((err: unknown) => {
        // initI18n 任一动态 chunk 404(坏部署/陈旧 SW)或 init 抛错都 reject
        // 此处 .then 衍生的 Promise 不挂 .catch 即 unhandled rejection —
        // UI 静默退化成原始 i18n key 且无 toast。只 log.warn(React 可能未就绪)
        if (!cancelled) log.warn('initI18n failed', err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Skip link 国际化:index.html 静态中文"跳到主内容"在 en-US 用户首次 Tab
  // 听到不熟悉的文字 → 跳过 link 直接进 chrome(WCAG 2.4.1 失效)
  useEffect(() => {
    const el = document.querySelector<HTMLElement>('[data-skip-link]');
    if (!el) return;
    el.textContent = t('common.skipLinkLabel');
  }, [settingsLanguage, t]);

  // 全局热键:bindings 在 render 阶段同步算(buildCommands + buildShortcutBindings
  // 都是纯函数),与 dispatcher.registerAll 异步路径解耦。useMemo 裹一层 ——
  // 之前每次 render buildCommands 返新数组(因 buildCommandActions 创建新 function
  // 引用),useGlobalShortcuts 收到新 spec 会 re-register 全局快捷键
  const shortcutBindings = useMemo(
    () => buildShortcutBindings(buildCommands(buildCommandActions())),
    [],
  );
  useGlobalShortcuts(shortcutBindings);

  // 注册 dispatcher 命令:旧实现 useEffect 异步 registerAll,首屏 render 装好
  // keydown listener 但 dispatcher Map 还是空,mount 后 16ms 内按键 → "unknown
  // command" warn,快捷键静默失效(尤其 HMR / 快速测试)。registerCommands 是
  // idempotent + 同步前置,useGlobalShortcuts 自身 ensureRegistered 兜底
  useEffect(() => {
    registerCommands(buildCommands(buildCommandActions()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 主进程菜单点击 → dispatcher
  useEffect(() => {
    if (!window.api?.onMenuInvoke) return;
    return window.api.onMenuInvoke(({ id }) => {
      void ensureDispatcher()
        .then((d) => d.invoke(id))
        .catch((err: unknown) => {
          log.error('menu invoke failed', { id, err });
          // 菜单点击失败给用户信号:dispatcher 自身已在 invoke 内部 push toast;
          // 这里是 ensureDispatcher dynamic import 拒绝 / 非 dispatcher 路径
          // 抛错的"完全无响应"场景兜底
          try {
            void import('./lib/toast')
              .then((m) => {
                m.useToast.getState().show({
                  type: 'error',
                  // 走 t() common.menuActionFailed(原硬编码英文模板对 zh-CN 用户错)
                  // t 来自 useTranslation 闭包,useEffect 内部 t 已 ready
                  message: t('common.menuActionFailed', { id }),
                });
              })
              // try/catch 只接同步 throw,动态 import 异步拒绝走不到 catch;
              // toast chunk 自身加载失败的极末端路径,空 .catch 静默吞
              .catch(() => {});
          } catch {
            /* toast dispatch 自己失败,只 log 不 throw */
          }
        });
    });
  }, [t]);

  useSyncStores();

  useEffect(() => {
    void (async () => {
      // audit-r87:结果落地收口到 lib/bootstrap 的 applyBootstrapOnce 单点
      // (与 main.tsx 共享)—— 旧版两个 awaiter 拿同一成功结果各自
      // applyBootstrapSettings + setState,pendingLayout 的 localStorage key
      // 在 updateSettings 异步 .then 才清,同帧双 apply → 双 updateSettings
      // 写;后到者现在拿 'already-applied' 零副作用。await 前捕获 loaded
      // 快照的假守卫一并删除(单飞 promise 已保证 IPC 不翻倍,判定统一以
      // outcome 为键)。
      // audit-r85:与 main.tsx 共享 bootstrapOnce 单飞 promise。
      try {
        const r = await bootstrapOnce();
        const outcome = applyBootstrapOnce(r);
        // outcome==='ipc-failed' ⇔ !r.ok(helper 契约);`&& !r.ok` 只为 TS
        // 判别式窄化 —— 单飞共享同一结果对象,两者不可能分叉。
        if (outcome === 'ipc-failed' && !r.ok) {
          log.warn('bootstrap IPC failed, falling back to legacy IPC pair', r.message);
          await Promise.all([
            useSettingsStore.getState().load(),
            usePathsStore.getState().load(),
          ]);
        }
      } catch (err) {
        log.error('bootstrap threw', err);
        // audit-r80:settings.load() 失败会 rethrow(留 trace 但向上抛),
        // legacy 兜底也挂时不能让这个 void IIFE 变成无 trace 的
        // unhandled rejection —— 再兜一层只记录。
        try {
          await Promise.all([useSettingsStore.getState().load(), usePathsStore.getState().load()]);
        } catch (fallbackErr) {
          log.error('legacy settings/paths fallback also failed', fallbackErr);
        }
      }
      // library 模块下线 — 旧 useLibraryStore.load() 整段删除
    })();
    const off = subscribePathsReload();
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // audit 2026-09-10:hydrateLayout 改为「layout 首次可用时跑一次」—— 旧实现 deps=[] 仅 mount 跑;
  // 若 main.tsx bootstrap 失败,App-level fallback 异步 setState(settings),
  // 首次 mount 时 settingsWorkspaceLayout 仍是 undefined,effect bail,
  // 后续 settings 进入也不会重跑 → layout 永不 hydrate,UI 始终默认 50/50
  // 用 ref 守「已 hydrate」标志:后续 settings update 不覆盖本地 store
  // (避免 200ms persistLayout 防抖窗口内乐观 toggle 被 settings 推回旧值覆盖)
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (hydratedRef.current) return;
    if (!settingsWorkspaceLayout) return;
    hydratedRef.current = true;
    useWorkspaceStore.getState().hydrateLayout(settingsWorkspaceLayout);
  }, [settingsWorkspaceLayout]);

  useEffect(() => {
    if (!settingsTheme) return;
    // PRESET_IS_DARK 用 null 表示「跟随 theme」:强制暗色 → 移除 .light
    // (:root 默认即暗色);强制浅色 → 加 .light;null/undefined → 走 applyTheme
    const forced = PRESET_IS_DARK[themePreset];
    if (forced !== null && forced !== undefined) {
      const root = document.documentElement;
      if (forced) root.classList.remove('light');
      else root.classList.add('light');
      return;
    }
    const cleanup = applyTheme(settingsTheme);
    return cleanup;
  }, [settingsTheme, themePreset]);

  useEffect(() => {
    const cleanup = applyThemePreset(themePreset);
    return cleanup;
  }, [themePreset]);

  useEffect(() => {
    const cleanup = applyFontFamily(fontFamily);
    return cleanup;
  }, [fontFamily]);

  useEffect(() => {
    if (!settingsLanguage) return;
    void initI18n()
      .then((i) => i.changeLanguage(settingsLanguage))
      .catch((err: unknown) => {
        // changeLanguage 极端情况下仍可能 reject;语言切换失败不应是致命路径
        log.warn('changeLanguage failed', { settingsLanguage, err });
      });
    // 同步 <html lang> — i18next 只切 UI 文本,documentElement.lang 仍是
    // index.html 硬编码 'zh-CN',SR(VoiceOver / NVDA / JAWS)按 lang 决定
    // 发音规则/字典,en-US 后 SR 仍按 zh-CN 拼读英文 → 完全听不清
    document.documentElement.lang = settingsLanguage;
    // 同步 <html dir> — RTL 提示;ar-SA / he-IL / fa-IR / ur-PK 等 locale
    // 即使布局用 logical CSS,SR 仍按 LTR 顺序念,bidi 文本在标题/列表 leak
    // 从 locale JSON 的 _meta.rtl 取真实 RTL 标记,新增语言无需再改此处
    document.documentElement.dir = initI18nValue?.getRtl(settingsLanguage) ? 'rtl' : 'ltr';
    // 通知主进程重建菜单(menu 走主进程 i18n,不在 react-i18next 覆盖范围)
    // 旧实现裸 void 吞 IPC 失败 → renderer 新语言 / native menu 旧语言永久漂移
    void window.api
      ?.rebuildMenu?.()
      .catch((err: unknown) => log.error('rebuildMenu IPC failed', err));
  }, [settingsLanguage, initI18nValue]);

  return (
    <ErrorBoundary name="App">
      <div className="h-screen flex bg-canvas text-fg overflow-hidden">
        {/* TitleBar / 主区 / StatusBar;真实 h1#app-title-h1 在 TitleBar.tsx
            内部,这里不再保留重复 sr-only h1(WAI-ARIA 页内仅一个顶级 heading) */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* 自定义窗口标题栏:frame:false + titleBarStyle:hidden 完全去掉原生
              chrome,接管品牌 + 拖拽区 + 主题切换 + 设置 + 窗口控件。
              ErrorBoundary 包裹 — TitleBar 内部有 platform probe / window API
              探测,启动 race 时曾让模块顶层 throw,fallback 给占位 div 保持
              chrome 行高度(避免主区跳位),按钮区静默不可点 */}
          <ErrorBoundary
            name="App.titleBar"
            fallback={() => (
              <div
                className="h-titlebar bg-bg-raised border-b border-border-subtle flex-shrink-0"
                aria-hidden="true"
              />
            )}
          >
            <TitleBar />
          </ErrorBoundary>

          {/* 主区:左侧 list panel(跟 active Tab 切列表)+ 右侧 content panel。
              2026-10-18 解耦:content panel 由文献/笔记各自"打开"态驱动,切 Tab
              不换主区内容;两边都开 → 双列。active 仅决定双关时空态身份。 */}
          <main
            id="main-content"
            // SR landmark main 挂 aria-labelledby 到 TitleBar h1 让 NVDA 念出名
            aria-labelledby="app-title-h1"
            tabIndex={-1}
            className="flex-1 flex min-h-0 min-w-0 overflow-hidden outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            <ErrorBoundary name="Main.listPanel">
              <Suspense fallback={null}>
                <WorkbenchListPanel />
              </Suspense>
            </ErrorBoundary>
            <ErrorBoundary name="Main.contentPanel">
              <Suspense fallback={null}>
                <WorkbenchContentPanel />
              </Suspense>
            </ErrorBoundary>
          </main>

          {!statusBarHidden && <StatusBar />}
        </div>

        <Suspense fallback={null}>
          <SettingsPage
            open={settingsOpen}
            onClose={() => useUiModals.getState().setSettingsOpen(false)}
          />
        </Suspense>
        <Suspense fallback={null}>
          <SearchPanel
            open={searchOpen}
            onClose={() => useUiModals.getState().setSearchOpen(false)}
          />
        </Suspense>
        <ToastContainer
          bottomOffset={
            statusBarHidden ? '8px' : 'calc(var(--statusbar-h) + 8px)'
          }
        />
        <ConfirmHost />

        <StartupOverlay />
      </div>
    </ErrorBoundary>
  );
}
