// tests/unit/renderer/styles/scrollbar-standard-props-firefox-only.test.ts
//
// 行为锁(audit-r250,2026-10-21):globals.css 里 `scrollbar-color` /
// `scrollbar-width: thin` 这类**标准滚动条属性**只允许出现在
// `@supports (-moz-appearance: none)`(≈ Firefox-only)块里。
//
// 为什么:这两个属性一旦在祖先(html)上生效,就会**继承**到每个内部滚动
// 容器(侧栏列表 / 笔记编辑器 / Reader / 设置抽屉 / 搜索面板)。
// Chromium 的规则是:scrollbar-color 不是 auto 时,UA 改用「标准滚动条」
// 渲染并**忽略整套 ::-webkit-scrollbar 规则** —— 于是 r143 校准到 3:1 的
// --scrollbar-thumb-rgb 整套主题从来没生效,用户看到的是 Windows 原生
// 17px 滚动条(▲▼ 箭头 + 浅灰 thumb),暗色主题下尤其刺眼,还白占 9px 宽度。
//
// 实测(Chromium 124 / Electron 30,真机 CDP 探针):
//   scrollbar-color 继承中 → 滚动条 17px
//   scrollbar-color: auto   → 滚动条  8px(::-webkit-scrollbar 生效)
//
// 形态:源码字面解析(css-tree 不在 devDeps ⇒ 注释剥离 + 括号配平)。
// 注释先剥掉 ⇒ 本文件/globals.css 注释里出现 "scrollbar-color" 字样不会误判。
// 读文件走 process.cwd()(jsdom 环境下 fileURLToPath(import.meta.url) 不可靠,
// 见 r236 同族测试)。

import { readFileSync } from 'fs';
import { join } from 'path';

import { describe, expect, it } from 'vitest';

const FIREFOX_ONLY_HEADER = '@supports (-moz-appearance: none)';

/** 剥注释后的 globals.css 全文 */
function cssWithoutComments(): string {
  return readFileSync(join(process.cwd(), 'src/renderer/src/styles/globals.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
}

interface BlockRange {
  /** 块内容起止(含头不含尾),用于「某次出现是否落在块内」的区间判定 */
  start: number;
  end: number;
  body: string;
}

/** 按括号配平取出 `header` 之后那个块的正文;找不到返回 null */
function extractBlock(css: string, header: string): BlockRange | null {
  const headerIdx = css.indexOf(header);
  if (headerIdx < 0) return null;
  const open = css.indexOf('{', headerIdx + header.length);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return { start: open + 1, end: i, body: css.slice(open + 1, i) };
    }
  }
  return null;
}

/** 全文里某个 token 的所有出现位置 */
function occurrences(css: string, token: string): number[] {
  const out: number[] = [];
  let idx = css.indexOf(token);
  while (idx >= 0) {
    out.push(idx);
    idx = css.indexOf(token, idx + token.length);
  }
  return out;
}

describe('标准滚动条属性必须收在 Firefox-only 块里(r250 行为锁)', () => {
  const css = cssWithoutComments();

  it('Firefox-only 块存在,且带 scrollbar-color + scrollbar-width: thin', () => {
    const block = extractBlock(css, FIREFOX_ONLY_HEADER);
    expect(block, `globals.css 必须有 ${FIREFOX_ONLY_HEADER} 块承载标准滚动条属性`).not.toBeNull();
    expect(block?.body).toMatch(/scrollbar-color\s*:/);
    expect(block?.body).toMatch(/scrollbar-width\s*:\s*thin/);
  });

  it('任何 scrollbar-color 声明都落在 Firefox-only 块内(Chromium 不再被劫持)', () => {
    const block = extractBlock(css, FIREFOX_ONLY_HEADER);
    expect(block).not.toBeNull();
    const outside = occurrences(css, 'scrollbar-color').filter(
      (i) => i < block!.start || i >= block!.end,
    );
    expect(
      outside.length,
      'scrollbar-color 是可继承属性,漏在块外会继承到所有内部滚动容器,' +
        'Chromium 随即忽略 ::-webkit-scrollbar ⇒ 用户看到 Windows 原生滚动条',
    ).toBe(0);
  });

  it('任何 scrollbar-width: thin 声明都落在 Firefox-only 块内', () => {
    const block = extractBlock(css, FIREFOX_ONLY_HEADER);
    expect(block).not.toBeNull();
    const thinPositions = occurrences(css, 'scrollbar-width').filter((i) =>
      /scrollbar-width\s*:\s*thin/.test(css.slice(i, i + 40)),
    );
    const outside = thinPositions.filter((i) => i < block!.start || i >= block!.end);
    expect(outside.length, 'scrollbar-width: thin 落在块外同样会让 Chromium 走标准滚动条').toBe(0);
  });

  it('::-webkit-scrollbar 主题仍在(8px 细滚动条 + token 着色没被顺手删)', () => {
    // Chromium 下真正生效的就是这一套 —— 它被忽略等于主题全废
    expect(css).toMatch(/::-webkit-scrollbar\s*\{[^}]*width\s*:\s*8px/);
    expect(css).toMatch(
      /::-webkit-scrollbar-thumb\s*\{[^}]*background\s*:\s*rgb\(var\(--scrollbar-thumb-rgb\)\)/,
    );
    expect(css).toMatch(/--scrollbar-thumb-rgb\s*:/);
  });
});
