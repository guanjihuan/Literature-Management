// src/renderer/src/components/search/SearchSnippet.tsx
//
// r194:搜索结果片段的**高亮渲染**。
//
// 背景:主进程 FTS5 的 snippet() 产出的是「命中片段包在 <mark> / </mark>
// 里,其余是上下文」的字符串(标记常量见 shared/types.ts)。旧实现直接在
// 搜索结果行里渲染 `{hit.snippet}` —— React 把它当**纯文本**,于是用户
// 看到的预览是:
//
//   本文介绍<mark>学习</mark>模型的基...
//
// 即 <mark> 标签的字面量,而不是高亮。实测(r194)确认:命中行的第二行
// 就是这串带尖括号的原文。
//
// 修法(本组件):
//   1. 按标记把 snippet 切成「命中段 / 非命中段」;
//   2. 命中段渲染成真正的 <mark> 元素,非命中段作为文本节点。
//
// ⚠ 安全:片段正文来自**用户写的笔记内容 / 文件名**,所以绝不能用
//   dangerouslySetInnerHTML 直接注入(那等于把笔记正文当 HTML 执行)。
//   本组件只把**我们自己写死的**标记当结构,其余一律走 React 文本节点
//   (自动转义)⇒ 笔记里的 "<script>" 只会显示成字面量,不会执行。
//   副作用:笔记正文里若真写了 "<mark>" 字面量,会被当成高亮开始标记 ——
//   只影响显示(多一段高亮),不涉及执行,接受。
import { Fragment, useMemo } from 'react';
import { SEARCH_SNIPPET_MARK_CLOSE, SEARCH_SNIPPET_MARK_OPEN } from '@shared/types';

export interface SearchSnippetPart {
  /** 该段的纯文本(不含标记)。 */
  text: string;
  /** true = 命中段(渲染成 <mark>);false = 上下文段。 */
  hit: boolean;
}

/**
 * 把带 <mark> 标记的 snippet 切成分段。
 *
 * 边界处理(都按「不崩 + 不丢字」处理):
 *   - 没有标记 → 单个非命中段;
 *   - 只有开始标记 → 剩余全部算命中段;
 *   - 只有结束标记(正文里恰好写了 '</mark>')→ 当普通文本;
 *   - 空串 → 空数组。
 */
export function splitSearchSnippet(snippet: string): SearchSnippetPart[] {
  const parts: SearchSnippetPart[] = [];
  let rest = snippet;
  while (rest.length > 0) {
    const open = rest.indexOf(SEARCH_SNIPPET_MARK_OPEN);
    if (open < 0) {
      parts.push({ text: rest, hit: false });
      break;
    }
    if (open > 0) parts.push({ text: rest.slice(0, open), hit: false });
    const after = rest.slice(open + SEARCH_SNIPPET_MARK_OPEN.length);
    const close = after.indexOf(SEARCH_SNIPPET_MARK_CLOSE);
    if (close < 0) {
      // 没有结束标记 —— 剩余整段当命中(不丢内容)
      parts.push({ text: after, hit: true });
      break;
    }
    parts.push({ text: after.slice(0, close), hit: true });
    rest = after.slice(close + SEARCH_SNIPPET_MARK_CLOSE.length);
  }
  return parts;
}

export interface SearchSnippetProps {
  snippet: string;
  className?: string;
}

export function SearchSnippet({ snippet, className }: SearchSnippetProps) {
  const parts = useMemo(() => splitSearchSnippet(snippet), [snippet]);
  return (
    <div className={className}>
      {parts.map((p, i) =>
        p.hit ? (
          <mark key={i} className="rounded-sm bg-accent/30 text-fg">
            {p.text}
          </mark>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        ),
      )}
    </div>
  );
}
