// src/main/db/cjk-segment.ts
//
// r196:CJK 分词 —— 让中文全文搜索真正能用。
//
// ── 问题(2026-10-20 内存库实测)────────────────────────────────────────
// FTS5 的 unicode61 分词器把**连续的中文串**当成**一个** token。
// unicode61 不区分文字系统 —— 汉字是 Unicode 字母(Lo),于是
//   「本文介绍注意力机制」整串 = 1 个 token
//   「Attention注意力机制」整串 = 1 个 token(中英混排同样中招)
// 后果:搜「学习」「机制」「注意力」这类**词内子串**一律 0 结果,
// 只有恰好在整串开头的前缀能命中。实测(unicode61 + remove_diacritics 2):
//   学习 → 0 行 / 注意力 → 1 行(恰好在句首) / 机制 → 0 行
// 即中文笔记的全文搜索基本等于不可用,这是 r196 要修的根因。
//
// ── 解法:索引侧插 ZWSP 分隔 + 查询侧改用短语 ────────────────────────
//   索引侧:「深度学习」→「深␣度␣学␣习」(␣ = U+200B 零宽空格)
//     ⇒ unicode61 视 ZWSP 为分隔符(它属 Cf 类,不是字母/数字),
//       于是每个汉字成为独立 token。
//   查询侧:「学习」→ FTS5 短语 "学 习"
//     ⇒ 要求两个 token **相邻** ⇒ 命中所有含「学习」的文本且保序。
//   CJK↔拉丁边界同样用 ZWSP 断开(否则「Attention注意力」仍是**一个**
//     token,两边都搜不到)。
//
// ── 为什么用 ZWSP(U+200B)而不是别的分隔符 ─────────────────────────
//   * unicode61 视其为分隔符(实测);
//   * 视觉不可见 ⇒ 万一漏了清洗也不会被用户看见(我们仍然清洗);
//   * 不占用 ASCII 可见字符 ⇒ 不污染搜索词 / 文件名 / 片段文本。
//
// ── 为什么不用 trigram 分词器 ───────────────────────────────────────
//   trigram 需要**至少 3 个字符**才能表达一次查询,中文双字词
//   (「学习」「机制」「注意力」)根本没法用 trigram 查 —— 恰恰是中文
//   最常见的查询形态。
//
// ── 为什么不用自定义 tokenizer ───────────────────────────────────────
//   FTS5 的自定义分词器必须是 C 扩展,better-sqlite3 不允许在 JS 层注册。
//
// ── 模块边界 ─────────────────────────────────────────────────────────
//   * 本模块是**纯函数**(无 electron / 无 DB 依赖)⇒ 可直接单测;
//   * 索引侧(segmentCjk)只在写 FTS 前调用,主表 resources.title 保持原样;
//   * 查询侧(segmentQueryToken / splitScriptRuns)在 sanitizeFtsQuery 里用;
//   * 展示侧(stripZwsp)在 searchResources 返回前把 ZWSP 洗掉。

// 类型导入(编译期擦除)⇒ 本模块运行时**不依赖** better-sqlite3 原生模块,
// 纯函数部分可直接单测。
import type Database from 'better-sqlite3';

/**
 * 分隔符:零宽空格(U+200B)。unicode61 当它是分隔符。
 *
 * ⚠ 必须写成转义序列而不是字面量 —— U+200B 是**不可见字符**,写进源码后
 *   在编辑器 / diff / 复制粘贴里都看不出来,极易退化成空串(实测踩过:
 *   一旦变成 '' 分词就完全不生效,而代码看着完全正常,只能靠断言抓住)。
 */
export const ZWSP = String.fromCharCode(0x200b);

const ZWSP_RE = new RegExp(ZWSP, 'g');

/**
 * CJK 字符判定。
 *
 * 覆盖:汉字(CJK 统一表意文字 + 扩展 A + 兼容表意文字 + 扩展 B)、
 * 日文假名(平假名 / 片假名)、谚文音节。
 *
 * 为何包含假名与谚文:这些文字同样「字之间无空格」,unicode61 会把整串
 * 当一个 token,与汉字同病。谚文音节虽然以词为单位,但按音节切开仍能
 * 保持短语相邻性 ⇒ 词内子串查询照样成立(见 segmentQueryToken)。
 *
 * 为何不含 CJK 标点:标点在 unicode61 下本就是分隔符,不需要额外处理。
 */
const CJK_RE =
  /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]|[\u{20000}-\u{2A6DF}]/u;

/** 单字符是否是 CJK。 */
export function isCjkChar(ch: string): boolean {
  return CJK_RE.test(ch);
}

/** 文本里是否含 CJK(查询侧据此决定用短语还是前缀)。 */
export function hasCjk(text: string): boolean {
  return CJK_RE.test(text);
}

/** 去掉 ZWSP(展示侧 / 幂等重分词前用)。 */
export function stripZwsp(text: string): string {
  return text.replace(ZWSP_RE, '');
}

/**
 * 索引侧分词:在 CJK 字符之间、以及 CJK 与非 CJK 的边界插入 ZWSP。
 *
 * 幂等:先剥掉已有的 ZWSP 再切 ⇒ 对同一文本反复调用结果相同
 * (存量迁移 0009 依赖这一点:万一某行已被分词,重跑不会累积 ZWSP)。
 */
export function segmentCjk(text: string): string {
  if (!text) return '';
  const clean = stripZwsp(text);
  let out = '';
  let prevCjk = false;
  // for...of 按码点迭代 ⇒ 代理对(扩展 B 汉字)不会被拆成两半
  for (const ch of clean) {
    const c = isCjkChar(ch);
    if (out.length > 0 && (c || prevCjk)) out += ZWSP;
    out += ch;
    prevCjk = c;
  }
  return out;
}

/**
 * 查询侧分词:把一个查询 token 拆成 FTS5 短语的组成部分。
 *
 *   '学习'         → ['学', '习']         ⇒ 短语 "学 习"
 *   '机器学习'     → ['机', '器', '学', '习']
 *   'Attention机制' → ['Attention', '机', '制'] ⇒ 短语 "Attention 机 制"
 *
 * 非 CJK 连续片段整体保留为一个部分(它会被 FTS5 自己按 unicode61 切开,
 * 与索引侧的处理一致)。
 */
export function segmentQueryToken(token: string): string[] {
  const parts: string[] = [];
  let buf = '';
  for (const ch of token) {
    if (isCjkChar(ch)) {
      if (buf) {
        parts.push(buf);
        buf = '';
      }
      parts.push(ch);
    } else {
      buf += ch;
    }
  }
  if (buf) parts.push(buf);
  return parts;
}

/**
 * 按「文字系统」把 token 切成若干 run —— **连续的同族字符合成一个 run**。
 *
 *   'CNN模型'       → [{cjk:false, text:'CNN'}, {cjk:true, text:'模型'}]
 *   '模型'          → [{cjk:true, text:'模型'}]
 *   'Attention机制' → [{cjk:false, text:'Attention'}, {cjk:true, text:'机制'}]
 *
 * 与 segmentQueryToken 的分工:
 *   - segmentQueryToken 把**每个汉字**单独成一份 ⇒ 用来拼 FTS5 短语
 *     (短语要求逐字 token 相邻);
 *   - splitScriptRuns 把**连续汉字合成一个 run** ⇒ 用来判断一个 token
 *     是不是「混排」,以及混排时该按几个子句去查(r208)。
 */
export interface ScriptRun {
  /** run 是否由 CJK 字符组成(决定用短语还是前缀通配)。 */
  cjk: boolean;
  /** run 的原文(不含任何分隔符)。 */
  text: string;
}

export function splitScriptRuns(token: string): ScriptRun[] {
  const runs: ScriptRun[] = [];
  let text = '';
  let cjk = false;
  for (const ch of token) {
    const c = isCjkChar(ch);
    if (text && c !== cjk) {
      runs.push({ cjk, text });
      text = '';
    }
    cjk = c;
    text += ch;
  }
  if (text) runs.push({ cjk, text });
  return runs;
}

// ── 迁移层:把分词暴露成 SQL 函数 ───────────────────────────────────────
// 存量数据重分词需要「在 SQL 里调用 JS 分词」的能力(迁移 0009 的
// cjk_seg(title) / cjk_seg(body))。SQLite 的自定义函数必须由宿主注册,
// better-sqlite3 提供 db.function()。
//
// 注册时机:migrator.applyMigrations 开头(所有迁移跑之前)—— 0009 依赖它。
// 幂等:同一个 db 重复注册同名函数会抛错,故用 WeakSet 记住已注册的实例。

const registeredDbs = new WeakSet<object>();

/**
 * 注册迁移期需要的确定性 SQL 函数(cjk_seg)。
 *
 * - deterministic:true ⇒ SQLite 可缓存结果 / 允许在索引表达式里用;
 * - 参数可能是 NULL(列可空)⇒ 一律按空串处理,返回空串。
 */
export function registerMigrationFunctions(db: Database.Database): void {
  if (registeredDbs.has(db)) return;
  db.function('cjk_seg', { deterministic: true }, (v: unknown) =>
    segmentCjk(typeof v === 'string' ? v : ''),
  );
  registeredDbs.add(db);
}
