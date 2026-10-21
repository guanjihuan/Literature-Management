// tests/unit/renderer/styles/no-html-scrollbar-gutter.test.ts
//
// 行为锁(audit-r237,2026-10-20):globals.css 里**任何命中 html 元素的规则**
// (html / html.xxx / :root / :root[...] 等)都不得带 scrollbar-gutter 声明。
//
//   audit-r145c 给 html 加了 scrollbar-gutter: stable,想治「列表出现/收起
//   滚动条时内容跳 8px」。但本 app 文档流根本不滚动(App 根节点
//   `h-screen … overflow-hidden`,所有滚动都在内部面板),stable 在 html 上
//   = 永久预留一条右侧死白条(实测 1440px 窗口只排版到 1429px,用户报
//   「窗口关闭按钮右边一条窄空白」)。r145c 的跳变属于内部滚动容器,要治
//   也得加在真正滚动的元素上。
//
// 形态:源码字面解析(css-tree 不在 devDeps,用注释剥离 + 最内层块正则)。
// 注释先剥掉 ⇒ 本文件/globals.css 注释里出现 "scrollbar-gutter" 字样不会误判。
// 读文件走 process.cwd()(jsdom 环境下 fileURLToPath(import.meta.url) 不可靠,
// 见 r236 同族测试)。

import { readFileSync } from 'fs';
import { join } from 'path';

import { describe, expect, it } from 'vitest';

/** 剥注释后的 globals.css 全文 */
function cssWithoutComments(): string {
  return readFileSync(join(process.cwd(), 'src/renderer/src/styles/globals.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
}

interface CssRule {
  selector: string;
  body: string;
}

/**
 * 提取所有**最内层**规则块。@layer / @media 等嵌套 at-rule 的头部
 * (`... {` 后紧跟的内容含 `{`)正则匹配不上会被自然跳过,只留下叶子规则。
 */
function leafRules(css: string): CssRule[] {
  const out: CssRule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    out.push({ selector: m[1].trim(), body: m[2] });
  }
  return out;
}

/** 选择器逗号拆段后,任一段命中 html 元素本体:html / html.light / :root / :root[...] */
function hitsHtmlElement(selector: string): boolean {
  return selector
    .split(',')
    .some((part) => /^(?:html|:root)(?:[.#[:]|$)/.test(part.trim()));
}

describe('html 不得带 scrollbar-gutter(r237 行为锁)', () => {
  const rules = leafRules(cssWithoutComments());

  it('能解析出 html 的 scrollbar 着色规则(解析器没瞎、r143c 着色未被顺手删)', () => {
    const htmlRules = rules.filter((r) => hitsHtmlElement(r.selector));
    expect(htmlRules.length).toBeGreaterThan(0);
    expect(htmlRules.some((r) => /scrollbar-color\s*:/.test(r.body))).toBe(true);
  });

  it('没有任何命中 html 元素的规则声明 scrollbar-gutter(右侧死白条不复发)', () => {
    const offenders = rules.filter(
      (r) => hitsHtmlElement(r.selector) && /scrollbar-gutter\s*:/.test(r.body),
    );
    expect(
      offenders.map((o) => o.selector),
      'html/:root 上的 scrollbar-gutter 会在不滚动的文档流上永久预留死白条;r145c 的跳变要治请加到真正滚动的内部元素',
    ).toEqual([]);
  });
});
