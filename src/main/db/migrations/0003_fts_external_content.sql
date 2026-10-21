-- 0003_fts_external_content.sql (r45, 2026-10-15)
-- notes_fts 从「普通 FTS5 表 + body 列」切到「external-content + title/tags 列」
-- + 3 个 AFTER 触发器(notes_ai / notes_ad / notes_au)自动同步。
--
-- 设计取舍:
--   * 为什么 external-content:body 内容实际在磁盘 MD 文件上,索引 body 会让
--     用户外部改 MD 文件后索引过期;只索引 title + tags 后,FTS 是「DB 内元数据」
--     的视图,与外部 MD 文件天然无关联问题。round 17 决策延续。
--   * 为什么不要 body 列:索引里塞 body 既扩索引体积又引失效问题,得不偿失。
--     body 检索靠磁盘 grep(由 P2 阶段 searchNotes 走 fs.readFile + 正则匹配)。
--   * 为什么用 3 个触发器替代 buildTransactionWrappers 里的 manual upsertNoteFts
--     / delNoteFts:让 FTS 同步在 SQL 层声明,与主表 INSERT/UPDATE/DELETE 同事务
--     同进退,自然解决「主表成 / FTS 不成」(r44 那个 ghost token 之父)。原 manual
--     路径彻底删除。
--   * 为什么 UPDATE 用 'delete' + 二次 INSERT:external-content 表只接受 'delete'
--     命令带旧值来移除旧 rowid 的倒排 token(参 files_fts 同款修复,audit
--     2026-10-04);先发 'delete'(带 old),再发新 INSERT,模拟 ROHA 模式,无 rowid
--     漂移(旧 FTS rowid 仍是 new.rowid,因为 rowid 不因 UPDATE 改变)。
--
-- 事务:由 migrator.ts 的 `db.transaction(...)` 包裹,本文件不显式 BEGIN/COMMIT
-- (见 0001_init.sql 头部说明)。
--
-- 注意:0003 跑前 notes_fts 是普通 FTS5 + 带 body 列(由 0001 创建),DROPTABLE
-- 必须在新事务开头;否则 FTS5 'shadow table name collision' 会让 CREATE 失败。

DROP TABLE notes_fts;

CREATE VIRTUAL TABLE notes_fts USING fts5(
  title, tags,
  content='notes', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, tags)
  VALUES (new.rowid, new.title, new.tags);
END;

CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, tags)
  VALUES ('delete', old.rowid, old.title, old.tags);
END;

CREATE TRIGGER notes_au AFTER UPDATE ON notes BEGIN
  -- 顺序:旧 rowid 的旧值先 'delete',再发新值;rowid 在 UPDATE 后不变,
  -- 同 rowid 写两次即 replace 语义,external-content 表对外表现为「旧词消失、
  -- 新词出现」。
  INSERT INTO notes_fts(notes_fts, rowid, title, tags)
  VALUES ('delete', old.rowid, old.title, old.tags);
  INSERT INTO notes_fts(rowid, title, tags)
  VALUES (new.rowid, new.title, new.tags);
END;
