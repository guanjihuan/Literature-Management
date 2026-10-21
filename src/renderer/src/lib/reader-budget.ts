// src/renderer/src/lib/reader-budget.ts
//
// perf r259:阅读器的「渲染预算」—— 大文件不许把渲染进程主线程堵死。
//
// ── 为什么要这个 ─────────────────────────────────────────────────────
//   阅读器的重管线(语法高亮 / markdown 渲染 + HTML 净化)全是**同步**的,
//   跑在 renderer 主线程上。本轮实测(2026-10-21,bench 见 commit 正文):
//
//     代码文件  1.2MB → hljs.highlight 256ms + 净化 48ms
//              6.1MB → 1200ms + 292ms
//             12.3MB → 3191ms + 592ms(净化后 HTML 57.8MB!)
//     markdown  2.8MB → md.render 450ms + 净化 905ms
//              5.6MB → 889ms + 1943ms
//
//   main 侧阅读器上限 READER_MAX_SIZE_BYTES = 10MB ⇒ 这些量级**用户真能
//   碰到**(大日志 / 数据集 / 长源码 / 抓取的网页存档)。Chromium 主线程被
//   堵 3~5 秒 ⇒ 整个窗口「未响应」—— 用户诉求「使用流畅,不要有卡顿」在
//   这条路径上完全落空(而且是**打开文件**这种最常见的动作)。
//
// ── 修法(不是截断,是**降级**)────────────────────────────────────────
//   预算内的部分照常走重管线;超出的部分**退化为纯文本**:
//     · 代码文件:超预算部分不再高亮(但仍是完整可读文本);
//     · markdown:超预算部分不再排版(以 <pre> 纯文本呈现)。
//   ⇒ **内容一字不丢**(head + tail === 原文),只是超出部分没有高亮 /
//   没有排版。DOM 侧也从「57.8MB 的标签树」降到「1.2MB 标签 + 一段纯文本」。
//
// ── 为什么不搬到 Web Worker ─────────────────────────────────────────
//   Worker 能把同步段挪出主线程(不卡 UI),但**总 CPU 不变**(还是几秒),
//   而且 57.8MB 的 HTML 仍要进 DOM(解析 + 布局照样在主线程)。预算方案
//   同时压掉「同步段」与「DOM 体积」两笔账,代价小得多。
//
// ── 截断点落在**行边界** ─────────────────────────────────────────────
//   向前找最近的换行切分,免得把一行劈成两半(半行高亮 + 半行纯文本,
//   视觉上像坏掉了)。找不到换行(超长单行)才硬切。

/**
 * 代码文件的语法高亮预算(字符数)。
 *
 * 取 256K 字符的依据(实测):hljs.highlight 对 ~113KB 约 39ms、对 ~1.2MB
 * 约 256ms ⇒ 256KB 落在 **~60ms** 量级;再往上就是线性涨,不值当。
 * 字符数而非字节数:切分要在 JS 字符串上做(UTF-16 code unit),字节数
 * 还得先算编码,收益不抵复杂度;CJK 在字符串里占 1 个 char(UTF-16 里
 * 常用字是 1 个 unit),与 ASCII 的成本差异可忽略。
 */
export const READER_HIGHLIGHT_BUDGET_CHARS = 256 * 1024;

/**
 * markdown 渲染预算(字符数)。
 *
 * 实测 md.render ~533KB ≈ 99ms、净化 ≈ 195ms ⇒ 256KB 落在 ~150ms 量级。
 * 比高亮预算更保守:markdown 的净化成本(逐标签正则)比高亮产物更高。
 */
export const READER_MARKDOWN_BUDGET_CHARS = 256 * 1024;

export interface ReaderBudgetSplit {
  /** 走重管线的部分(高亮 / markdown 渲染)。 */
  head: string;
  /** 退化为纯文本的部分(**内容完整**,不是丢弃)。 */
  tail: string;
  /** 是否发生了降级(tail 非空即为 true)。 */
  truncated: boolean;
  /** head 的字符数(给 UI 报「渲染了多少」用)。 */
  headChars: number;
}

/**
 * 按预算切分文本。
 *
 * 不变量(本文件的核心契约,守卫见
 * tests/unit/renderer/reader/reader-budget.test.tsx):
 *   ① `head + tail === text` —— **内容零丢失**;
 *   ② 未超预算时 `tail === ''` 且 `truncated === false`;
 *   ③ 超预算时切点落在行边界(head 以换行结尾,除非整段没有换行)。
 */
export function splitByBudget(text: string, budget: number): ReaderBudgetSplit {
  if (budget <= 0 || text.length <= budget) {
    return { head: text, tail: '', truncated: false, headChars: text.length };
  }
  // 向前找最近的换行(在 [1, budget] 区间内);找不到就硬切在 budget。
  // 切点取「换行符之后」⇒ head 以换行结尾(一行不会被劈成两半),且
  // head.length <= budget(lastIndexOf 从 budget-1 起找,保证 +1 不越界)。
  const nl = text.lastIndexOf('\n', budget - 1);
  const cut = nl > 0 ? nl + 1 : budget;
  return {
    head: text.slice(0, cut),
    tail: text.slice(cut),
    truncated: true,
    headChars: cut,
  };
}
