-- 0006_repair_doubled_lit_abs.sql (audit-r119, 2026-10-18)
-- 修复老版 0005 产出的 literature abs_path 双后缀损坏行。
--
-- 事故链:老 files 表的 abs_library_path 列名骗人,实际存的是**每个文件自己
-- 的绝对路径**(写 f.absPath / 读回 absPath,全生命周期自洽)。r64 写的 0005
-- 误按「库根目录」语义 join '/'||rel_path → 迁移行 abs_path 变成
-- <file_abs>/<rel_path>(典型:C:\...\library\NAME.pdf/NAME.pdf),
-- reader/协议层必 ENOENT——文件在磁盘好好的,点开就是打不开。0005 已同步改
-- 为直拷,但已执行过老 0005 的存量库需要本迁移把数据修回来。
--
-- 判定(三条件合取,保证只有老 0005 的双后缀形态被命中):
--   1) id = 'lit:' || rel_path —— 0005 行专属。r71+ 新导入行的 id 是
--      litResourceId(absPath)(分隔符归一化),其 rel_path 退化为完整
--      abs_path,两式无法同时成立;即便 POSIX 下 id 形态巧合相等,条件 2
--      的长度下限(abs ≥ 2*rel+1)也把它们挡掉(rel=abs 时不满足)。
--   2) length(abs_path) >= 2*length(rel_path) + 1 —— 双段结构长度下限。
--   3) 尾部恰为 '/'||rel_path,且再往前 rel_path 长度的片段仍是 rel_path
--      (或其反斜杠变体)—— 双后缀形状。单后缀干净行:Windows 的分隔符是
--      '\' 不匹配 '/'+rel,POSIX 深路径的 rel 长度片段落在目录中段而非
--      rel 本身,均不被命中。REPLACE 分支专修 Windows 子目录行
--      (rel 用 '/' 而 per-file abs 用 '\')。
--
-- 修复动作 = 剥掉尾部 '/'||rel_path,还原 per-file abs。
-- 幂等性的诚实论证(audit-r124 修正旧文案「条件 3 不再成立」的不精确):
--   Windows 行:修好后尾窗是 '\'||rel,'/'+rel 直接不匹配,天然出局。
--   POSIX 行:修好后尾窗 '/'+rel **仍然匹配**,挡住重复剥离的是条件 3 的
--   内层双形状合取(abs 再往前 rel 长度的片段通常落在目录名而非 rel)。
--   真正硬保证是 migrator 的 user_version 单跑:0006 每库一生只执行一次。
--   理论残余(如实记录,不修):若某迁移行的**真** per-file abs 本就形如
--   'dir/NAME.pdf/NAME.pdf'(目录与文件同名),单跑剥一层回到真值安全,但
--   该行修后仍整体匹配 WHERE —— 一旦将来有人重跑 0006 会多剥一层。重跑
--   前须先读该行现状。
--   FTS 种子行只含 title,abs_path 不进索引,无需重同步。
UPDATE resources
SET abs_path = substr(abs_path, 1, length(abs_path) - length(rel_path) - 1)
WHERE kind = 'literature'
  AND id = 'lit:' || rel_path
  AND rel_path <> ''
  AND length(abs_path) >= 2 * length(rel_path) + 1
  AND substr(abs_path, -length(rel_path) - 1) = '/' || rel_path
  AND (
    substr(abs_path, -2 * length(rel_path) - 1, length(rel_path)) = rel_path
    OR substr(abs_path, -2 * length(rel_path) - 1, length(rel_path)) = REPLACE(rel_path, '/', '\')
  );
