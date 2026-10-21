// D2-020: 必须在 better-sqlite3 dlopen 之前执行,见 utils/path-check.ts
import './utils/path-check';
// 主进程入口
import { app, BrowserWindow, dialog } from 'electron';
import { createWindow } from './window';
import { registerRkmsSchemePrivileges, registerRkmsProtocolHandler } from './protocol';
import { installDocumentCspHeaders } from './document-csp';
import {
  startup,
  runBackgroundScansFireAndForget,
  notesService,
  literatureService,
  getFavoritesServiceSafe,
} from './startup';
import { getFavoritesService } from './workspace/favorites';
import { closeDB, startWalCheckpointTimer, stopWalCheckpointTimer } from './db/sqlite';
import { IPC, type ToastPushPayload } from '../shared/types';
import { registerMenuIPC, rebuildChromeForLang } from './ipc/menu';
import { createLogger } from './utils/logger';
import { broadcastToAllWindows } from './ipc/broadcast';
// audit C3R49 (2026-08-22):统一 4 处 uncaughtException / unhandledRejection / bootstrap
// catch / createWindow catch 的 `err instanceof Error ? \`${err.message}\n${err.stack}\` : String(err)`
// 重复片段,改用 errPayloadStr 保留 stack 的同时输出单字符串。
// audit C3R52 (2026-08-22):用 errPayload 给 log.error 3-arg 形式 (msg, message, stack) 也走安全提取;
// C3R49 只修了 \`${message}\n${stack}\` template literal 形态,漏了 uncaughtException 这种
// `(err) => log.error('uncaughtException', err.message, err.stack)` 形态 —— 若 runtime
// 抛非 Error 对象(throw 'string' / null),直接访问 .message/.stack 会得到 undefined,
// 日志丢真错。改用 errPayload(err) 后 `e.message` 始终是 string,与下方 unhandledRejection
// 同款的 "reason 是 unknown" 处理一致。
import { errPayload, errPayloadStr } from './utils/error';
// i18n:启动失败 / 窗口创建失败 dialog 标题走 t(),跟随 settings.language。
// safeLang 在 settings 未初始化时降级 zh-CN 不抛 INTERNAL —— 早期错误路径
// (bootstrap catch / startup catch / macOS activate)settings 状态不可知,
// 不能让 getSettings() 二次 throw 把真错盖掉。
import { safeLang, t, registerI18nForSafeWrite } from './i18n';
// r165 (2026-10-19):分层硬不变式补救 —— 把 safeLang() 注册进 safe-write
//   的 langProvider 槽,之后 safe-write 内部抛 AppError 走 tr() 解析就用
//   当前用户语言。顶层 import 后立即调一次,确保所有 IPC handler / service
//   触达 safe-write 时槽已注入(无运行期分支)。本 import 必须在 safe-write
//   的任意调用方 import 之前 —— 我们把它放在 main/index.ts 顶部 boot 段。
registerI18nForSafeWrite();
// audit r40 (2026-10-15):老 dev userData 一次性搬迁 —— 见 utils/migrate-old-userdata.ts
//   头部注释。顶部静态 import(而非 require)让 vitest 的 vi.mock 能拦截;helper
//   自身 import electron 不会触发额外副作用,仅函数体在调用时访问 app。
import { migrateOldDevUserData } from './utils/migrate-old-userdata';

// audit 2026-08-28: rkms:// 自定义协议的 scheme privileges 必须在
// app.whenReady() resolve 之前声明(registerSchemesAsPrivileged 只在
// isReady=false 时生效)。模块顶层、所有异步之前调用,保证比 whenReady.then() 早跑。
registerRkmsSchemePrivileges();

// audit r40 (2026-10-15):dev/packaged userData 路径统一 ——
//   package.json 同时含 name="research-knowledge-management-system" 与
//   productName="Literature Management" 两个字段:
//     - packaged 模式:electron-builder 把 productName 写进 metadata,
//       app.getName() = productName,userData = .../Literature Management/
//     - dev 模式:无 packaged metadata,app.getName() 回退到 name 字段,
//       userData = .../research-knowledge-management-system/
//   后果:同一台机器上 dev 与 packaged 模式 userData 路径不同,SQLite 索引 +
//   location.json 在两种模式下指向不同目录 → README 描述的是 packaged
//   路径,dev 用户路径与文档不符;且 dev/packaged 切换时数据漂移。修:在
//   whenReady 之前 setName 到 productName ——
//     - packaged 模式:同值覆盖,无副作用
//     - dev 模式:userData 切到 .../Literature Management/,与文档对齐
//   老 dev 用户的旧 userData 由 utils/migrate-old-userdata.ts 一次性处理
//   (location.json / settings.json / index/ 原子搬 + 删 source)。
//   setName 必须在 whenReady 之前调用(否则 userData 路径已被冻结);与上方
//   registerRkmsSchemePrivileges 同一窗口期。
// 老 appName **必须在 setName 之前获取** —— app.getName() 返回当前生效名,
//   setName 之后再调拿到的是 'Literature Management',oldUserData === newUserData,
//   helper 走 no-op 不会搬任何东西。先取再 set 是关键顺序,见 utils/migrate-old-
// userdata.ts:166-173 注释。
const _oldAppName = app.getName();
app.setName('Literature Management');

const log = createLogger('main');

// 改名史(r40 → 2026-10-21 本轮):userData 目录名历经两代 ——
//   1. research-knowledge-management-system(package.json name 字段,老 dev)
//   2. Research Knowledge Management(旧 productName,r40 后 dev+packaged)
// 本轮 productName 改为 Literature Management,两代老目录里的 location.json /
//   settings.json / index/ 都要能搬进新 userData,否则老用户配置丢失、SQLite
//   索引从零重建。_oldAppName 覆盖「本次启动前生效名」(老 packaged 是
//   'Research Knowledge Management',老 dev 是 name 字段),两个常量兜底另一代。
const _legacyAppNames: readonly string[] = [
  _oldAppName,
  'research-knowledge-management-system',
  'Research Knowledge Management',
];

// fire-and-forget:不阻塞 bootstrap。audit-r124:「helper 内部不抛错」的旧注释
//   不成立 —— migrateUserDataAppItems 对单步 fs 失败有 warnings 兜底,但
//   report 组装前的同步 throw(如 computeOldUserDataPath 异常)仍让 Promise
//   reject;裸 `void` 会撞上下方 unhandledRejection 全局网 → showFatalDialog
//   + app.quit(),启动期一次性搬迁小故障被升级成整应用闪退。补 catch 降级。
// 多个 legacy 目录**顺序**跑(不并发):两个 source 同时往同一 newUserData
//   搬同名 item 有竞争;helper 幂等,先到的赢,后到的按「新已存在」skip
//   + 清 stale source,顺序执行让该语义确定。
void (async () => {
  for (const legacyName of new Set(_legacyAppNames)) {
    await migrateOldDevUserData(legacyName);
  }
})().catch((err: unknown) => {
  log.warn('migrateOldDevUserData rejected, ignored', errPayloadStr(err));
});

// audit C3R71 (2026-08-22): 三处 error-path `setTimeout(() => app.quit(), 100)`
// verbatim 重复抽常量。100ms 给 dialog.showErrorBox / Electron 消息泵一帧时间
// flush 完后退出,而不是同步 quit 打断 dialog 渲染。
const QUIT_AFTER_ERROR_MS = 100;

// D2-019: 全局 last-line-of-defence,记录任何未捕获的同步异常/拒绝,
// 否则 IPC / chokidar / Promise 链中漏掉的错误会无声地让主进程僵死
// audit 2026-09-14:走 dialog + 退出 —— 之前只 log 不弹错,桌面应用没 telemetry
//   时用户面对"卡死的无响应窗口"完全无信号。uncaughtException 是同步路径,
//   dialog 渲染不出来可能再次抛 — try/catch 包一层 + 设 quitScheduled 标记
//   防重入弹错。日志保留(telemetry / 事后定位)。
let errorDialogShown = false;
function showFatalDialog(title: string, message: string): void {
  if (errorDialogShown) return;
  errorDialogShown = true;
  log.error(title, message);
  try {
    dialog.showErrorBox(title, message);
  } catch (dialogErr: unknown) {
    log.error('showErrorBox failed in fatal handler', errPayloadStr(dialogErr));
  }
  // 留 100ms 让 dialog 渲染 + Electron 消息泵 flush 一帧,然后退出
  setTimeout(() => app.quit(), QUIT_AFTER_ERROR_MS);
}
process.on('uncaughtException', (err) => {
  const e = errPayload(err);
  showFatalDialog(t('error.unhandledException', safeLang()), `${e.message}\n\n${e.stack ?? ''}`);
});
process.on('unhandledRejection', (reason) => {
  // reason 可能是 string / null / 非 Error 对象 —— errPayloadStr 统一 stringify
  showFatalDialog(t('error.unhandledRejection', safeLang()), errPayloadStr(reason));
});

async function bootstrap() {
  log.info('Bootstrap starting', { version: app.getVersion(), platform: process.platform });
  // audit 2026-08-28: rkms:// 协议 handler 必须在第一个 BrowserWindow 加载
  // URL 之前注册,否则 PDFReader / ImageReader 的 <iframe src="rkms://...">
  // / <img src="rkms://..."> 会撞 ERR_UNKNOWN_URL_SCHEME。放在 bootstrap
  // 顶端,startup() 之前 — createWindow 是首个 webContents 创建点。
  registerRkmsProtocolHandler();
  // audit r169 (2026-10-19):给**应用主文档**注入 CSP 响应头
  //   (frame-ancestors 'none')。meta CSP 里那条 directive 被 Chromium 忽略
  //   (只在响应头生效),是空操作 + 每次启动一条 error;这里补上真正生效的
  //   那份。必须在 createWindow 之前 —— 首个文档请求就要带上响应头。
  //   详见 src/main/document-csp.ts 头注(含实测结论)。
  installDocumentCspHeaders();
  try {
    await startup();
  } catch (err: unknown) {
    const msg = errPayloadStr(err);
    log.error('Startup failed:', msg);
    dialog.showErrorBox(t('error.startupFailed', safeLang()), msg);
    setTimeout(() => app.quit(), QUIT_AFTER_ERROR_MS);
    return;
  }
  try {
    await createWindow(safeLang()); // 窗口出
    // Phase 5: 挂应用菜单 — 必须在 createWindow 之后,菜单 IPC 才有 webContents 推
    // i18n:菜单 / window title 走 settings.language;切语言由 IPC.MENU_REBUILD 重建。
    rebuildChromeForLang();
    registerMenuIPC();
  } catch (err: unknown) {
    // D2-019: createWindow 之前没人接住错误,会让 whenReady 链 reject 成 unhandledRejection
    log.error('Create window failed:', errPayloadStr(err));
    dialog.showErrorBox(t('error.windowCreateFailed', safeLang()), errPayloadStr(err));
    setTimeout(() => app.quit(), QUIT_AFTER_ERROR_MS);
    return;
  }
  log.info('Window created');
  // 启动 favorites + notes service(createWindow 之后立刻起,避免历史
  // postStartup() 无人调导致 service 从不 start 的事故)。两者互不依赖,
  // 并发跑缩短 dark screen;任一失败 catch 后不阻断其他。
  const favoritesService = getFavoritesService();
  await Promise.allSettled([
    favoritesService.start().catch((err: unknown) => {
      // audit 2026-09-16 r21:H8 — 收藏 service 启动失败对称 notes 走 dialog,
      //   旧实现只 log 不弹,收藏分组为空 / markdown corrupt 时用户无信号。
      //   与 notesService.start 同款错误处理,UX 一致。
      log.error('Favorites service failed to start', errPayloadStr(err));
      try {
        dialog.showErrorBox(t('error.favoritesServiceFailed', safeLang()), errPayloadStr(err));
      } catch (dialogErr: unknown) {
        log.error('showErrorBox failed for favorites start', errPayloadStr(dialogErr));
      }
    }),
    notesService.start({ skipInitialLoad: true }).catch((err: unknown) => {
      // notesService.start 失败时除了 log,还弹 dialog 让用户知道笔记面板
      // 为什么是空的(参考 r6)。不 quit —— favorites / settings 仍可用。
      log.error('Notes service failed to start', errPayloadStr(err));
      try {
        dialog.showErrorBox(t('error.notesServiceFailed', safeLang()), errPayloadStr(err));
      } catch (dialogErr: unknown) {
        log.error('showErrorBox failed for notes start', errPayloadStr(dialogErr));
      }
    }),
    // audit-r136:literature service 同 notes 形态 —— skipInitialLoad 让
    //   bootstrap 顶层不阻塞(同步 reload 会等 initDB + readdir),真正
    //   disk↔DB diff 推到 runBackgroundScansFireAndForget 的 'literature'
    //   phase(那里已 await waitForDBInit 拿到 DB)。失败 dialog 镜像 notes:
    //   文献面板空白不阻断其它模块。
    literatureService.start({ skipInitialLoad: true }).catch((err: unknown) => {
      log.error('Literature service failed to start', errPayloadStr(err));
      try {
        dialog.showErrorBox(t('error.literatureWatcherFailed', safeLang()), errPayloadStr(err));
      } catch (dialogErr: unknown) {
        log.error('showErrorBox failed for literature start', errPayloadStr(dialogErr));
      }
    }),
  ]);
  // r7:service 内部 emit('watcher-failed') / 'reload-failed' 时推 toast 给 renderer。
  //   bridge 一个 helper 把 main side event → IPC.TOAST_PUSH channel。
  const watcherToast = (title: string, message: string): void => {
    // audit-r92:satisfies 挂单源 payload 型(同 startup.ts 迁移 toast)
    broadcastToAllWindows(IPC.TOAST_PUSH, {
      type: 'error',
      message: `${title}: ${message}`,
      duration: 8000,
    } satisfies ToastPushPayload);
  };
  notesService.on('watcher-failed', (err: unknown) => {
    watcherToast(t('error.notesWatcherFailed', safeLang()), errPayloadStr(err));
  });
  notesService.on('reload-failed', (err: unknown) => {
    watcherToast(t('error.notesReloadFailed', safeLang()), errPayloadStr(err));
  });
  // audit-r136:literature watcher / reload 失败 toast —— 复用上方 watcherToast
  //   helper(语义同 notes,主进程 → renderer 推 IPC.TOAST_PUSH)。
  literatureService.on('watcher-failed', (err: unknown) => {
    watcherToast(t('error.literatureWatcherFailed', safeLang()), errPayloadStr(err));
  });
  literatureService.on('reload-failed', (err: unknown) => {
    watcherToast(t('error.literatureReloadFailed', safeLang()), errPayloadStr(err));
  });
  // audit 2026-08-26 (round 16):周期性 WAL checkpoint —— 长跑 app 期间
  // -wal 文件无上限增长(默认 journal_size_limit = 0 → 4GB 上限)。
  // 每 30 分钟 TRUNCATE 一次,把 commit 数据合入主 db 并把 wal 截到 0 字节;
  // busy 时降级 PASSIVE。详见 sqlite.ts startWalCheckpointTimer。
  startWalCheckpointTimer();
  // perf(2026-08-24):走 broadcastToAllWindows 统一 helper,替代 inline BrowserWindow
  // 循环 —— helper 内部已包 try/catch send,关窗口竞态不致影响其它窗口。
  // audit 2026-08-28:三个 service 的 'changed' 推送载荷 {type:'changed'} 在渲染层
  // 全部被忽略(preload handler 签名都是 () => void),走无参载荷即可。
  // audit 2026-09-08:原注释提"trash / workspace helper 一致" —— trash 模块
  //   2026-08-27 下线,workspace.ts 推 favorites/workspace 改写也并入
  //   favoritesService。audit-r56 后只剩 favorites / notes 两处 'changed' 监听。
  // 重构 (2026-08-28):collectionsService 已删除 —— 收藏分组并入 favorites,
  // favorites 的 'changed' 推送就是 renderer 端的 onCollectionsChanged 触发源。
  // 注:favoritesService 已经在上方服务启动阶段拿到引用(line 124),复用即可,
  //   module-level 单例多次 getFavoritesService() 返同一实例。
  favoritesService.on('changed', () => {
    broadcastToAllWindows(IPC.FAVORITES_CHANGED);
  });
  notesService.on('changed', () => {
    broadcastToAllWindows(IPC.NOTES_CHANGED);
  });
  // audit-r136:literature 'changed' 广播 —— chokidar add/change/unlink →
  //   reload() → byId 重建 → emit('changed') → 推 LITERATURE_CHANGED 到所有
  //   未销毁 renderer。renderer useLiteratureStore._ensureInit 订阅 + 200ms
  //   self-write 抑制窗口(r136 M3 由 500 收紧;r221 对账:notes 域是
  //   500ms,两值刻意不同,原因见 store 文件内注释),自动
  //   load({ force: true }) 拉新列表(防自身写入触发二次 reload)。
  literatureService.on('changed', () => {
    broadcastToAllWindows(IPC.LITERATURE_CHANGED);
  });
  // 不 await:把扫描踢到后台跑,完成后通过上方 'changed' 监听自动刷新 renderer
  // (新版:同步向 startupProgress 推送 phase-start/progress/done 供 StartupOverlay 消费)
  runBackgroundScansFireAndForget();
}

app.whenReady().then(() => {
  // D2-019: 顶层加 .catch,防止 whenReady 回调里抛错被静默吞掉
  bootstrap().catch((err) => {
    const msg = errPayloadStr(err);
    log.error('bootstrap rejected:', msg);
    dialog.showErrorBox(t('error.startupFailed', safeLang()), msg);
    setTimeout(() => app.quit(), QUIT_AFTER_ERROR_MS);
  });
  app.on('activate', () => {
    // macOS:点击 dock 图标但所有窗口已关时,新建一个。createWindow 抛错
    //   (display 不可用 / renderer dir 校验失败)时不能让用户面对空白桌面
    //   无声卡住 —— dialog 弹错后返回,等用户再点。
    if (BrowserWindow.getAllWindows().length === 0) {
      try {
        createWindow(safeLang());
      } catch (err) {
        log.error('createWindow on activate failed', errPayloadStr(err));
        dialog.showErrorBox(t('error.windowCreateFailed', safeLang()), errPayloadStr(err));
      }
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let cleanedUp = false;
app.on('before-quit', (event) => {
  // audit C3R34 (2026-08-22):peer service 统一在 quit 时停 —— chokidar watcher、
  // reloadTimer、AtomicFile.writeQueue 不再 leak 到 process exit。
  // 顺序关键:先停 watcher(停止 emit 'change' → 停止触发 DB upsert /
  // collection/notes 写入),再 await 各 service 的 .stop()(等 in-flight
  // writeLock + writeQueue flush 完成),最后 closeDB() 触发 WAL checkpoint,
  // 避免 checkpoint 与 pending writes 竞争。
  // before-quit 默认同步 handler —— 直接 `void .stop()` + closeDB() 会让
  // process 在 writeQueue flush 完成前就 exit,AtomicFile 待写数据丢失。
  // 标准 Electron 模式:preventDefault → 异步清理 → cleanedUp 守卫重入 → app.quit() 二次触发。
  if (cleanedUp) return;
  event.preventDefault();
  cleanedUp = true;
  Promise.allSettled([
    notesService.stop(),
    // audit-r136:literature service stop —— 与 notes 同款,先停 watcher
    //   (停止 emit 'change' → 停止触发 DB upsert)再 await .stop()(等
    //   in-flight writeLock + watcher 异步 close 完成),最后 closeDB。
    //   literatureService.stop 内 writeLock.drain() 防止在途的 reload
    //   落到内存后被 byId.clear 抹掉。
    literatureService.stop(),
    getFavoritesServiceSafe()?.stop(),
  ]).finally(() => {
    // audit 2026-08-26 (round 16):先停 wal checkpoint timer 再 closeDB —
    // 关闭 db 之后 timer 触发会因 !db 守卫直接 return,但停掉省一次 setter 跳变。
    stopWalCheckpointTimer();
    // D1-015: 显式关闭 SQLite 触发 WAL checkpoint,
    // 避免 -wal / -shm 孤儿文件累积
    closeDB();
    app.quit();
  });
});
