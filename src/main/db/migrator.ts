// PRAGMA user_version 驱动的有序迁移:000N_*.sql 按序、同事务原子绑 user_version,
// 幂等(>= 当前版本不重跑)。SQL 不要自带 BEGIN/COMMIT。

import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { registerMigrationFunctions } from './cjk-segment';

/**
 * 应用 dir 下所有 > 当前 user_version 的迁移。
 * @throws 全部跑完仍为 0(目录错传/静默失败)
 */
export function applyMigrations(db: Database.Database, dir: string, upTo?: number): void {
  // r196:迁移期需要宿主提供的 SQL 函数(cjk_seg —— 存量 FTS 行重分词用,
  //   见 src/main/db/cjk-segment.ts)。必须在任何迁移跑之前注册。
  //   注册是幂等的(同 db 重复调用不会抛「函数已存在」)。
  registerMigrationFunctions(db);
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  const current = db.pragma('user_version', { simple: true }) as number;
  for (const f of files) {
    const v = parseInt(f.slice(0, 4), 10);
    if (v <= current) continue;
    if (upTo !== undefined && v > upTo) continue;
    const sql = readFileSync(join(dir, f), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${v}`);
    })();
  }
  // 无 upTo 上限且整目录跑完仍为 0 才算卡死(测试用 upTo 提前截断是预期部分应用,不抛)
  if (upTo === undefined && (db.pragma('user_version', { simple: true }) as number) === 0) {
    throw new Error('migration stuck at 0');
  }
}
