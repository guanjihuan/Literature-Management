// src/main/settings/migration.ts
//
// audit-r56:library service / library-migration 整体下线 —— switchDataPath
//   不再 restart library watcher / scanAndIndex。这里只保留「切换数据目录 +
//   reinit DB + rollback」的核心路径,被 `settings:migrate-data` 与
//   `settings:restore-default-data` 两条 IPC 复用,供用户把工作目录迁到新盘。
//
// 不变式:
//   1. teardown 顺序:closeDB → 写新 location → initSettings(newPath) →
//      initDB(newPath);任意中间抛错必须把 DB 回滚到 currentPath,避免
//      「location 指向 A、运行时却是 B」的分裂态
//   2. 同 newPath 直接 no-op,不写 location,不动 DB
//   3. drive-root (例如 `C:\`) 拒绝,不够区分父目录
import { promises as fs, type Dirent } from 'fs';
import path from 'path';
import { changeDataPath, resetSettings, captureSettingsSnapshot } from './store';
import { setRootPath, getRootPath } from '../utils/safe-write';
import { initSettings } from './store';
import { closeDB, initDB } from '../db/sqlite';
import { defaultDataPath, writeLocation } from '../location';
import { createLogger } from '../utils/logger';
import { AppError, errnoCode, errMsg } from '../utils/error';
import { isSameDir } from '../utils/path-compare';
import { getNotesService } from '../notes/service';
import { getFavoritesService } from '../workspace/favorites';
// audit-r204:换根后文献 id 必须重算 —— 文献 id = 'lit:'+toPosix(absPath),
//   强绑定绝对路径;而 changeDataPath 是**复制**(旧目录还在)+ SQLite 库在
//   userData(全局,不在数据根下)⇒ 切换后旧行全部存活 ⇒ 文献列表里每个 PDF
//   出现两次、搜索结果重复、★ 挂在旧副本上。详见 root-remap.ts 头注。
import { remapLiteratureIdsForRootSwitch, relUnderRoot } from './root-remap';
// audit-r160:literature service 也需 rootPath 重绑 —— 旧实现漏掉导致切库后
//   literature watcher 仍听旧目录 + byId 仍是旧目录扫描结果。
import { getLiteratureService } from '../literature/literature-service';

const log = createLogger('settings-migration');

export async function switchDataPath(newPath: string): Promise<void> {
  const currentPath = getRootPath();
  log.info('Switching data path', currentPath, '->', newPath);

  // ---- D2-001: Validate newPath before any mutation ----
  if (!newPath || typeof newPath !== 'string') {
    throw new AppError('INVALID_INPUT', 'newPath must be a non-empty string');
  }
  if (!path.isAbsolute(newPath)) {
    throw new AppError('INVALID_INPUT', 'newPath must be an absolute path');
  }
  if (newPath === currentPath) {
    log.info('newPath equals currentPath, no-op');
    return;
  }
  if (path.parse(newPath).root === newPath) {
    throw new AppError('INVALID_INPUT', 'newPath cannot be a drive root');
  }

  // audit-r56:不再 stopWatching —— library service 已下线。
  // audit-r80 更正:原注释「notes + favorites 无 chokidar watcher,无需停」
  //   是错误前提 —— notes 有 watcher,favorites 无 watcher 但有 start() 时
  //   一次性绑定的 AtomicFile 写路径。两者的重绑在下方 initDB 成功后做
  //   (stop/start 幂等全卸全装),这里 teardown 阶段不动它们:此刻还没
  //   提交新路径,服务必须继续服务旧目录直到切换不可逆。
  await changeDataPath(newPath, currentPath);
  // audit 2026-10-08 (LOW):closeDB() 同步,无需 await —— 仅加注释防后续
  //   contributor 误以为漏 await。closeDB 内部 db.close() / stmtCache.clear()
  //   / txHolder.current = null / stopWalCheckpointTimer() 全部同步,
  //   不返回 Promise。原 audit 标注 "not awaited" 是误读(把 fire-and-forget
  //   习惯性套在这里),实际不构成 race。
  closeDB();

  // audit 2026-10-01:MEDIUM — 补齐 teardown 之后的回滚缺口。
  //
  //   到这里为止已经发生了两件**不可逆**的事:DB 关了。下面原先的
  //   `await writeLocation(newPath)` 位于 try 之外(try 从 initSettings 那行
  //   才开始),它一旦抛错(atomic 写重试耗尽 / userData 只读 / OneDrive
  //   占用),异常直接上抛给 IPC 层,于是本会话进入这个状态:
  //     - DB 永远是关闭的 → 所有 requireTx() 抛 "DB tx not initialized"
  //     - location.json 可能已指向 newPath,而 settings 仍指向 currentPath
  //   用户表现:「切换数据目录失败」之后整个应用半死不活,必须重启。
  //
  //   修法与下面 initDB 失败路径对称:teardown 之后、进入可回滚区之前的任何
  //   失败,都要把 DB 恢复回去再抛。
  const restoreRuntime = (): void => {
    try {
      initDB(currentPath);
    } catch (reopenErr: unknown) {
      log.error('restore initDB(currentPath) failed after teardown', errMsg(reopenErr));
    }
  };

  // ---- V1.9 (audit round 21): writeLocation BEFORE initDB ----
  // 注:changeDataPath 内已写一次 location.json(newPath);这里再写一次是
  //   幂等保险 —— 即便 changeDataPath 未来重构去掉写 location 这一步,
  //   switchDataPath 仍然能在 initDB 失败时把 location.json 滚回 currentPath。
  try {
    await writeLocation(newPath);
  } catch (locErr: unknown) {
    log.error('writeLocation(newPath) failed after teardown, restoring runtime', errMsg(locErr));
    // audit 2026-10-04:把 location.json 一起滚回 currentPath。
    //
    // 这里原本只 restoreRuntime()(重开 DB)就抛。但 changeDataPath 在
    // **调用本函数之前**已经成功写过一次 location.json = newPath(store.ts 的
    // writeLocation(newPath));本行那次是幂等保险,它失败说明 userData 此刻
    // 不可写 —— 很可能**第一次也只写了一部分或根本没生效**,而我们无从确认。
    //
    // 不回滚的后果是「location 指向 newPath、运行时却是 currentPath」的
    // 分裂状态:本次会话之后对 currentPath 的所有写入成为孤儿(下次启动从
    // newPath 读,拿到的是切换那一刻的旧副本),会话期的编辑静默消失。
    //
    // 下面 initDB 失败分支(:107)本来就有 writeLocation(currentPath),这里
    // 是同一个不变量的另一半 —— 之前只覆盖了主路径,漏了这一行相邻的同类
    // 失败点。回滚本身失败只 log,不掩盖原始的 locErr(与 :107-109 同款处置)。
    try {
      await writeLocation(currentPath);
    } catch (rollbackLocErr: unknown) {
      log.error('Rollback writeLocation(currentPath) failed', errMsg(rollbackLocErr));
    }
    restoreRuntime();
    throw locErr;
  }

  // ---- D1-011: Rollback DB state if init fails ----
  // audit round 18 (2026-08-27):initDB(currentPath) 自己抛错(损坏的旧 DB /
  // 权限被剥)会掩盖原始的 initSettings(newPath) 错,用户无从知道迁移失败是因为
  // 新路径问题还是回滚本身。把 rollback 也包到 try/catch,失败时把两条错误都
  // 包到一个 AppError 里抛出去,UI 能完整看到"为什么迁移失败 + 为什么回滚也失败"。
  // audit 2026-09-10:rollback 还要 reset settings —— initSettings(newPath) 会把
  //   module-level currentSettings / settingsPath 指向 newPath;若 initSettings
  //   抛错前已经把 currentSettings 覆盖了,rollback 只滚 location + DB 仍会让
  //   后续 getSettings() 返回 newPath 数据,saveSettings() 写到新路径,UI
  //   与磁盘出现"location 指向 A 但 settings 实指 B" 的不可观测漂移。
  //   capturePrevSettings 在 initSettings(newPath) 之前抓快照;resetSettings
  //   在 catch 里恢复(只在 initSettings 真的改了 currentSettings 时安全)。
  const prevSettings = captureSettingsSnapshot();
  setRootPath(newPath);
  try {
    await initSettings(newPath);
    initDB(newPath);
  } catch (err) {
    log.error('Failed to init at new path, rolling back DB', err);
    setRootPath(currentPath);
    resetSettings(prevSettings);
    try {
      await writeLocation(currentPath);
    } catch (rollbackLocErr) {
      log.error('Rollback writeLocation(currentPath) failed', rollbackLocErr);
      // 继续尝试回滚 DB —— location.json 写失败不阻塞 DB 回滚路径
    }
    try {
      initDB(currentPath); // reopen old DB
    } catch (rollbackErr) {
      log.error('Rollback initDB(currentPath) also failed', rollbackErr);
      throw new AppError(
        'MIGRATION_ROLLBACK_FAILED',
        `Migration failed AND rollback to previous data path failed. ` +
          `Original error: ${errMsg(err)}. ` +
          `Rollback error: ${errMsg(rollbackErr)}. ` +
          `App may be in an inconsistent state — restart recommended.`,
        err,
      );
    }
    // audit 2026-09-10:rollback 之后清理 newPath —— changeDataPath 已经把整
    //   个旧 data 目录复制到 newPath,initDB(newPath) 失败时虽然 location /
    //   settings / DB 都滚回 currentPath,但 newPath 这个孤儿目录还在磁盘上
    //   占用空间(典型 50GB research library 场景下变成永久空间泄漏)。
    //   rm 失败不阻塞 throw err —— 失败也只是留个孤儿目录,不影响功能。
    await fs.rm(newPath, { recursive: true, force: true }).catch((rmErr: unknown) => {
      log.warn('Rollback fs.rm(newPath) failed (orphan directory may remain)', errMsg(rmErr));
    });
    throw err;
  }

  // audit-r204:切换 = **整库搬移** ⇒ 文献 id 必须重算成新根下的形态。
  //
  //   放在 initDB 之后(要写库)、服务重绑之前(重绑后的 reload 会重扫新根;
  //   若此刻还没改 id,重扫会把新根的文件当成 disk-only 再插一行 ⇒ 重复)。
  //   单行失败由 root-remap 内部逐行 catch + log(不阻断切换本身:location /
  //   settings / DB 已经提交,此时抛错只会让「切换失败」的提示与实际状态矛盾)。
  const idRemap = remapLiteratureIdsForRootSwitch(currentPath, newPath);

  // audit-r56:不再 startWatching + scanAndIndex —— library 没了,这两个调用
  //   是把 library watcher 接到新 libraryPath,并扫描索引。这条路径在 V1.7
  //   之前负责「切换数据目录后让用户立即看到新数据」,现在列表数据
  //   (notes / literature)直接走 SQLite,FTS 走 startup 一次性 build,
  //   切换时无需主动 scan —— 启动期已经一次性 build 完。
  //   (audit-r73:原注释写「LibraryList 的数据」,该组件 r71 已删,措辞更正)

  // audit-r80 (2026-10-17) HIGH:重绑随 rootPath 一次性绑定的两个服务。
  //   旧实现切换成功后什么都不做,于是:
  //   - FavoritesService 的 AtomicFile 仍写**旧目录**的 favorites.md ——
  //     本会话的收藏变更全部落到旧副本,重启后(从新目录加载)静默丢失;
  //   - NotesService 的 chokidar watcher 仍听旧目录 —— 新目录的外部增删
  //     改不触发 reload(UI 不刷新),旧目录改动反而触发无意义全量重扫;
  //   - NotesService.byId 内存索引仍是旧目录扫描结果。
  //   stop() 对两者都是幂等全卸(排写队列/关 watcher/清索引),start()
  //   重新 join(getRootPath(), …) 绑定新目录。放在 initDB 成功之后:
  //   此前的 rollback 路径(currentPath 恢复)不需要也不许动服务。
  //   重绑失败不回滚切换 —— location/settings/DB 已提交 newPath,服务
  //   降级(收藏暂空/监听暂缺)比分裂态更可取,记 error 让排查有迹。
  try {
    const notes = getNotesService();
    await notes.stop();
    await notes.start();
    const favorites = getFavoritesService();
    await favorites.stop();
    await favorites.start();
    // audit-r204:★ 的 fileId 跟着文献 id 一起改 —— 否则收藏条目指向的旧 id
    //   再也不会命中任何一行 ⇒ 用户的 ★ 静默消失(收藏面板里那条变成点不亮
    //   的孤儿)。relPath 同步改成新根下的绝对路径(literature 侧存绝对路径)。
    //   必须在 favorites.start() **之后**:start() 才把 AtomicFile 绑到新根的
    //   favorites.md 上,否则改写会落回旧目录的副本。
    //   独立 try/catch:收藏改写失败不该连累后面的 literature 重绑。
    if (idRemap.length > 0) {
      try {
        const idMap = new Map(idRemap.map((m) => [m.oldId, m.newId]));
        const pathMap = new Map(idRemap.map((m) => [m.oldId, m.path]));
        const changed = await favorites.remapIds(idMap, pathMap);
        log.info('Favorites ids remapped for new data path', { changed });
      } catch (favErr: unknown) {
        log.error('Favorites id remap after data path switch failed', errMsg(favErr));
      }
    }
    // audit-r160:literature service 同款单例 + 同样走 rootPath 重绑 ──
    //   旧实现只 rebind notes + favorites,切库后 LiteratureService 的
    //   chokidar watcher 仍听旧目录(新目录 OS 拖入 / 外部删不触发 reload),
    //   byId 内存索引仍是旧目录扫描结果,多次切换还会累积 watcher 句柄。
    //   stop()/start() 都是幂等的(参见 literature-service.ts 头注的契约),
    //   与 notes / favorites 顺序插入,保持三服务对称。
    const literature = getLiteratureService();
    await literature.stop();
    await literature.start();
  } catch (rebindErr: unknown) {
    log.error('Service rebind after data path switch failed', errMsg(rebindErr));
  }
  log.info('Data path switched successfully');
}

// ─────────────────────────────────────────────────────────────────────
// audit-r205:「恢复默认数据目录」—— 这个按钮以前是**死的**
// ─────────────────────────────────────────────────────────────────────
//
// 现象(用户可见):用户只要**曾经**把工作区搬离默认位置
// (<Documents>/ResearchHub/data),设置页的「恢复默认数据目录」就**永久失效**,
// 而且报的是一句用户看不懂的话:
//
//   target directory must be empty: C:\Users\x\Documents\ResearchHub\data
//   (contains 37 entries)
//
// 根因 = 两条事实叠加(缺一条都不成立):
//   ① changeDataPath **要求目标目录为空**(r56 的 HIGH 修复:绝不对用户自有的
//      非空目录 rm -rf —— 用户可能选了 D:\MyBackup 作新数据目录,那里有照片);
//   ② changeDataPath 是**复制**(旧目录原样保留,见 r204 头注)⇒ 默认位置里
//      恰恰躺着**上一次工作区的副本**。
//   ⇒ 目标永远非空 ⇒ 按钮永远报「目录必须为空」⇒ 用户永远回不去默认位置。
//
// 修法:**让开**,不是**清空**。
//   默认目录非空时,先把它**改名**到同级的 `<default>.replaced-<ts>`
//   (同卷 ⇒ rename 原子、瞬时、不复制字节),再把当前工作区复制进去。
//   旧副本**一个字节都没删** —— 它只是挪了位置,随时可以挪回去;
//   恢复成功后它作为「上一份工作区的备份」留在旁边(日志给出路径),
//   由用户自己决定何时清理。
//   与「直接 rm -rf 掉默认目录」的本质区别:后者销毁的是**用户数据**
//   (默认目录里可能有用户手工放进去的东西),前者只是换个位置。
//
// 两条「绝不能把工作区自己让开」的防线(下面 (1)(2)):
//   「让开」的副作用是:如果当前工作区**就在**默认目录里(或者在它内部),
//   那一步会把工作区本身搬走 —— 灾难性数据丢失。
//   ⇒ 已经在默认位置 → 整个流程 no-op;
//     工作区在默认目录之内 → 直接拒绝并说清楚。
//
// 不变式:「目标目录必须为空」这条防线**只对用户自选的目标**成立
//   (MIGRATE 流程保持原样,见测试 A7);本流程走的是「让开」而不是
//   「放宽为空检查」—— 后者会让用户自选的非空目录被覆盖。
export async function restoreDefaultDataPath(): Promise<void> {
  const def = defaultDataPath();
  const current = getRootPath();

  // (1) 已经在默认位置 → 什么都不用做。
  //     这一条不是「优化」而是**安全前提**:下面的「让开」会把默认目录改名,
  //     而当前工作区**就是**默认目录时,那一步会把工作区自己搬走。
  if (isSameDir(def, current)) {
    log.info('Already at the default data path; nothing to restore');
    return;
  }
  // (2) 当前工作区在默认目录**之内** → 同样不能「让开」(会把工作区带走)。
  if (relUnderRoot(def, current) !== null) {
    throw new AppError(
      'VALIDATION',
      `当前工作目录位于默认数据目录(${def})之内,无法恢复默认数据目录:${current}`,
    );
  }

  const aside = await moveDefaultDirAside(def);
  try {
    await switchDataPath(def);
  } catch (err: unknown) {
    // 失败时:旧副本还在 aside 位置(一个字节都没丢);
    // changeDataPath 内部会把半成品拷贝回滚掉(def 是我们 mkdir 出来的)。
    // 错误消息里带出 aside 路径 —— 用户据此能找回自己的数据,而不是只看到
    // 一句「失败了」。
    const detail = aside
      ? `恢复默认数据目录失败;原默认工作区已保留在 ${aside}(未删除)。${errMsg(err)}`
      : `恢复默认数据目录失败:${errMsg(err)}`;
    log.error('Restore to default data path failed', detail);
    throw new AppError('MIGRATION_FAILED', detail, err);
  }
  if (aside) {
    log.info('Previous default workspace moved aside (not deleted)', aside);
  }
}

/**
 * 把默认目录「让开」:存在且非空时,改名到同级的 `<def>.replaced-<ts>`。
 *
 * - 不存在 / 已空 → 返回 null(无需让开,后续流程与旧行为一致)。
 * - 改名而不是删除:同卷 rename 是原子的、瞬时的、不复制字节;
 *   旧副本完整留在磁盘上,用户随时能拿回来。
 * - 名字带随机后缀:同一毫秒内重试两次也不会撞名(rename 到已存在的目录会
 *   报 EEXIST/ENOTEMPTY,那会让恢复白白失败一次)。
 */
async function moveDefaultDirAside(def: string): Promise<string | null> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(def, { withFileTypes: true });
  } catch (err: unknown) {
    if (errnoCode(err) === 'ENOENT') return null;
    throw err;
  }
  if (entries.length === 0) return null;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const aside = `${def}.replaced-${stamp}`;
  await fs.rename(def, aside);
  log.info('Default data dir moved aside', { from: def, to: aside });
  return aside;
}
