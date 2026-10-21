// 自定义窗口标题栏。BrowserWindow frame:false + titleBarStyle:hidden 接管:
//   - 左:品牌区(Mac 让位红绿灯,Win/Linux 渲染徽标盒 + 文字)
//   - 中:弹性拖拽区
//   - 右:主题切换 + 设置(跨平台) + 窗口三按钮(仅 Win/Linux)
// 拖拽由外层 .titlebar-drag(-webkit-app-region:drag)处理,按钮 no-drag 排除
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Minus, Square, Copy, X, Sun, Moon, Monitor, Settings, PanelLeft } from 'lucide-react';
// 品牌徽标图源:项目根 icon.ico(audit-r136 M6:5 级上溯相对路径注释)。
//   - 来源:audit-r135(2026-10-18)与 BrowserWindow dev icon /
//     electron-builder build.win.icon 三处同源(Win 平台);
//   - audit-r136(2026-10-19)修订:dev + packaged 真同源,packaged
//     形态靠 package.json build.files 数组收录 icon.ico 保障
//     (见 docs/architecture.md 「部署与分发 → 图标」段);
//   - 路径深度 5 级:TitleBar.tsx 在
//     src/renderer/src/components/layout/ 下,需 `../` × 5 才能回到
//     项目根。若未来文件位置移动(比如把 TitleBar 挪到
//     src/renderer/src/layout/),这条相对路径要同步改;app-icon-parity
//     测试用 regex `'../ × 5/icon.ico'` 锁住,改完跑测试即知;
//   - vite/client 的 '*.ico' 声明返回 URL 字符串;electron-vite
//     renderer base 为 './',打包后 file:// 下相对可解析。
import appIcon from '../../../../../icon.ico';
import { DEFAULT_SETTINGS, THEMES } from '@shared/types';
import { api, hasApi } from '../../lib/api';
import { useSettingsStore } from '../../store/settings';
import { useWorkspaceStore } from '../../store/workspace';
import { createLogger } from '../../lib/logger-client';
import { errMsg } from '../../lib/error';
import { useUiModals } from '../../store/uiModals';
import { formatShortcut } from '../../lib/shortcut';

// Mac 上 hiddenInset 让出 ~80px 给红绿灯 — logo 不能与红绿灯重叠
// 16 (左 padding) + 28 (红绿灯宽) + 36 (gap) ≈ 80px
const MAC_TRAFFIC_LIGHT_INSET = 80;

// module-scope log(放组件内每次 render 新建对象,触发 exhaustive-deps warning)
const log = createLogger('TitleBar');

export function TitleBar() {
  const { t } = useTranslation();
  // 平台检测(lazy init):模块顶层读 api.platform 在 Vite HMR / 启动 race
  // 期间 window.api 未注入时 Proxy 抛 TypeError,TitleBar 整模块崩 → ErrorBoundary
  // 兜底 → 看不到窗口三按钮。useState lazy init 仅在 mount 时读一次,此时已就绪
  // 兜底默认 false(Win/Linux 占大多数 + Mac 不渲染窗口三按钮在 !isMac 分支,
  // 默认 false 仅多渲染 Win 按钮,Mac 用户首帧后 useEffect 校正 — 远好过崩溃)
  const [isMac, setIsMac] = useState<boolean>(() => {
    try {
      return api.platform === 'darwin';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      setIsMac(api.platform === 'darwin');
    } catch (err: unknown) {
      // api.platform 通过 preload 注入,理论上不应抛,但 IPC bridge 未就绪
      // (启动 race)会让 isMac 停在初值 false → macOS 显 Win 风格窗口控件。
      // log 让启动 race 可观察
      log.warn('api.platform probe failed', errMsg(err));
    }
  }, []);
  // 启动 invoke 拉初值,后续 IPC 推更新;简单布尔 + 单向流,useState+useEffect 足够
  const [maximized, setMaximized] = useState(false);
  // audit-r135:品牌徽标加载失败兜底(Vite build 漏拷 / CSP 拦 file:// /
  //   资源损坏 都会触发 onError)。默认 false 渲染 <img>,失败置 true
  //   让条件渲染整块不挂,避免浏览器 broken-image 占位框常驻。无外部依赖、
  //   无图标资源时退化为空位(左 padding 仍撑开,不让拖拽区被右邻主题按钮
  //   侵占);若产品后续要 fallback 字形徽章,在此分支挂 BookOpen 等。
  const [imgError, setImgError] = useState(false);

  // 只订阅 theme 字段 — settings 其他字段变更不触发 TitleBar 重渲
  const theme = useSettingsStore((s) => s.settings?.theme);
  const updateSettings = useSettingsStore((s) => s.update);

  // r242:左栏折叠开关。放在标题栏(常驻)而不是左栏面板内部 ——
  //   折叠后面板整个不在 DOM 里,面板内的按钮会跟着消失,用户再也点不回来。
  //   标题栏是唯一「折叠前后都在」的位置。
  const sidebarCollapsed = useWorkspaceStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useWorkspaceStore((s) => s.toggleSidebar);

  // audit-r122:启动窗口(settings 未 hydrate)回退引 DEFAULT_SETTINGS.theme,
  // 不再写死 'system' —— 此刻画布就是暗色默认,旧回退文案与观感不符。
  // 原 satisfies union 防漂移职责由 DEFAULT_SETTINGS.theme 的强类型天然承担,
  // 且未来默认翻转时按钮自动跟随,无第二处手改。图标与 aria 共用同一变量,
  // 防两行各写各的回退再漂移。
  const effectiveTheme = theme ?? DEFAULT_SETTINGS.theme;

  const cycleTheme = async () => {
    // audit-r122-b:旧守卫 theme 为空即整函数早退,启动窗口点击静默 no-op,
    // 而回退文案已改 dark 后 aria 明写「点击切换」—— 承诺与行为不符。
    // 修 = 从 effectiveTheme 起轮转:main updateSettings 把 partial 以
    // {...base,...patch} 合并进内存全量对象(无 clobber),IPC 返回的全量
    // settings 经 store.update 落地,顺带提前完成 hydrate。
    // audit-r125:手抄 order 收 THEMES 单源(循环序 = types.ts tuple 行为契约)
    const next = THEMES[(THEMES.indexOf(effectiveTheme) + 1) % THEMES.length];
    // IPC reject(main crash / bridge 死)走 try/catch + log.warn,主题失败
    // 不弹 toast 打扰用户,只留 trace
    try {
      await updateSettings({ theme: next });
    } catch (err: unknown) {
      log.warn('cycleTheme updateSettings failed', err);
    }
  };

  // 同步 throw + async reject 都要兜 — fn() 同步读 api.windowXxx 是同步属性
  // 访问,bridge 未就绪 Proxy.get 返 undefined,undefined() 抛同步 TypeError,
  // .catch() 接不住(只接 promise reject),只有 try/catch 同时兜
  // 在 fireWindowControl 单点修比 4 处 onClick 各 typeof 一次更集中
  const fireWindowControl = (fn: () => Promise<unknown>, label: string): void => {
    try {
      fn().catch((err: unknown) => log.warn(`window control ${label} failed`, err));
    } catch (err: unknown) {
      log.warn(`window control ${label} sync throw`, err);
    }
  };

  const ThemeIcon =
    effectiveTheme === 'light' ? Sun : effectiveTheme === 'dark' ? Moon : Monitor;
  const themeTitle = t('titleBar.themeCycleAria', { theme: effectiveTheme });

  useEffect(() => {
    let cancelled = false;
    // hasApi() 统一收口(见 lib/api.ts),bridge 未就绪时 useEffect 提前 return
    // 不调 undefined 函数;bridge ready 后 React 重渲再跑 effect
    if (!hasApi('windowIsMaximized') || !hasApi('onWindowMaximizeChanged')) return;
    void api
      .windowIsMaximized()
      .then((r) => {
        if (!cancelled && r.ok) setMaximized(r.data);
        // audit-r91:ok:false 补 warn(r89 同款);!r.ok 收窄联合,等价原 else
        else if (!cancelled && !r.ok) log.warn('windowIsMaximized probe rejected', r.message);
      })
      .catch((err: unknown) => {
        // 启动 race / bridge 死的 reject 静默 — log 让可观察,不阻塞渲染
        log.warn('windowIsMaximized probe failed', errMsg(err));
      });
    const off = api.onWindowMaximizeChanged((m) => setMaximized(m));
    return () => {
      cancelled = true;
      // audit-r81:api.ts 头注契约 —— 事件订阅返回值可能是 undefined
      //   (测试 partial mock / 桥替换 race),cleanup 必须 typeof guard 才调,
      //   否则卸载即 "off is not a function" 抛进 React commit。
      //   useSyncStores 三处都是 `return off` 直返(undefined 合法),这里是
      //   全包唯一 arrow-wrap cleanup 调 off() 的站点 —— 唯一违例点。
      if (typeof off === 'function') off();
    };
  }, []);

  // 窗口三按钮永远在 Win/Linux 最右(关闭按钮在右下角的 Win 肌肉记忆)
  // 主题 + 设置插在拖拽区与窗口三按钮之间,不破坏原生 chrome 约定
  const appControls = (
    <>
      {/* r246:左栏折叠 / 展开开关 —— 从左上角品牌区旁**挪到右侧控件簇**
          (r242 时放在品牌区左侧,用户反馈「该按钮不应该在左上角」)。
          - 位置理由:左侧品牌区是「我是谁」(徽标 + 应用名),折叠开关是
            「操作」,混在一起会把品牌区变成工具条,视觉重心被拉偏;
            右侧本来就是操作区(主题 / 设置),折叠开关与它们同语义层。
          - 与 VS Code「切换主侧栏」同款位置约定(布局开关在标题栏右侧)。
          - 放在 appControls 首位(紧邻拖拽区),不与 Win 窗口三按钮混排 ——
            OS chrome(最小化/最大化/关闭)要保持贴右成组。
          - a11y:aria-pressed 表达「当前是否处于折叠态」(真 toggle button,
            标签保持稳定不变,避免「折叠左侧栏 / 展开左侧栏」两套文案让
            SR 用户每次都重新学习按钮含义)。
          - title 附快捷键提示(与设置按钮同款惯例,走 formatShortcut 平台化)。 */}
      <button
        type="button"
        onClick={toggleSidebar}
        aria-label={t('titleBar.toggleSidebar')}
        aria-pressed={sidebarCollapsed}
        title={`${t('titleBar.toggleSidebar')} (${formatShortcut('mod+B')})`}
        className="titlebar-btn"
      >
        <PanelLeft size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={cycleTheme}
        aria-label={themeTitle}
        title={themeTitle}
        className="titlebar-btn"
      >
        <ThemeIcon size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        // 设置入口走 uiModals — 不再走 CustomEvent bridge,任何地方直接
        // setSettingsOpen(true) 即可,App.tsx 订阅该字段决定 <SettingsPage>
        // 是否挂载
        // title 附快捷键提示(原生 tooltip 不破坏 chrome 视觉密度,icon-only
        // 加 <Kbd> 旁片会抢戏);平台原生符号(⌘ vs Ctrl)走 formatShortcut
        onClick={() => useUiModals.getState().setSettingsOpen(true)}
        aria-label={t('titleBar.openSettings')}
        title={`${t('titleBar.openSettings')} (${formatShortcut('mod+,')})`}
        className="titlebar-btn"
      >
        <Settings size={14} aria-hidden="true" />
      </button>
    </>
  );

  return (
    <div
      // 整条 bar 是拖拽区,内部按钮 no-drag 排除
      className="titlebar-drag h-titlebar flex items-center bg-bg-raised border-b border-border-subtle flex-shrink-0 select-none"
      // 双击拖拽区切换最大化(Win 习惯;Mac 系统自处理不重复)
      onDoubleClick={
        isMac
          ? undefined
          : () => fireWindowControl(() => api.windowMaximizeToggle(), 'maximizeToggle')
      }
      role="banner"
      aria-label={t('titleBar.appTitle')}
    >
      {/* 左:品牌区(Mac 让位给红绿灯) — 徽标 + 文字两段式形成主次。
          徽标 2026-10-18 起用项目根 icon.ico 真图(替换原 accent 渐变徽章盒 +
          BookOpen 字形),与窗口 / 任务栏 / 安装包图标同源;w-6 h-6 与徽章位
          尺寸一致,rounded 与窗口圆角 chrome 对齐。Mac 上仍让位红绿灯。 */}
      <div
        className={`flex items-center gap-2.5 px-3 ${isMac ? '' : 'min-w-[180px]'}`}
        style={isMac ? { paddingLeft: MAC_TRAFFIC_LIGHT_INSET } : undefined}
      >
        {/* audit-r135:width/height 属性让浏览器首帧按真实 24x24 占位,
            避免 ICO 内禀 256x256 首帧被 CSS 缩放产生 CLS(layout shift)。
            onError 兜底见上 imgError state 注。条件渲染 !imgError,失败后
            整块 <img> 不挂,不让 broken-image 占位框常驻。 */}
        {!imgError && (
          <img
            src={appIcon}
            alt=""
            aria-hidden="true"
            draggable={false}
            width={24}
            height={24}
            onError={() => {
              log.warn('brand icon failed to load, hiding', { src: appIcon });
              setImgError(true);
            }}
            className="w-6 h-6 rounded object-cover border border-accent/25 flex-shrink-0 select-none"
          />
        )}
        {/* span → h1:给 SR heading nav 真实顶级 heading;App.tsx 用
            aria-labelledby=app-title-h1 引用。text-fg + font-semibold +
            tracking-wider 让品牌锚点在 chrome 行「立」起来(原 fg-secondary
            在 dark theme 接近 fg/2 视觉上被水洗);契约锁 titlebar-contrast.test */}
        <h1
          id="app-title-h1"
          className="text-xs font-semibold text-fg tracking-wider truncate min-w-0"
        >
          {t('titleBar.appTitle')}
        </h1>
      </div>

      {/* 中:弹性留白 = 拖拽区 */}
      <div className="flex-1" />

      {/* 右:左栏折叠开关 + 主题 + 设置(跨平台) + 窗口三按钮(仅 Win/Linux)。
          Mac 应用控件贴拖拽区右沿无窗口三按钮(系统红绿灯接管);
          Win/Linux 顺序:左栏折叠 | 主题 | 设置 | 最小化 | 最大化 | 关闭 */}
      {isMac ? (
        <div className="flex items-center h-full">{appControls}</div>
      ) : (
        <div className="flex items-center h-full">
          {appControls}
          <button
            type="button"
            onClick={() => fireWindowControl(() => api.windowMinimize(), 'minimize')}
            aria-label={t('titleBar.minimize')}
            title={t('titleBar.minimize')}
            className="titlebar-btn"
          >
            <Minus size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => fireWindowControl(() => api.windowMaximizeToggle(), 'maximizeToggle')}
            aria-label={maximized ? t('titleBar.restore') : t('titleBar.maximize')}
            title={maximized ? t('titleBar.restore') : t('titleBar.maximize')}
            className="titlebar-btn"
          >
            {maximized ? (
              // Copy 双层方框(还原);Square 单个填满(最大化)
              <Copy size={13} aria-hidden="true" />
            ) : (
              <Square size={12} aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            onClick={() => fireWindowControl(() => api.windowClose(), 'close')}
            aria-label={t('titleBar.close')}
            title={t('titleBar.close')}
            // hover 变红 — Win 原生 chrome 视觉约定(用户肌肉记忆)。
            // hover:bg-accent 用主题色(暗紫蓝)与「危险操作」语义不符,
            // 用 Tailwind hover:bg-[#c42b1c] 定值,浅色主题也保持红
            className="titlebar-btn titlebar-btn-close"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
