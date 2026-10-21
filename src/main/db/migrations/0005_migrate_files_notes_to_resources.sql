-- 0005_migrate_files_notes_to_resources.sql (audit-r64, 2026-10-16)
-- 旧 files + notes 数据迁入 resources,然后 DROP 全部旧表。
--
-- 对两种 install 路径都正确(与 0002 同款防御):
--   a) 全新安装:0001-0003 建过旧表但 0 行 → INSERT 是 no-op,DROP 正常;
--   b) 老用户升级:旧行全量迁入。
-- 因此 migrator 不需要条件分支,本条永远跟在 0004 后跑。
--
-- 关键决策:
--   * indexed_at = 0(不是 mtime)—— 标记「FTS body 未填」。note body 在磁盘
--     .md 上,SQL 层读不到;老 notes_fts 也只索引 title/tags,没有 body 可搬。
--     启动期 NotesService.resyncIfNeeded 捡 indexed_at=0 的 note 行重读磁盘
--     回填 body;literature 行 extract_status 标成 'filename-only' ——
--     语义诚实:只有文件名/标题可搜,且**没有** indexer 会回填它(设想过的
--     R63 indexer 未落地,新导入行同款终态,见 0004 头注与 ipc/literature.ts)。
--   * resources_fts 种子行 body='' —— 不能用 'rebuild' 命令(普通 FTS5 表
--     上 rebuild = 清空,见 0004 头注)。种子只填 title,body 由应用层回填时
--     走 repo 的 DELETE+INSERT 覆盖。
--   * literature 的 abs_path = abs_library_path 原样直拷。列名骗人:老代码
--     (初版起,含 r44/r20 era)写入的是**该文件自己的绝对路径**(f.absPath),
--     读回时 absPath: row.abs_library_path,自洽。audit-r119 前本迁移误按
--     「库目录」语义 join '/'||rel_path,产出 <file>/<file> 双后缀 → 迁移行
--     reader 必 ENOENT(实证:磁盘完好的 PDF 打不开)。存量已中弹的行由
--     0006 修复;root_id 推不出来(root 概念 R63 才引入),置 NULL。
--   * title 兜底 filename:老 files.title 可空,resources.title NOT NULL。
--
-- 事务:由 migrator.ts 的 `db.transaction(...)` 包裹,本文件不显式 BEGIN/COMMIT。

INSERT INTO resources (id, kind, title, rel_path, abs_path, root_id,
                       size, mtime, indexed_at, extract_status, tags)
SELECT 'note:' || id, 'note', COALESCE(title, filename),
       rel_path, abs_path, NULL,
       0, mtime, 0, 'ok', COALESCE(tags, '[]')
FROM notes;

INSERT INTO resources (id, kind, title, rel_path, abs_path, root_id,
                       size, mtime, indexed_at, extract_status, tags)
SELECT 'lit:' || rel_path, 'literature', COALESCE(title, filename),
       rel_path, abs_library_path, NULL,
       size, mtime, 0, 'filename-only', '[]'
FROM files;

-- FTS 种子:只填 title,body 待应用层回填(indexed_at=0 标记)。
INSERT INTO resources_fts (rowid, id, kind, title, body)
SELECT rowid, id, kind, title, '' FROM resources;

-- 删旧表。FTS 虚表先于其 content 表 DROP(files_fts 是 files 的
-- external-content 表);notes 上的 0003 触发器随表 DROP 自动消失。
DROP TABLE files_fts;
DROP TABLE files;
DROP TABLE notes_fts;
DROP TABLE notes;
-- 更早迁移(P1 前)的残留,IF EXISTS 兜底不存在的新库路径。
DROP TABLE IF EXISTS notes_delete_log;
