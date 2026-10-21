// src/main/utils/frontmatter.ts — gray-matter 类型适配 helper
//
// audit C3R51 (2026-08-22):散落在多个文件的 `matter.stringify(body, fm)` 调用
// 都各自写 `fm as unknown as Record<string, unknown>` / `fm as Record<string,
// unknown>` / `fm as Parameters<typeof matter.stringify>[1]` / `as unknown as
// Parameters<typeof matter.stringify>[1]` 的类型断言。
// audit 2026-09 (V1.9):原注释提 "5 个文件的 8 处" + "collections/storage.ts:133
//   的 inline cast" —— collections 模块 2026-08-29 整体并入 favorites,
//   collections/storage.ts 文件已删除,具体行号失去锚点;实际 inline cast 散落
//   数取决于 V1.6 时的代码快照,不再给出精确数字。保留 cast 类型列表(仍是
//   完整的 4 种变体),具体排查交给后续 caller。
//
// 根因:gray-matter 的 `data` 参数类型是 `Record<string, any> | null | undefined`,
// 我们 typed 的 frontmatter 结构(struct)不能直接赋给 `Record<string, any>`
// —— TS 严格模式下 `unknown` 不流到 `any`(any 是 bivariant,unknown 是 top,
// 两者在 v4.0+ 分离)。所以需要 cast,但 cast 写一遍就够,集中在一个 helper 里
// 让 caller 看到的是"我要把 typed fm 喂给 gray-matter"的语义,而不是一行长类型
// 表达式干扰阅读。
//
// 用法:
//   import { asFrontmatter } from '../utils/frontmatter';
//   return matter.stringify(body, asFrontmatter(fm));
import matter from 'gray-matter';
// audit round 10 (2026-09-15):L2 — MAX_NOTE_TITLE_CHARS 共享自 path-limits.ts,
//   单一来源 (写路径 IPC 入口 + 读路径 frontmatter.cleanTitle 共用同一份)。
//   本文件此前声明 MAX_TITLE_CHARS = 200 与 IPC 入口 MAX_NOTE_TITLE_CHARS = 200
//   平行写,值漂移风险。这里不 import-as 别名,直接引用 path-limits 名字,
//   与 IPC 入口命名一致。
import { MAX_NOTE_TITLE_CHARS } from '../ipc/path-limits';

/**
 * Adapt a typed frontmatter struct to gray-matter's loose Record<string, any> contract.
 *
 * gray-matter's `stringify(content, data?)` accepts `Record<string, any> | null | undefined`.
 * Our typed frontmatter interfaces (e.g. `CollectionFrontmatter`, `RecentFm`,
 * `TrashFm`, `AIFrontmatter`, `NoteFrontmatter`) are closed-shape structs that
 * TypeScript can't structurally assign to `Record<string, any>` because `unknown`
 * is the top type but doesn't flow into `any` under strict checks.
 *
 * This helper centralizes the `as Parameters<typeof matter.stringify>[1]` cast
 * (the most precise form, matching the actual signature) so call sites read as:
 *   matter.stringify(body, asFrontmatter(fm))
 * instead of:
 *   matter.stringify(body, fm as unknown as Record<string, unknown>)
 *
 * Pure cast — no runtime transformation. `matter.stringify` then walks the
 * object normally via its own reflection.
 */
export function asFrontmatter<T extends object>(fm: T): Parameters<typeof matter.stringify>[1] {
  return fm as Parameters<typeof matter.stringify>[1];
}

/**
 * 把 frontmatter.tags(raw unknown)清洗成 string[] / null。
 *
 * audit round 8 (2026-09-14):3 处 verbatim `(fm['tags'] as unknown[]).filter(
 * (x): x is string => typeof x === 'string')` 模板散落在 standalone.ts:
 * 199-201 + 246-248 和 notes/import.ts:99-101。每个都自己 cast + filter
 * + type guard,任何一处漂移(忘了 typeof 守卫 / 把 filter 改成 map)
 * 只能 grep 兜底。
 *
 * 集中后:callsite 只关心 "我想要 string[]",helper 内部把 Array.isArray
 * 守卫 + filter + typeof 守卫统一包好。返回 null 让 callsite 自由决定
 * "无 tag" vs "空 tag"的语义(standalone 把它当作空数组传下去,
 * import.ts 把它当作 undefined 跳过)。
 *
 * audit round 9 (2026-09-15):MAX_TAGS_PER_NOTE 上限 —— 攻击者 / 误操作放
 *   一个 100k tag 数组的 .md 进 workspace,scan + list 时 array.map → React
 *   render 会让 UI 卡顿 / 主进程堆吃紧。50 是经验值(普通笔记 tag 数 < 20),
 *   超长截断,多出来的 tag 静默丢弃 —— frontmatter 是用户数据,不能 throw
 *   让一条笔记全不可用。
 */
const MAX_TAGS_PER_NOTE = 50;
// 单 tag 字符串上限 —— 防止单 tag 几百 KB 把 UI 撑爆(reason: tag 通常作为
// chip 渲染,极长字符串会让布局破裂 + 滚动卡顿)。
const MAX_TAG_CHARS = 64;

export function cleanTags(fm: Record<string, unknown>): string[] | null {
  if (!Array.isArray(fm['tags'])) return null;
  const raw = fm['tags'] as unknown[];
  const out: string[] = [];
  for (let i = 0; i < raw.length && out.length < MAX_TAGS_PER_NOTE; i++) {
    const t = raw[i];
    if (typeof t !== 'string') continue;
    // 截断单 tag,并**丢掉 trailing 半字符**(surrogate pair 边界)。
    //
    // audit 2026-10-01:此前注释描述的「回退到完整字符」根本没实现,代码是纯
    //   `slice(0, MAX_TAG_CHARS)`。JS 字符串按 UTF-16 code unit 计数,一个
    //   emoji / 增补平面字符占 2 个 unit,切在中间会留下孤立的高位 surrogate
    //   —— 写进 markdown 时 UTF-8 编码 lone surrogate 变成 U+FFFD(乱码),
    //   经 JSON.stringify 则是 "\ud83d"。tag 恰好跨过第 64 字符边界就会命中。
    out.push(dropLoneSurrogateTail(t, MAX_TAG_CHARS));
  }
  return out;
}

/**
 * 按 maxChars 截断字符串,并保证不以半个 surrogate pair 结尾。
 *
 * 判据:截断后最后一个 code unit 若落在高位 surrogate 区(0xD800–0xDBFF),
 * 说明它需要一个低位 surrogate(0xDC00–0xDFFF)配对才完整,而那个低位部分
 * 已被切掉 —— 丢掉它,字符串末尾就是一个孤立高位 surrogate。
 */
function dropLoneSurrogateTail(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  const cut = s.slice(0, maxChars);
  const last = cut.charCodeAt(cut.length - 1);
  const isHighSurrogate = last >= 0xd800 && last <= 0xdbff;
  return isHighSurrogate ? cut.slice(0, -1) : cut;
}

/**
 * frontmatter.title 字符串上限 —— DoS 防御 + UI 布局保护。
 *
 * audit round 10 (2026-09-15):L2 — 本函数使用 path-limits.ts 的共享常量
 *   MAX_NOTE_TITLE_CHARS(写路径 IPC 入口 + 读路径 frontmatter.cleanTitle 共用)。
 *   历史注释里 "200 字符与 NOTES_WRITE 入口 MAX_NOTE_TITLE_CHARS = 200 对齐"
 *   隐含的两份平行常量已合并为一份。
 *
 * 返回 string | null:null = 无标题。audit-r222:空串 / 纯空白也归一为
 *   null —— 写路径(writeNote `title.trim() || undefined`)本就写不出空
 *   title,只有外部手改 frontmatter 能造出来;返回 '' 会让所有 `?? 兜底`
 *   失效('' 不是 null):列表空标题、DB 空 title、搜索命中空标题。
 */
export function cleanTitle(fm: Record<string, unknown>): string | null {
  const t = fm['title'];
  if (typeof t !== 'string') return null;
  if (t.trim() === '') return null;
  // audit 2026-10-01:与 cleanTags 同款 surrogate 截断修复 —— 中文标题里混
  //   emoji(「🔥 实验记录」类)在 200 字符边界被切开同样会产生乱码。
  return dropLoneSurrogateTail(t, MAX_NOTE_TITLE_CHARS);
}
