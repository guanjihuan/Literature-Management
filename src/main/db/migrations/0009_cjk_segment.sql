-- 0009_cjk_segment.sql (r196, 2026-10-20)
--
-- 目的:给**存量** FTS 行补上 CJK 分词,否则中文全文搜索对老数据仍然
--   0 结果(原理见 src/main/db/cjk-segment.ts 的模块头注释)。
--
--   unicode61 会把整串中文当成**一个** token ⇒ 搜「学习」「机制」「注意力」
--   这类词内子串在老数据上永远搜不到。索引侧新写入的行由
--   resources-repo.ts 在 upsert 时分词(ZWSP 分隔),本迁移负责**存量**。
--
-- 为什么能在 SQL 里做:分词逻辑是 JS 实现(cjk-segment.ts),迁移层通过
--   migrator.ts 注册的确定性 SQL 函数 cjk_seg 暴露给 SQL。
--
-- 为什么从 resources_fts **自己**读原文:resources_fts 是普通(standalone)
--   FTS5 表,完整文本存在表内(见 0004 头注)⇒ 存量 title/body 可以直接从
--   FTS 表读出再重新分词写回,**不需要**回磁盘重读笔记(避免启动期扫全盘),
--   也不会引入「磁盘内容 ≠ 索引内容」的新数据面。
--
-- 幂等性:
--   * 本迁移只由 user_version 驱动跑一次;
--   * cjk_seg 本身幂等(先剥 ZWSP 再切)⇒ 就算某行已被分词,重跑也只是
--     写回同样的内容,不会累积 ZWSP。
--
-- 事务:由 migrator.ts 的 db.transaction 包裹,本文件不写 BEGIN/COMMIT
--   (0001_init.sql 同款约定)。

CREATE TEMP TABLE _cjk_seg AS
SELECT rowid, id, kind, cjk_seg(title) AS title, cjk_seg(body) AS body
FROM resources_fts;

DELETE FROM resources_fts;

INSERT INTO resources_fts (rowid, id, kind, title, body)
SELECT rowid, id, kind, title, body FROM _cjk_seg;

DROP TABLE _cjk_seg;
