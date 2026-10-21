import { BrowserWindow, shell } from 'electron';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from './utils/logger';
// audit C3R47 (2026-08-22):errMsg 替代 verbose 错误格式化
import { errMsg } from './utils/error';
import { broadcastMaximizeChanged } from './ipc/window';
// audit 2026-09-16 r21:lifecycle 监听通过 IPC.TOAST_PUSH 推给 renderer,
//   引入 broadcastToAllWindows + IPC channel(避免 inline require 兜底的脆弱性)。
import { broadcastToAllWindows } from './ipc/broadcast';
import {
  DEFAULT_WINDOW_WIDTH,
  DEFAULT_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
} from './window-defaults';
import { IPC, BOOT_CANVAS_HEX_DARK, type ToastPushPayload } from '../shared/types';
import { t, type Lang } from './i18n';
// audit round 9 (2026-09-15):整合 isPrivateHost → isPrivateIpLiteral(ssrf.ts):
//   原实现 40+ 行 IPv4/IPv6 字面判断,但漏掉 CGNAT 100.64.0.0/10(IPv4
//   parts[0]===100 没判断),IPv6 NAT64 / 6to4 也只是 startsWith 字符串前缀。
//   ssrf.ts:isPrivateIpLiteral 用 IPV4_PRIVATE_RANGES / IPV6_PRIVATE_RANGES
//   位掩码 + 128-bit BigInt,完整覆盖 RFC1918 / loopback / link-local / ULA /
//   CGNAT / multicast / NAT64 / 6to4 / IPv4-mapped。复用避免漂移。
import { isPrivateIpLiteral } from './utils/ssrf';
// audit round 10 (2026-09-15):H5 — 共享 isCaseInsensitiveFs 替代内联
//   `process.platform === 'win32' || process.platform === 'darwin'` 谓词,
//   与 safe-write.ts / fs-cache.ts 同源。
import { isCaseInsensitiveFs } from './utils/platform';

const log = createLogger('window');

// 允许交给系统浏览器打开的协议白名单
// 拒绝 file://, smb:, tel: 等可被渲染内容触发的危险协议
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:']);

// D2-018: shell.openExternal 的同源 SSRF 防御
// audit round 9 (2026-09-15):委托给 ssrf.ts —— 单一来源,不再维护第二份 IP 表。
//   注意:同步路径只检查 hostname 字面 IP,不解析 hostname(防 DNS rebinding
//   需要异步路径,留作 future;当前所有 setWindowOpenHandler 调用都是用户
//   点链接瞬间,fetch/connect 那一刻的 IP 不归此处管)。
function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  // 字面 IP 走 ssrf.ts 统一位掩码判断(覆盖 RFC1918 / CGNAT / IPv4-mapped /
  // NAT64 / 6to4 / link-local / ULA / multicast / loopback)
  if (isPrivateIpLiteral(host)) return true;
  // hostname 字面对常见本地名硬拦截
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  return false;
}

export function createWindow(lang: Lang): BrowserWindow {
  // 自定义无边框窗口 (2026-09):
  //   - Win/Linux:frame:false + titleBarStyle:'hidden' — 完全去掉原生 chrome,
  //     渲染层 TitleBar 组件接管所有窗口控件 + 拖拽区。
  //   - Mac:titleBarStyle:'hiddenInset' — 隐藏标题但保留左上角红绿灯(系统约定),
  //     我们的 TitleBar 在 Mac 上不渲染窗口控制按钮,只渲染品牌 + 拖拽区,
  //     左上角让出 80px 给红绿灯避免遮挡。
  //   - 菜单栏隐藏:autoHideMenuBar:Mac/Win 都生效,但 Linux(GNOME/KDE)行为不一
  //     —— 既然全平台都走自定义标题栏,直接 false 让原生菜单彻底消失。
  const isMac = process.platform === 'darwin';
  // 窗口 / 任务栏图标 (2026-10-18,audit-r135 加固,audit-r136 修订):
  //   统一用项目根 icon.ico,Windows 平台限定。
  //   - dev:__dirname = out/main/,'../../icon.ico' 指向项目根 → 任务栏不再
  //     是 Electron 默认图标;
  //   - packaged (audit-r136 改):根 icon.ico 已由 package.json build.files
  //     数组显式收录(__dirname=resources/app/out/main/,
  //     '../../icon.ico' → resources/app/icon.ico)→ existsSync 命中 →
  //     传 window icon。dev + packaged 视觉一致。
  //   - 若有人改 package.json 把 'icon.ico' 从 files 数组里删了:existsSync
  //     false → 不传 icon,Windows 回退到 build.win.icon 嵌进 EXE 的
  //     同一张图,任务栏仍正确 —— 这是「packaged 形态两路回退」保障。
  //   audit-r135:加 isWin 平台守卫 —— Electron 在 macOS 需 .icns / Linux
  //     需 .png,旧实现裸 existsSync(winIcon) 即 spread `icon: winIcon`,
  //     .ico 路径在 Mac/Linux 被 Electron 静默忽略,守卫给虚假安全感;
  //     现仅 Windows 平台尝试注入。Mac/Linux dev 模式任务栏 / Dock 用
  //     Electron 默认图标直到 build.mac.icon / build.linux.icon 资产就位
  //     (后续 round 补 .icns / .png)。
  //   M5 (audit-r136):__dirname 相对路径深度(2 级)与 electron-vite 默认
  //     main bundle 落点 out/main/index.js 锁死;若未来落点改(分包 / 拆
  //     进程)需同步调深。包成 ICON_RELATIVE_FROM_MAIN 常量便于集中维护。
  const ICON_RELATIVE_FROM_MAIN = '../../icon.ico';
  const isWin = process.platform === 'win32';
  const winIcon = isWin ? join(__dirname, ICON_RELATIVE_FROM_MAIN) : '';
  const win = new BrowserWindow({
    // 初始尺寸来自 window-defaults.ts(纯常量模块,可被单元测试直接断言)
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false,
    ...(isWin && existsSync(winIcon) ? { icon: winIcon } : {}),
    title: t('window.title', lang),
    autoHideMenuBar: true,
    frame: false,
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    // perf:首屏前 window 已显示纯黑底,等 React 挂上 globals.css 后才换主题底色,
    // 200-400ms 的"黑闪"被消除。色值与 globals.css :root.dark --bg-canvas-rgb
    // (7 8 10) + index.html #07080A 三处对齐,共享 @shared/types BOOT_CANVAS_HEX_DARK。
    backgroundColor: BOOT_CANVAS_HEX_DARK,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // D2-008: 启用 Chromium 渲染进程沙箱,作为 contextIsolation 之外的第二道防线;
      // preload 只用 contextBridge + ipcRenderer,不需要 Node 访问,沙箱兼容
      sandbox: true,
    },
  });

  // maximize-changed 推送(2026-09):自定义标题栏里的"最大化 / 还原"图标要跟随
  //   系统状态。系统级 maximize/unmaximize 由 Electron 触发,这里转发到渲染层。
  //   必须在 loadURL/loadFile 之前注册,避免 webContents 还没准备好就丢了首批事件。
  win.on('maximize', () => broadcastMaximizeChanged(win, true));
  win.on('unmaximize', () => broadcastMaximizeChanged(win, false));

  win.on('ready-to-show', () => win.show());

  // audit 2026-09-07:显式拒绝所有未列入 ALLOWED_PERMISSIONS 的 web permission 请求 —
  //   默认 Chromium 行为在不同版本差异很大(部分自动 grant / 部分 prompt),被注入
  //   内容(或上文的 file:// 导航漏洞被利用)后可能拿到 geolocation / notifications /
  //   media / midi / push 等敏感权限。限定到白名单,其余一律 deny。
  const ALLOWED_PERMISSIONS = new Set<string>([]);
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => {
    if (ALLOWED_PERMISSIONS.has(_permission)) {
      callback(true);
    } else {
      log.warn('Denied web permission request', _permission);
      callback(false);
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    // D2-009: 仅放行 http(s); 其它协议 (file:, tel:, 等) 拒绝交给系统
    try {
      const parsed = new URL(url);
      if (ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
        // D2-018: 同源检查也防 SSRF-amplification — 不允许指向 localhost / 私有 IP
        if (isPrivateHost(parsed.hostname)) {
          log.warn('Blocked external open to private host', parsed.hostname, url);
        } else {
          // openExternal 返回 Promise:xdg-open 缺失 / 无默认浏览器时会 reject。
          // 不接住的话用户点了链接毫无反应,日志里也查不到原因。
          shell.openExternal(url).catch((err: unknown) => {
            log.warn('openExternal failed', url, errMsg(err));
          });
        }
      } else {
        log.warn('Blocked external open for non-allowlisted protocol', parsed.protocol, url);
      }
    } catch {
      log.warn('Blocked external open for unparseable url', url);
    }
    return { action: 'deny' };
  });

  // D2-014: 阻止 renderer 顶帧导航到非应用 URL,避免被注入内容劫持整窗
  win.webContents.on('will-navigate', (e, url) => {
    // D2-018: 不再用 startsWith 字符串前缀 — `http://localhost:5173.attacker.tld/x`
    // 会骗过 startsWith。改成基于 origin 的精确比较
    const allowedOrigin = process.env.ELECTRON_RENDERER_URL ?? null;
    try {
      const parsed = new URL(url);
      if (allowedOrigin) {
        const allowed = new URL(allowedOrigin);
        // 仅允许相同 protocol + host + port
        if (
          parsed.protocol !== allowed.protocol ||
          parsed.hostname !== allowed.hostname ||
          parsed.port !== allowed.port
        ) {
          log.warn('Blocked in-window navigation to', url);
          e.preventDefault();
        }
      } else {
        // 生产 (audit 2026-09-07 HIGH):仅放行指向 renderer bundle 目录内的 file:// —
        //   原实现"protocol === 'file:'"放过了 file:///c:/users/secrets.txt 这类
        //   任意本地文件,被注入的 renderer / 笔记正文 / 受污染依赖
        //   `window.location = 'file:///'` 即可读盘。规范化为绝对路径,
        //   路径必须在 rendererIndexDir 前缀之下(同目录或子目录),否则拦。
        if (parsed.protocol !== 'file:') {
          log.warn('Blocked in-window navigation to non-file protocol', url);
          e.preventDefault();
          return;
        }
        // Windows 上 pathname 是 '/C:/...';Linux 是 '/home/...'.统一前缀比较
        // 需要 normalize — 用 fileURLToPath 而不是 path.resolve(parsed.pathname):
        //   path.resolve('/C:/foo') 在 Windows 上返回 'C:\C:\foo'(把 '/C:' 误读成
        //   不带盘符的绝对 POSIX 路径,再被前面解析成 cwd + 'C:/foo'),导致合法路径
        //   被误判成跨界。fileURLToPath 走 URL spec 解析,跨平台行为一致。
        const rendererDir = join(__dirname, '../renderer').replace(/\\/g, '/');
        const target = fileURLToPath(parsed).replace(/\\/g, '/');
        const rendererDirNorm = resolve(rendererDir).replace(/\\/g, '/');
        // audit 2026-09-14 r7:macOS (darwin) APFS 默认 case-insensitive,见
        //   safe-write.ts:resolveInsideDataPath 同款注释。Linux 不动。
        // audit round 10 (2026-09-15):H5 — 走共享 isCaseInsensitiveFs,
        //   与 safe-write.ts / fs-cache.ts 同源。
        const targetCmp = isCaseInsensitiveFs ? target.toLowerCase() : target;
        const dirCmp = isCaseInsensitiveFs ? rendererDirNorm.toLowerCase() : rendererDirNorm;
        // audit-r76 (2026-10-17):等值判定旧写作 `target !== dirCmp` —— raw 与
        //   lowercase 后的值比,大小写不敏感 FS 上恒 true(除非 target 恰好全
        //   小写),等值放行成死分支(裸目录 URL 误拦,fail-closed 仅可用性
        //   影响;安全方向不会 false-allow)。统一走 targetCmp 比较。
        if (targetCmp !== dirCmp && !targetCmp.startsWith(dirCmp + '/')) {
          log.warn('Blocked in-window navigation outside renderer dir', url, '→', targetCmp);
          e.preventDefault();
        }
      }
    } catch {
      log.warn('Blocked in-window navigation to unparseable url', url);
      e.preventDefault();
    }
  });

  // audit-r124:loadURL/loadFile 返回 Promise,旧实现裸调丢弃 → dev server
  //   down / 产物缺失时 rejection 撞上 index.ts 的 unhandledRejection 全局网
  //   = showFatalDialog + app.quit(),一次本可自愈的加载失败被升级成闪退。
  //   catch 只降级为日志;用户可见的重试/兜底仍由 did-fail-load 驱动。
  const load = process.env.ELECTRON_RENDERER_URL
    ? win.loadURL(process.env.ELECTRON_RENDERER_URL)
    : win.loadFile(join(__dirname, '../renderer/index.html'));
  void load.catch((err: unknown) => {
    log.error('renderer load rejected', errMsg(err));
  });

  // audit 2026-09-16 r21:H1+H2 — 补齐 renderer 进程生命周期监听。
  //   旧实现没 did-fail-load / render-process-gone / child-process-gone /
  //   crashed / unresponsive 任何一个 → dev server down / 构建产物丢失 /
  //   GPU 进程 OOM / 渲染进程被 kill 时只看到白屏 + show:false,无信号。
  //   修复:统一推到 IPC.TOAST_PUSH 让用户看到 + 必要时 win.reload() 自愈。
  //   broadcastToAllWindows 已包 try/catch send,关窗竞态不会反过来炸监听器。
  const lifecycleToast = (key: string, params?: Record<string, string | number>): void => {
    try {
      // audit-r92:satisfies 挂单源 payload 型(同 startup.ts 迁移 toast)
      broadcastToAllWindows(IPC.TOAST_PUSH, {
        type: 'error',
        message: t(key, lang, params),
        duration: 8000,
      } satisfies ToastPushPayload);
    } catch (notifyErr) {
      log.warn('renderer lifecycle toast dispatch failed', errMsg(notifyErr));
    }
  };

  // H1:did-fail-load — URL 加载失败(协议错误 / 404 / 渲染层 SPA 自身 throw)。
  //   win.show() 已在 ready-to-show 触发,即使失败也会 show 一次 → 兜底 reload()。
  // audit r28 (2026-09-21):retry cap —— 旧实现每次 fail 都 setTimeout reload,
  //   永久坏 bundle(asar hash 不匹配 / dev server 永久 down)会让 renderer
  //   在 did-fail-load → reload → did-fail-load 死循环,每轮 ~1s + 一条
  //   rendererLoadFailed toast,内存累积到 OOM-kill。修法:per-window
  //   attempts 闭包计数器,> 3 次 → 停掉 reload + 最后一条 toast 引导
  //   用户「重启 / 重装」。窗口重建(createMainWindow 再次调用)重置。
  let failLoadAttempts = 0;
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    // audit-r124:did-fail-load 对**任意框架**触发 —— PDF Reader / 图片预览
    //   这些 iframe 子资源 404 同样进本事件。旧实现不区分主框架,子资源失败
    //   会烧光主窗口重试预算并 win.reload() 把用户整个工作区掀掉(r119/r120
    //   后 rkms:// iframe 404 是常规态,杀伤面真实存在)。只处理主框架。
    if (!isMainFrame) return;
    log.warn('renderer did-fail-load', { code, desc, url });
    // audit-r124:ERR_ABORTED(-3)不 toast、不计数、不 reload —— reload()
    //   本身会 abort 在途导航,旧实现连 -3 都进重试环 → abort→reload→abort,
    //   预算被自家 reload 烧光后弹 rendererLoadFailedFinal 误导用户重启。
    //   r28 原注释「避开 obvious 开发期噪声(Abort / -3)以外都 reload」
    //   描述的是本意但从未落地,现在代码与注释对齐。
    if (code === -3) {
      log.info('did-fail-load ERR_ABORTED, skip (likely self-inflicted by reload)', { desc, url });
      return;
    }
    const MAX_FAIL_LOAD_ATTEMPTS = 3;
    if (failLoadAttempts >= MAX_FAIL_LOAD_ATTEMPTS) {
      log.error('renderer fail-load attempts exhausted, giving up', { code, desc, url });
      lifecycleToast('error.rendererLoadFailedFinal');
      return;
    }
    lifecycleToast('error.rendererLoadFailed');
    // 到这里只剩非 abort 的真失败(ERR_FAILED / ERR_FILE_NOT_FOUND / 网络类),
    //   统一 reload 兜底;abort 分支已在上方 return。
    if (!win.isDestroyed()) {
      failLoadAttempts += 1;
      setTimeout(() => {
        if (win.isDestroyed()) return;
        try {
          win.reload();
        } catch (reloadErr) {
          log.warn('renderer reload after did-fail-load threw', errMsg(reloadErr));
        }
      }, 1000);
    }
  });

  // H2/M2:render-process-gone — GPU 进程 OOM / killed → 用户看到黑/白窗。
  //   reason: 'crashed' | 'killed' | 'oom' 等。killed 在 Mac 上是用户 quit 后正常态,
  //   不需要 toast。crashed / oom 自动 reload + 提示。
  win.webContents.on('render-process-gone', (_e, details) => {
    log.error('render-process-gone', details);
    if (details.reason === 'killed') return;
    lifecycleToast('error.rendererGone', { reason: details.reason });
    if (!win.isDestroyed() && details.reason !== 'abnormal-exit') {
      setTimeout(() => {
        if (win.isDestroyed()) return;
        try {
          win.webContents.reload();
        } catch (reloadErr) {
          log.warn('reload after render-process-gone threw', errMsg(reloadErr));
        }
      }, 1000);
    }
  });

  // M2:crashed — render-process-gone 上面的低层版本,部分 Electron 版本同时触发。
  //   Electron 类型 def 未暴露 'crashed' 事件,走 (webContents as ...).on 兜底。
  (
    win.webContents as unknown as {
      on: (e: 'crashed', cb: (_e: unknown, killed: boolean) => void) => void;
    }
  ).on('crashed', (_e, killed) => {
    log.error('renderer crashed', { killed });
    if (killed) return;
    lifecycleToast('error.rendererCrashed');
  });

  // M2:unresponsive — 主线程卡顿超过阈值。BrowserWindow 默认不自动重启,
  //   给用户信号即可。
  win.on('unresponsive', () => {
    log.warn('window unresponsive');
    lifecycleToast('error.rendererUnresponsive');
  });

  // H2:child-process-gone — utility 进程 / sandbox 辅助进程意外退出。
  //   最常见是 sandbox renderer / GPU helper。提示用户即可,不强制 reload。
  (
    win.webContents as unknown as {
      on: (e: 'child-process-gone', cb: (_e: unknown, details: { reason: string }) => void) => void;
    }
  ).on('child-process-gone', (_e, details) => {
    log.warn('child-process-gone', details);
    lifecycleToast('error.childProcessGone', { reason: details.reason });
  });

  return win;
}
