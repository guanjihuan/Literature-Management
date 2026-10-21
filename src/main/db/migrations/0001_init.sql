-- 0001_init.sql (r44, 2026-10-15)
-- SQLite schema 快照 —— 切换自原本 in-line 的 SCHEMA 字符串常量。
-- 与原 SCHEMA 的差异:
--   * 移除 sidecar_mtime / sidecar_exists / ai_exists 三列(由 0002 显式 drop,
--     保证「已经在生产库里有这 3 列」的旧用户也能平迁)
--   * notes_fts 不再创建 AFTER INSERT/UPDATE/DELETE 触发器(notes 在本轮仍是普通
--     FTS5 表,FTS 同步由 buildTransactionWrappers 显式发 INSERT OR REPLACE/DELETE;
--     触发器方案留给 0003 一次性切换 —— 与原 SCHEMA 行为一致)
--
-- 事务:本文件**不**显式包含 BEGIN; ... COMMIT;。atomicity 由 migrator.ts 的
-- `db.transaction(() => { db.exec(sql); db.pragma(...) })()` 包裹,后者底层发
-- BEGIN/COMMIT。SQL 文件内嵌显式 BEGIN 会与 better-sqlite3 的事务包装
-- 嵌套冲突 ("cannot start a transaction within a transaction"),所以迁移级
-- BEGIN/COMMIT 由 migrator 统一发。
-- 其余结构(CREATE TABLE IF NOT EXISTS / DROP INDEX IF EXISTS / FTS5 虚表)逐字镜像
-- sqlite.ts 原 SCHEMA,确保从 r43 升级到 r44 的 DB 在跑完 0001 + 0002 后与原库等价。

-- 文件元数据
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  rel_path TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  extension TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  -- 元数据字段(title / authors / year / doi / tags 冗余存储便于搜索 + FTS5 索引)
  title TEXT,
  authors TEXT,
  year INTEGER,
  doi TEXT,
  tags TEXT,
  abs_library_path TEXT NOT NULL
);

-- perf(2026-08-28):删 idx_files_rel / idx_notes_rel —— rel_path 已经是 UNIQUE 列,
-- UNIQUE 自带隐式 B-tree 索引,显式再建一份是 duplicate 写放大。
-- audit r29 (2026-09-21):删 idx_files_year / idx_files_extension —— 之前注释承认
--   「没有任何 SQL 真正使用」,但保留 CREATE 仍让每次 upsertFile 都维护两份
--   写不写都不读的 B-tree,5000 文件量级下 write amplification +10-20%。
--   searchAll 走 FTS5(files_fts 已有 column 索引) + listFiles 走 rowid 扫描,
--   都不需要这两个 secondary index。DROP IF EXISTS 兜底老库,新库不创建。
DROP INDEX IF EXISTS idx_files_rel;
DROP INDEX IF EXISTS idx_notes_rel;
DROP INDEX IF EXISTS idx_files_year;
DROP INDEX IF EXISTS idx_files_extension;

-- 独立笔记
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  rel_path TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  title TEXT,
  tags TEXT,
  mtime INTEGER NOT NULL,
  abs_path TEXT NOT NULL
);

-- FTS5 虚表 (文件) - 使用外部内容模式,可以 DELETE/UPDATE
-- perf(2026-08-24):unicode61 'remove_diacritics 2' 让 é/e、ü/u 等归一化匹配
-- (此前 é 只能查 é,中文无影响,西文文献检索显著改善)
CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
  title, authors, tags, year, doi,
  content='files', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
);

-- FTS5 虚表 (笔记)
-- audit round 17 (2026-09-07):只索引 title + tags,body 走磁盘 grep。
-- 不索引 body 的两个收益:
--   1. 用户外部改 MD 文件后无需重建索引 → 消除"外部改 MD 索引过期"的隐患
--   2. upsertNote/deleteNote/renameNoteInDB 不再需要 body 参数,API 更窄
-- 保留 body 列在 schema 中只是为了兼容老用户升级时表已存在的场景:升级后
-- body 列仍在但 INSERT 不再写入,body 数据自然衰减;snippet 走列 0/1,不依赖 body。
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  title, tags, body,
  tokenize='unicode61 remove_diacritics 2'
);
