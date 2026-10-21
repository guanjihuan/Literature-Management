-- 0008_drop_folders.sql —— 彻底下线 DB 虚拟文件夹
--
-- 触发:r161 disk-folder refactor —— 侧栏从「DB 虚拟文件夹」切到「真实磁盘
--   目录」(VS Code / Finder 语义),「移入文件夹」= 真实 fs.rename 而不是
--   UPDATE folder_id。两棵 kind 树(notes / literature)统一走 `<rootPath>/<kind>/`
--   物理子目录作为组织层,favorites 引用按 byId + 新 relPath 重算后自愈。
--
-- 顺序契约(SQLite ALTER 限制):
--   1. DROP INDEX(资源表 + folders 表各两条)—— DROP COLUMN 会自动重表,
--      索引先删避免内部引用
--   2. ALTER TABLE resources DROP COLUMN folder_id —— SQLite 3.35+ 支持
--      DROP COLUMN(无需表重建,即时元数据更新);better-sqlite3 自带 3.46+,
--      满足
--   3. DROP TABLE folders —— CASCADE 不需要(外键无显式声明;0007 迁移也
--      没加 ON DELETE CASCADE,因为「删文件夹上提子内容」语义在服务层做
--      不靠 SQL 级联)
--   4. PRAGMA user_version = 8 —— migrator.ts 在同事务里设,本文件不写
--
-- 行为/数据语义:
--   * 老用户 DB 里的 folders 行 + resources.folder_id 值被一并丢弃;
--     物理文件无动,笔记 / 文献内容 100% 保留
--   * 跨文件夹 rename 改 note id(relPath 哈希),favorites.md 引用键随之
--     失效(但 byId 重建后 favorites 行的 relPath / id 字段同步更新);
--     这是切到真实文件管理的天然 trade-off,UI 提示「已重算收藏」即可
--   * chokidar 不动 —— notes 本就是 depth:16 递归,本次只是把 literature
--     从 depth:0 提升到 depth:16(独立 commit,与本迁移解耦)
--
-- 事务:migrator.ts 的 db.transaction 包裹,本文件不写 BEGIN/COMMIT
-- (0001_init.sql 同款约定)
DROP INDEX IF EXISTS resources_folder;
DROP INDEX IF EXISTS folders_kind;
DROP INDEX IF EXISTS folders_parent;
ALTER TABLE resources DROP COLUMN folder_id;
DROP TABLE IF EXISTS folders;
PRAGMA user_version = 8;
