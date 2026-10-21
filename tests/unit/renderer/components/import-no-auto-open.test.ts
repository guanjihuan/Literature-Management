// tests/unit/renderer/components/import-no-auto-open.test.ts
//
// 守卫(r177):「导入文件后不应该马上自动打开」。
//
// 旧行为(notes 侧 audit-r22 引入的 macOS Finder 风格、literature 侧同款):
//   导入成功 → select(最后一条导入的资源) + setActive('notes'/'library')
//            + requestFocusNote(光标丢进 body)
// → 右侧面板被强制切到刚导入的文件,用户正在读的笔记/PDF 被顶掉,读一半
//   的内容被切走,还得再点回去。
//
// 期望契约:导入只做「落盘(必要时搬进当前文件夹)+ toast(+ 列表滚到新行)」,
// **不改变选中态、不切面板、不抢焦点**。要打开,用户自己点那一行。
//
// 本测是**源码契约 guard**:两个列表组件的 importFiles 回调体里不允许出现
//   select( / setActive( / requestFocusNote(
// 为什么用源码扫描而不是渲染组件测:
//   NotesList / LiteratureList 都依赖 react-virtuoso,jsdom 下容器高度为 0,
//   行根本不渲染 —— 渲染测测不到「点了导入之后有没有自动打开」这个行为,
//   只能退到源码契约。仓库里 layering / i18n-parity 同款做法。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();

/**
 * 从 `const importFiles = useCallback(` 起,做花括号配平,截出回调体文本。
 * 先剥掉注释(注释里可能有花括号),字符串字面量里的花括号在本仓库这两个
 * 回调里不存在(importFiles 的文案 key 都不带 '{}')。
 */
function extractCallbackBody(fileRel: string, marker: string): string {
  const src = readFileSync(join(ROOT, fileRel), 'utf8');
  const start = src.indexOf(marker);
  expect(start, `${fileRel} 里找不到 ${marker}`).toBeGreaterThan(-1);
  const open = src.indexOf('{', start);
  expect(open, `${fileRel} 里 ${marker} 之后没有 '{'`).toBeGreaterThan(-1);
  const stripped = src
    .slice(open)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  let depth = 0;
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return stripped.slice(0, i);
    }
  }
  throw new Error(`${fileRel}: ${marker} 的回调体花括号没配平,提取失败`);
}

const NOTES = 'src/renderer/src/components/notes/NotesList.tsx';
const LIT = 'src/renderer/src/components/literature/LiteratureList.tsx';

describe('导入后不自动打开(r177)', () => {
  it('notes 侧 importFiles 不 select / 不切面板 / 不抢焦点', () => {
    const body = extractCallbackBody(NOTES, 'const importFiles = useCallback(');
    expect(body).not.toMatch(/\bselect\(/);
    expect(body).not.toMatch(/\bsetActive\(/);
    expect(body).not.toMatch(/\brequestFocusNote\(/);
  });

  it('literature 侧 importFiles 不 select / 不切面板', () => {
    const body = extractCallbackBody(LIT, 'const importFiles = useCallback(');
    expect(body).not.toMatch(/\bselect\(/);
    expect(body).not.toMatch(/\bsetActive\(/);
    expect(body).not.toMatch(/\brequestFocusNote\(/);
  });

  it('notes 侧导入仍然落盘 + 仍搬进当前文件夹 + 仍出成功 toast', () => {
    const body = extractCallbackBody(NOTES, 'const importFiles = useCallback(');
    expect(body).toMatch(/\bimportFromFile\(/);
    expect(body).toMatch(/\bmoveToFolder\(/);
    expect(body).toMatch(/toast\.importSuccess/);
  });

  it('literature 侧导入仍然落盘 + 仍搬进当前文件夹 + 仍出成功 toast', () => {
    const body = extractCallbackBody(LIT, 'const importFiles = useCallback(');
    expect(body).toMatch(/\bimportFromFile\(/);
    expect(body).toMatch(/\bapi\.litMove\(/);
    expect(body).toMatch(/literature\.importSuccess/);
  });

  it('notes 侧仍把新行滚进视野(落点可见),但只是滚动不是选中', () => {
    const body = extractCallbackBody(NOTES, 'const importFiles = useCallback(');
    expect(body).toMatch(/scrollToIndex/);
  });
});
