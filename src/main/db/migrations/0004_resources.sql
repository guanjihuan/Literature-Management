-- 0004_resources.sql (audit-r64, 2026-10-16)
-- Resource 模型:单一 resources 表 + 单一 resources_fts,取代
-- files / notes / files_fts / notes_fts 四表(旧表数据由 0005 迁入并 DROP)。
-- 设计来源:docs/superpowers/specs/2026-10-16-resource-model-design.md §2,
-- 落地时有两处与 spec SQL 块的**有意偏差**(spec §2.1 的「简化决定」已预告):
--
--   1. resources_fts 是**普通(standalone)FTS5 表**,不是 external-content。
--      spec SQL 块里的 ad/au 触发器发的是 external-content 专用 'delete'
--      命令,在普通 FTS5 表上是**非法语句**(SQLite 文档:'delete' 命令只对
--      external-content / contentless 表有效)。普通表上正确的删除是
--      `DELETE FROM resources_fts WHERE rowid = ?`(完整内容存于 FTS 表内,
--      token 随行删除)。
--   2. 因此**不建任何触发器**,FTS 同步完全 application-managed:
--      ResourcesRepo(src/main/db/resources-repo.ts)在单事务内做
--      「FTS DELETE → 主表 upsert → FTS INSERT」,顺序硬约束与旧
--      buildTransactionWrappers 一致。'rebuild' 命令同样**禁止**用在本表
--      —— 对普通 FTS5 表它会先清空再从「自身」重读,等于把索引清空
--      (旧 runFtsIntegrityCheck 的 rebuild 路径随本迁移一并退役)。
--
-- body 列:note 的 markdown 全文 / literature 抽取文本。body 由 repo upsert
-- 时写入;0005 迁移的行 body='' + indexed_at=0:
--   * notes:应用层启动期回填(NotesService.resyncIfNeeded 的 stale-index 补索引)。
--   * literature:**没有回填消费者** —— 设想过但未落地;新导入行同样写
--     indexed_at=0 + 'filename-only'(见 src/main/ipc/literature.ts 的诚实
--     标注),即 title 恒可搜、body 留给未来正文抽取流水线。本列现状对迁移
--     行与导入行语义一致,不算腐化,但引用本头注的旧文案承诺过回填,属谎。
--
-- 事务:由 migrator.ts 的 `db.transaction(...)` 包裹,本文件不显式 BEGIN/COMMIT
-- (见 0001_init.sql 头部说明)。

CREATE TABLE resources (
  id             TEXT PRIMARY KEY,        -- ResourceId 字面:'note:<uuid>' / 'lit:<relPath>'
  kind           TEXT NOT NULL,           -- 'note' | 'literature'
  title          TEXT NOT NULL,
  rel_path       TEXT NOT NULL,           -- note: 相对 notes/;literature: 相对所属 root
  abs_path       TEXT NOT NULL,           -- 主进程读盘用;note = <rootPath>/notes/<rel_path>
  root_id        TEXT,                    -- 仅 literature;root 概念未落地:迁移行与导入行都恒 NULL(见 ipc/literature.ts)
  size           INTEGER NOT NULL,
  mtime          INTEGER NOT NULL,        -- epoch ms
  indexed_at     INTEGER NOT NULL,        -- epoch ms;0 = 从未索引(0005 迁移标记,启动期补 body)
  extract_status TEXT NOT NULL DEFAULT 'ok', -- note 永远 'ok';literature: pending/ok/failed/filename-only
  page_count     INTEGER,                 -- 仅 PDF 文本层成功时有
  tags           TEXT NOT NULL DEFAULT '[]'  -- JSON 数组(仅 note 用)
);

CREATE INDEX resources_kind ON resources(kind);
CREATE INDEX resources_root ON resources(root_id);
CREATE INDEX resources_rel ON resources(rel_path);

-- 单一 FTS5 虚表(unicode61 + remove_diacritics 2,é/e、ü/u 归一化匹配)。
-- id / kind UNINDEXED:只做 JOIN 回主表与 kind 过滤,不进倒排。
CREATE VIRTUAL TABLE resources_fts USING fts5(
  id UNINDEXED,
  kind UNINDEXED,
  title,
  body,
  tokenize='unicode61 remove_diacritics 2'
);
