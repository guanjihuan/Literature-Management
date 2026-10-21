// src/main/startup.ts
// 顶层启动编排:解析 dataPath、initSettings、layout 迁移、workspace 子目录 mkdir、
// fire-and-forget initDB(让 IPC 注册不被同步 30-80ms 阻塞)、注册 IPC。
// service.start(favorites / notes)由 index.ts 的 inline-bootstrap 接管。
import { promises as fs } from 'fs';
import { join } from 'path';
import { resolveDataPath } from './location';
import { setRootPath } from './utils/safe-write';
import { initSettings } from './settings/store';
import { initDB } from './db/sqlite';
import { registerAllIPC } from './ipc';
import { getNotesService, NotesService } from './notes/service';
import { waitForDBInit } from './db/sqlite';
import { getFavoritesService, FavoritesService } from './workspace/favorites';
// audit-r136:literature service 单例 —— 与 notes 同款 module-level single,
//   ipc/index.ts 注册 + index.ts 启动 + before-quit 停止 三处共用同一引用。
//   放在 startup.ts 顶层而不是另起一个 singleton barrel,是为了与 notes
//   路径对称(notesService / literatureService 在同一行 import 群),index.ts
//   已有 `import { notesService } from './startup'` 形态,加同款 import 0 开销。
import { getLiteratureService, LiteratureService } from './literature/literature-service';
import { migrateDataLayoutV2 } from './settings/migration-layout';
import { createLogger } from './utils/logger';
import { errMsg, errPayload } from './utils/error';
import { startupProgress } from './startup-progress';
import { broadcastToAllWindows } from './ipc/broadcast';
import { IPC, WORKSPACE_DATA_LAYOUT } from '../shared/types';
import type { StartupPhase, ToastPushPayload } from '../shared/types';

const log = createLogger('startup');

// 模块级单例:供 ipc/index.ts 在注册 handler 时使用,以及 index.ts 监听 'changed' 事件。
export const notesService: NotesService = getNotesService();
// audit-r136:literature service 单例 —— 同 notes 形态(懒加载 + module-level memoize)。
//   index.ts 的 inline-bootstrap 走 `literatureService.start({ skipInitialLoad: true })`,
//   notes-resync phase 内 `literatureService.load()` 主动触发 disk↔DB diff(因为
//   start 时跳了 initial load,这里补回)。
export const literatureService: LiteratureService = getLiteratureService();

// Safe getter — 直接走 workspace/favorites.ts 的 memoize 单例,与 index.ts 启动时
// 拿到的引用一致,before-quit 的 `?.stop()` 能真正排空启动时建立的写队列。
// 返回 `| null` 是 Promise.allSettled 的链式契约占位(getFavoritesService() 自身
// lazy memoize,首调即填,不会真返 null)。
export function getFavoritesServiceSafe(): FavoritesService | null {
  return getFavoritesService();
}

// audit 2026-09-14 r7:async mkdir —— 原来 sync mkdirSync 阻塞事件循环 5-30ms;
//   改成 fs.promises.mkdir 后 syscall 走 libuv 线程池,主进程不 stall。
async function ensureDirAsync(p: string): Promise<void> {
  try {
    await fs.mkdir(p, { recursive: true });
  } catch (err: unknown) {
    log.error('Failed to create dir', p, errPayload(err).message);
    throw err;
  }
}

// perf(2026-09-14):预创建 workspace 子目录 —— NotesService.start / FavoritesService
//   .start 都会 mkdir,但全部塞进 service 启动阶段会变成串行 IO(尤其是首次启动
//   全新 dataPath 时,每个 mkdir 都触发 syscall)。这里在 startup() 顶层与
//   initSettings 并发跑一次,后续 service 启动路径走 cache (mkdir recursive 见到
//   已存在目录立即 return)。也能让全新用户首次创建笔记时 parent 一定存在。
// audit 2026-09-14 r7:并发跑两个 mkdir —— 之前 for 循环串行,每个 5-30ms,
//   改成 Promise.all 并发可省一份 mkdir 延迟。
async function ensureWorkspaceDirs(dataPath: string): Promise<void> {
  // audit:FAVORITES_DIR = 'workspace/favorites'(带子路径),直接 join 避免再嵌一层 workspace/
  // audit-r136:literature 目录预创建 —— 与 notes 对齐;LiteratureService.start
  //   内部也有 mkdir 兜底(防 service 跑在 startup 之前),此处是 startup 顶部
  //   主动建好让后续 import / chokidar watch / reload 走 cache(idempotent)。
  //   全新 dataPath + 用户首次启动场景:这里 mkdir 后,startup 完成的
  //   literature 目录就绪,chokidar 监听 + reload 都不再 5-30ms 同步阻塞。
  const dirs = [
    join(dataPath, WORKSPACE_DATA_LAYOUT.NOTES_DIR),
    join(dataPath, WORKSPACE_DATA_LAYOUT.FAVORITES_DIR),
    join(dataPath, WORKSPACE_DATA_LAYOUT.LITERATURE_DIR),
  ];
  await Promise.all(dirs.map((d) => ensureDirAsync(d)));
}

/**
 * 把一段异步工作包成 "startPhase -> fn -> endPhase(ok|err)"。
 * 让 renderer 端的 StartupOverlay 真正能反映主进程扫描进度,
 * 而不是依赖 30s 的 forceFinish 兜底超时。
 *
 * perf:startPhase/endPhase 内部已经 try/catch,这里只关心 fn 自身的成败。
 */
async function trackPhase<T>(phase: StartupPhase, fn: () => Promise<T>): Promise<T> {
  startupProgress.startPhase(phase);
  try {
    const r = await fn();
    startupProgress.endPhase(phase, true);
    return r;
  } catch (err: unknown) {
    startupProgress.endPhase(phase, false, errPayload(err).message);
    throw err;
  }
}

export async function startup(): Promise<void> {
  const { path: dataPath } = await resolveDataPath();
  log.info('Data path resolved', dataPath);
  setRootPath(dataPath);
  // perf(2026-09-14):resolveDataPath() 已经在所有 5 处分支成功 mkdir 真实
  //   dataPath(location.ts:86/155/205/212/218),dataPath 此时已就绪。
  //   原 ensureDir(dataPath) 是 sync mkdirSync,阻塞事件循环 5-30ms(Win + AV),
  //   且 syscall 永远命中已存在目录。删掉这条 sync IO 让 startup() 顶层
  //   不再阻塞主进程。
  // audit r33 (2026-09-23):HIGH (r32 回归数据丢失)—— 旧 r32 fix 把
  //   `ensureWorkspaceDirs` 与 `migrateDataLayoutV2` 串行化,但序向错了:
  //   ensureWorkspaceDirs 先跑会创建 `<dataPath>/notes/` 与 `<dataPath>/workspace/`
  //   空的两个目录,migration 紧接着看到 `new path exists` 直接走
  //   `migration-layout.ts:141-160` 的「目标已存在 → rm 老」分支,把 v3 升级用户的
  //   `<dataPath>/data/notes/`(真实笔记位置)整棵 rm -rf,首启必丢笔记。
  // 修法:**order 反转** —— initSettings + migrateDataLayoutV2 先跑完(让
  //   migration 的「newPath 不存在 → rename 老→新」分支正常走),再
  //   ensureWorkspaceDirs 给新位置 idempotent mkdir `notes/` + `workspace/favorites/`
  //   兜底。三种用户都安全:
  //   - v3 升级:newPath 不存在 → rename 老目录进新位置(真 move,数据保留);
  //   - 已迁移用户:migration 在 `oldPath` ENOENT 处早 return,ensure 后
  //     mkdir 命中已存在(no-op);
  //   - 全新用户:oldPath 不存在,newPath 不存在 → migration 跳过,ensure
  //     mkdir 两个目录。
  await (async () => {
    await initSettings(dataPath);
    // Layout v2 迁移:把 dataPath/{notes, workspace} 顶层目录
    //   整体搬到 dataPath/data/ 下(原子 rename)。幂等:已迁移用户无副作用。
    // audit 2026-09 (V1.6):头注原写 "notes, sidecars, ai, collections, workspace"
    //    整体搬 —— 但 sidecars / ai / collections 三个目录 2026-08-28 整体下线
    //    (collections 合并进 favorites,sidecars 合并进 notes-lit,ai 合并进
    //    notes-ai),物理搬走在 V3 migration 里做(已下线)。当前 V2 只搬
    //    notes / workspace 两个仍在使用的顶层目录(见
    //    settings/migration-layout.ts OLD_LAYOUT_DIRS)。
    // 重构 (2026-09):V3 内容合并 + JSON→MD 迁移已下线 —— recent/trash 模块
    //   删除后这两个迁移失去意义(migration.ts 整体移除)。
    // audit 2026-09-14 r7:migration 失败也 swallow —— 失败是 warn 级,用户
    //   看不到 layout 迁移不会丢笔记(目标位置已可用);但要给 renderer 推 toast
    //   让用户知道 data layout 可能不完整。改:把 warnings 装入 result 返回。
    try {
      const migrationResult = await migrateDataLayoutV2(dataPath);
      if (migrationResult.warnings.length > 0) {
        // 给 renderer 推 toast 让用户知道部分迁移失败
        for (const w of migrationResult.warnings) {
          // audit-r92:satisfies 挂 ToastPushPayload 单源 —— 发送字面与 preload
          //   白名单同源 tuple 漂移时 TS 编译期报红(旧 payload 是裸对象无质料)
          broadcastToAllWindows(IPC.TOAST_PUSH, {
            type: 'warning',
            message: `Layout migration: ${w}`,
            duration: 8000,
          } satisfies ToastPushPayload);
        }
      }
    } catch (err: unknown) {
      log.warn('migrateDataLayoutV2 threw (continuing)', errMsg(err));
    }
  })();
  // audit r33 (2026-09-23):HIGH —— 见上方 schema 注释,migrateDataLayoutV2
  //   之后跑确保新位置(`notes/` + `workspace/favorites/`)一定就位。
  //   老 v3 用户的 `data/notes` 已经重命名为顶层 `notes`,这条 mkdir 命中已
  //   存在目录(no-op);已迁移用户也无操作。失败 swallow:service.start 内
  //   部还有 mkdir 兜底,启动期全部 fail 不应让 app 死。
  await ensureWorkspaceDirs(dataPath).catch((err: unknown) => {
    log.warn('ensureWorkspaceDirs failed (service.start will retry)', errMsg(err));
  });
  // perf(2026-08-24):DB init 内部全同步(better-sqlite3 new Database + pragmas +
  // quick_check + migrations)—— 大库(5000+ 文件)首次打开 + quick_check 可吃掉
  // 30-80ms 事件循环。包一层 Promise.resolve().then 把同步执行推到下一个 microtask,
  // 让 ensureDir + settings + migration 的 IO 完成回调能优先 flush。
  // 与 registerAllIPC 并发:任一先完成都行,IPC handler 在 createWindow 前注册即可,
  // 而 createWindow 在 index.ts bootstrap 链路后才发生,有充足时间窗口。
  // audit 2026-08-25:原 `void Promise.resolve().then(...)` 把 initDB 的 throw 推出
  // startup() 的 await 边界,变成 unhandledRejection —— bootstrap() 抓不到错误,
  // 用户看不到 dialog.showErrorBox,而是 broken DB + silent startup failure。
  // 修:fire-and-forget + .catch 调 bootstrap 路径(通过 dialog.showErrorBox),
  // 同时保留 microtask defer 让 IPC 注册不被 initDB 的 30-80ms 阻塞。
  // audit 2026-08-28:删 `initDBPromise` 变量 + `waitForDBInit` export —— 全
  // src + tests 无任何 caller,只用来 throw 给 unhandledRejection 监听。Promise
  // 表达式直接丢弃也没问题,.catch 自身就会让 throw 走到 unhandledRejection。
  // audit 2026-09-07:弹 dialog 让用户看到 —— 之前 unhandledRejection 仅写
  //   renderer/main log,桌面应用里用户看不见。dialog.showErrorBox 是 Electron
  //   同步 API,启动期可用(主窗口还没创建)。失败信息走 tr() 走用户语种。
  Promise.resolve()
    .then(() => initDB(dataPath))
    .catch((err: unknown) => {
      const e = errPayload(err);
      log.error('DB init failed in background', e.message, e.stack);
      // dialog 在 BrowserWindow 创建前可调 —— 直接弹原生对话框。
      // 静态 import 在主进程同步路径下 OK,不像 renderer 受 bundle 影响。
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { dialog } = require('electron');
        dialog.showErrorBox(
          'Database initialization failed',
          `${e.message}\n\nThe app cannot start without a working database. Please check disk permissions / disk space and restart.`,
        );
      } catch (dialogErr: unknown) {
        log.error('dialog.showErrorBox failed', errMsg(dialogErr));
      }
    });
  registerAllIPC();
}

/**
 * 后台执行所有重型磁盘扫描。**不**被调用方 await —— 调用者应当在
 * 窗口创建之后才调用,以避免黑屏等待。失败互不影响,trackPhase 包裹每个
 * phase 让 StartupOverlay 实时反映。
 */
export function runBackgroundScansFireAndForget(): void {
  void (async () => {
    log.info('Background scans started');
    // audit 2026-09-10:等 initDB 完成 —— startup() 内部把 initDB 包到
    //   Promise.resolve().then(...) 后 fire-and-forget 启动(让 IPC 注册不被
    //   30-80ms 同步执行阻塞),但 runBackgroundScansFireAndForget 紧接着就
    //   调 notesService.load —— requireTx() / getDB() 在 initDB 没完成时直接
    //   抛 "DB tx not initialized",整个 background scan 崩。waitForDBInit()
    //   在 db 就绪前 await,完成后立即 resolve(已是 done 状态下等于一次
    //   microtask,几乎 0 开销)。
    await waitForDBInit();
    await trackPhase('notes', () => notesService.load()).then(
      () => log.info('Notes scan complete'),
      (err) => log.warn('Notes scan failed', errPayload(err).message),
    );
    // audit r50 (2026-10-15) M6:notes load 后跑 disk ↔ DB 差集(独立 phase,
    //   失败不让 startup 退场卡住,log warn 留 trace 即可)。
    //   audit-r124:resyncIfNeeded 改为就地删除 db-only 行,本处 dbOnlyIds 只是
    //   「本轮已清理行」的观测快照。
    //   audit-r156:旧「写 settings.notesResyncPending 让 renderer modal 决定」
    //   链路一并删除,见 schema/types 删除注释。
    await trackPhase('notes-resync', () => notesService.resyncIfNeeded()).then(
      (r) => {
        if (r.dbOnlyIds.length > 0) {
          log.info('Notes resync: db-only ghost rows dropped', r.dbOnlyIds.length);
        }
        if (r.inserted > 0) log.info('Notes resync: disk-only inserted', r.inserted);
      },
      (err) => log.warn('Notes resync failed', errPayload(err).message),
    );
    // audit-r136:literature phase —— 在 notes-resync 之后、finalizing 之前
    //   排一个独立 phase。LiteratureService.start 阶段用了 skipInitialLoad: true
    //   (与 notes 同款:让 bootstrap 的 allSettled 不被同步 reload 阻塞),这里
    //   显式 load() 触发 disk↔DB diff(读 litDir → upsert disk-only filename
    //   rows + 删 ghost rows),byId 完成首次快照填充。失败 warn,不让 startup
    //   退场卡住(同 notes-resync 兜底语义)。
    await trackPhase('literature', () => literatureService.load()).then(
      () => log.info('Literature scan complete'),
      (err) => log.warn('Literature scan failed', errPayload(err).message),
    );
    // finalizing 阶段:scan 完成到 overlay 退场之间的小尾巴 ——
    // 把这段时间声明成 explicit phase,让 UI 显示"正在整理索引"的最后过渡
    // 而不是直接闪现主界面(突兀)。空操作即可,只是占个 phase 信号位。
    startupProgress.startPhase('finalizing');
    startupProgress.endPhase('finalizing', true);
    // 关键:推送 all-done 让 renderer 端 StartupOverlay 立刻收尾
    startupProgress.finish();
  })().catch((err: unknown) => {
    // D2-019: 外层 IIFE 自身的同步抛错或顶链 reject(emit 'changed' 等),不能让进程僵死
    const e = errPayload(err);
    log.error('runBackgroundScans outer failure', e.message, e.stack);
    // 即便中间有意外,也保证 overlay 能收尾,不能让用户卡 30s
    startupProgress.finish();
  });
}
