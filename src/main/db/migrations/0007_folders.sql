-- 0007_folders.sql —— 虚拟文件夹(侧栏 VS Code 式文件管理的组织层)
--
-- 设计:文件夹是 **DB-only 概念**。不建磁盘目录、不移动文件、不改资源 id ——
-- 「把条目移进文件夹」= UPDATE resources.folder_id。好处:
--   * note id = relPath 哈希、lit id = 'lit:'+absPath,物理不动 ⇒ id 稳定,
--     favorites.md 收藏键 / SearchPanel 直达 / selectedId 全部不断链;
--   * 两棵 kind 树(notes / literature)与 FS 真实目录(notes/ 下可以有物理
--     子目录)正交,互不解释。
-- 真相源是本表 + resources.folder_id 列;fs 目录树不是 UI 输入。
--
-- 删除语义:deleteFolder **不删内容** —— 子文件夹 parent 上提、资源
-- folder_id 上提(移向树根一层),与「组织容器消失」直觉一致,无数据丢失。
-- 成环防护(moveFolder)在服务层(folders-repo)做,SQL 无递归约束。
--
-- 事务:migrator.ts 的 db.transaction 包裹,本文件不写 BEGIN/COMMIT
-- (0001_init.sql 同款约定)。ALTER TABLE ADD COLUMN 在 SQLite 中即时、
-- 无表重建,旧行 folder_id=NULL 即「根」,无需回填。

CREATE TABLE folders (
  id         TEXT PRIMARY KEY,            -- 'fld:' + randomUUID()
  kind       TEXT NOT NULL CHECK (kind IN ('note', 'literature')),
  name       TEXT NOT NULL,
  parent_id  TEXT REFERENCES folders(id), -- NULL = 该 kind 树根;删除级联在服务层事务化
  created_at INTEGER NOT NULL             -- epoch ms(展示预留 + 同时间序稳定排序兜底)
);

CREATE INDEX folders_kind ON folders(kind);
CREATE INDEX folders_parent ON folders(parent_id);

ALTER TABLE resources ADD COLUMN folder_id TEXT;
CREATE INDEX resources_folder ON resources(folder_id);
