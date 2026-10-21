// SQLite 生命周期:initDB / waitForDBInit / getDB / closeDB / WAL checkpoint
// DB 放 userData(本地),不放数据路径(云盘同步会损坏 SQLite)
// 表级 CRUD / FTS 搜索见 resources-repo.ts
import Database from 'better-sqlite3';
import { app } from 'electron';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { createLogger } from '../utils/logger';
import { AppError, errMsg } from '../utils/error';
import { applyMigrations } from './migrator';

const log = createLogger('db');

let db: Database.Database | null = null;

export function initDB(dataPath: string): Database.Database {
  if (db) return db;
  // 任何 throw 都需 reject 所有 initDbResolvers,否则 waitForDBInit 的 awaiter 永久挂住
  try {
    return initDBInner(dataPath);
  } catch (err) {
    // 粘滞失败状态,closeDB 清半初始化句柄(防下次 initDB 返无 schema 的 db)
    closeDB();
    dbInitError = err;
    for (const { reject } of initDbResolvers.splice(0)) reject(err);
    throw err;
  }
}

function initDBInner(dataPath: string): Database.Database {
  // DB 放 userData 下独立子目录,数据路径可能被云盘同步,SQLite 在云盘上会损坏
  const dbDir = join(app.getPath('userData'), 'index');
  mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, 'index.sqlite');
  log.info('Opening database', dbPath);
  log.info('(Data files in:', dataPath, '- not synced)');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('temp_store = MEMORY'); // 内存 temp store,大 ORDER BY 不写盘
  db.pragma('cache_size = -65536'); // 64MB page cache
  db.pragma('mmap_size = 268435456'); // 256MB mmap 加速读
  applyMigrations(db, join(__dirname, 'migrations'));
  // ANALYZE + SqliteStat4 — 冷启动后 planner 无 stats,1.5k+ 库降 30-50% latency
  db.pragma('optimize(0x10002)');
  // 成功路径清粘滞失败标记,否则一次失败永久毒化后续重试
  dbInitError = null;
  for (const { resolve } of initDbResolvers.splice(0)) resolve();
  return db;
}

/** 等待 initDB 完成,失败 reject,完成后立即 resolve */
const initDbResolvers: Array<{
  resolve: () => void;
  reject: (err: unknown) => void;
}> = [];

// 粘滞 initDB 失败标记:initDB fire-and-forget,waitForDBInit 后到时立即拿同一个错误,
// 否则 resolver 永久挂起,启动遮罩卡 30s
let dbInitError: unknown = null;

export function waitForDBInit(): Promise<void> {
  if (db) return Promise.resolve();
  if (dbInitError) return Promise.reject(dbInitError);
  return new Promise((resolve, reject) => {
    initDbResolvers.push({ resolve, reject });
  });
}

export function getDB(): Database.Database {
  if (!db) throw new AppError('INTERNAL', 'DB not initialized');
  return db;
}

export function closeDB(): void {
  if (db) {
    db.close();
    db = null;
  }
  // closeDB 兜底清 WAL timer,防崩溃/teardown 路径 timer 阻退出
  stopWalCheckpointTimer();
}

// 30 分钟间隔 — 周期 checkpoint 防 -wal 膨胀到 4GB 上限,TRUNCATE 截 0;busy 降级 PASSIVE
const WAL_CHECKPOINT_INTERVAL_MS = 30 * 60 * 1000;

let walCheckpointTimer: ReturnType<typeof setInterval> | null = null;

export function startWalCheckpointTimer(): void {
  if (walCheckpointTimer) return;
  walCheckpointTimer = setInterval(() => {
    if (!db) return;
    try {
      // audit-r80 (2026-10-17) LOW:better-sqlite3 的 wal_checkpoint pragma
      //   返回**对象数组** `[{ busy, log, checkpointed }]`,旧判断 `r[0] === 1`
      //   拿对象比数字恒为 false —— busy 时降级 PASSIVE 的分支是死代码,
      //   TRUNCATE 撞读写占用时静默不完全,-wal 在长跑会话里持续增长(实证:
      //   仓库自带 better-sqlite3 跑 pragma 返回 [{busy:0,…}],r[0]===1 恒假)。
      const r: unknown = db.pragma('wal_checkpoint(TRUNCATE)');
      const busy = Array.isArray(r) && (r[0] as { busy?: unknown } | undefined)?.busy === 1;
      if (busy) {
        db.pragma('wal_checkpoint(PASSIVE)');
      }
    } catch (err: unknown) {
      log.warn('wal_checkpoint failed', errMsg(err));
    }
  }, WAL_CHECKPOINT_INTERVAL_MS);
  // .unref() 让 timer 不持 event loop,崩溃/SIGINT 路径正常退出
  walCheckpointTimer.unref?.();
  log.info('WAL checkpoint timer started', { intervalMs: WAL_CHECKPOINT_INTERVAL_MS });
}

export function stopWalCheckpointTimer(): void {
  if (!walCheckpointTimer) return;
  clearInterval(walCheckpointTimer);
  walCheckpointTimer = null;
}
