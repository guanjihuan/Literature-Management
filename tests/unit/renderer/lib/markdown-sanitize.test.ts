// tests/unit/renderer/lib/markdown-sanitize.test.ts
//
// 守 r197「净化器不许吃正文」契约。
//
// 背景(用户可见症状):markdown-it 配 `html: false` ⇒ 用户正文里的 '<'
//   被转义成 '&lt;' ⇒ **正文中的 'onclick=alert(1)' 落在文本节点里,不是属性**。
//   旧实现却对**整串 HTML** 跑 `on[a-z]+\s*=\s*...` 正则,不看自己在不在标签
//   内部 ⇒ 文本节点里的 "onclick=alert(1)" 被当事件属性**删掉**。
//
//   实锤(旧实现):
//     输入 `<code>onclick=alert(1)</code>` → 输出 `<code></code>`
//     —— 代码片段凭空消失,读者看到的是「代码被清空了」。
//
//   更糟的是 CodeReader:hljs 输出的 `<span class="hljs-attr">` 与用户代码里
//   的 "style = {" 撞上,style 正则把 hljs 自己的 <span 标签吃掉 ⇒
//   高亮结构被破坏(用户看到裸的 class="hljs-attr">a)。
//
// 本测锁的契约:
//   1. **文本节点原样保留**(标签外的 on*/style 一律不动);
//   2. **标签内部**的 on* / style 属性仍被剥除(defense-in-depth 不能松);
//   3. <a href> 危险 scheme 仍替换为 about:blank;
//   4. isSafeHref 对 C0 控制字符前缀的 javascript: 判定为 false。
import { describe, expect, it } from 'vitest';
import { isSafeHref, sanitizeMarkdownHtml } from '../../../../src/renderer/src/lib/markdown-html-sanitize';

describe('sanitizeMarkdownHtml(r197)', () => {
  it('正文里的 onclick=…(文本节点)必须原样保留 —— 旧实现整串正则把它删了', () => {
    const html = '<p>调用 <code>onclick=alert(1)</code> 触发</p>';
    const out = sanitizeMarkdownHtml(html);
    expect(out).toContain('onclick=alert(1)');
  });

  it('正文里的 onerror=… / style="…" 也必须保留(不在标签内 ⇒ 不是属性)', () => {
    const out = sanitizeMarkdownHtml('<p>文本 onerror=boom 结尾</p>');
    expect(out).toContain('onerror=boom');
    const out2 = sanitizeMarkdownHtml('<p>属性 style="color:red" 出现</p>');
    expect(out2).toContain('style="color:red"');
  });

  it('CodeReader 场景:hljs 的 span 标签不得被 style 正则吃掉', () => {
    const html =
      '<span class="hljs-keyword">const</span> style = {<span class="hljs-attr">a</span>:1};';
    const out = sanitizeMarkdownHtml(html);
    expect(out).toContain('<span class="hljs-attr">a</span>');
    expect(out).toContain('const');
  });

  it('标签内部的 on* 事件属性仍被剥除(defense-in-depth 不松)', () => {
    const out = sanitizeMarkdownHtml('<img src="x.png" onerror="alert(1)">');
    expect(out).not.toContain('onerror');
    expect(out).toContain('src="x.png"');
  });

  it('标签内部的 style 属性仍被剥除', () => {
    const out = sanitizeMarkdownHtml('<p style="background:url(javascript:alert(1))">x</p>');
    expect(out).not.toContain('style=');
    expect(out).toContain('>x</p>');
  });

  it('<a href> 危险 scheme 仍替换为 about:blank', () => {
    const out = sanitizeMarkdownHtml('<a href="javascript:alert(1)">点我</a>');
    expect(out).toContain('about:blank');
    expect(out).not.toContain('javascript:');
  });

  it('<a href> 正常 http(s) 链接不受影响', () => {
    const out = sanitizeMarkdownHtml('<a href="https://example.com/a">链接</a>');
    expect(out).toContain('https://example.com/a');
  });

  it('空串 / 无 tag 的纯文本原样返回', () => {
    expect(sanitizeMarkdownHtml('')).toBe('');
    expect(sanitizeMarkdownHtml('普通文本')).toBe('普通文本');
  });
});

describe('isSafeHref(r197)', () => {
  it('C0 控制字符前缀的 javascript: 必须判为不安全', () => {
    // WHATWG URL 解析会先删掉所有前导 C0 控制符 ⇒ '\x01javascript:' 的
    // protocol 仍是 'javascript:'。旧实现只删 \t\n\r ⇒ 漏判。
    expect(isSafeHref('\x01javascript:alert(1)')).toBe(false);
    expect(isSafeHref('\x08javascript:alert(1)')).toBe(false);
    expect(isSafeHref('\x0bjavascript:alert(1)')).toBe(false);
  });

  it('常规 http(s) / mailto / 相对路径仍安全', () => {
    expect(isSafeHref('https://example.com')).toBe(true);
    expect(isSafeHref('mailto:a@b.com')).toBe(true);
    expect(isSafeHref('#anchor')).toBe(true);
    expect(isSafeHref('notes/a.md')).toBe(true);
  });

  it('javascript: / data:text/html / file: 仍判为不安全', () => {
    expect(isSafeHref('javascript:alert(1)')).toBe(false);
    expect(isSafeHref('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isSafeHref('file:///C:/Windows/System32')).toBe(false);
  });
});
