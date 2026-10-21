-- 0002_drop_dead_cols.sql (r44, 2026-10-15)
-- audit r44:drop files 表上 0 生产 reader 的死列(sidecar_mtime / sidecar_exists /
-- ai_exists)。index-builder.buildFileRow 在同一 commit 不再写入这三列。
--
-- 实现说明(与 brief 的差异):
--   brief 推荐 `ALTER TABLE files DROP COLUMN x3`(3 行),但 SQLite 的 ALTER TABLE
--   DROP COLUMN 在目标列不存在时**硬报错**("no such column: sidecar_mtime")。
--   这条迁移对两种 install 路径都得正确:
--     a) 全新安装:0001 创 files 表,**不带**这三个列(brief step 3 明示)
--     b) r43 升级:0001 的 CREATE TABLE IF NOT EXISTS 是 no-op,files 表保留 r43
--        schema 的三个死列
--   路径 (a) 下 brief 的 3 行 ALTER 全部抛错,migration 卡住。
--   改用 table-rebuild 模式:CREATE TABLE IF NOT EXISTS files_new(无死列) → 把
--   files 的非死列复制过去(INSERT OR IGNORE 兼容「上一次崩溃后残留 files_new」)
--   → DROP 旧 files → RENAME files_new → files。无论 (a) 还是 (b),最终 schema
--   与 r43 之后再无死列一致。
--
-- 事务:由 migrator.ts 的 `db.transaction(...)` 包裹,本文件不显式 BEGIN/COMMIT
-- (见 0001_init.sql 头部说明)。

CREATE TABLE IF NOT EXISTS files_new (
  id TEXT PRIMARY KEY,
  rel_path TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  extension TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  title TEXT,
  authors TEXT,
  year INTEGER,
  doi TEXT,
  tags TEXT,
  abs_library_path TEXT NOT NULL
);

INSERT OR IGNORE INTO files_new (
  id, rel_path, filename, extension, size, mtime,
  title, authors, year, doi, tags, abs_library_path
)
SELECT
  id, rel_path, filename, extension, size, mtime,
  title, authors, year, doi, tags, abs_library_path
FROM files;

DROP TABLE files;
ALTER TABLE files_new RENAME TO files;
