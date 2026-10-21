// tests/unit/renderer/components/sidebar-op-parity.test.ts
//
// 守用户诉求「左侧的文献和笔记列表 … 相关的文件操作也是对应的」——
//   两个侧栏的**文件行右键菜单**必须提供同一组操作。
//
// 旧状态(实测):笔记行有 rename / cut / copy / paste / showInFolder / trash,
//   文献行只有 cut / copy / paste / showInFolder / delete —— **没有重命名**。
//   用户视角:笔记能右键改名,文献不能;想在文献上改名只能去资源管理器,
//   改完 app 里还是旧名(两侧行为不对应)。
//
// r187 给文献域补上 rename(literature:rename-file 通道 + 服务层 + 弹窗),
//   本测把「两侧操作集相同」这条契约锁住 —— 以后任一侧删/加操作都会红。
//
// 为什么用源码扫描而不是渲染测:
//   NotesList / LiteratureList 都依赖 react-virtuoso,jsdom 下容器高度为 0,
//   行根本不渲染(同 import-no-auto-open.test.ts 的理由),右键菜单更是
//   交互后才出现 ⇒ 退到源码契约。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();

const NOTES = 'src/renderer/src/components/notes/NotesList.tsx';
const LIT = 'src/renderer/src/components/literature/LiteratureList.tsx';

/**
 * 抽出 `const menuItems = useMemo<ContextMenuItem[]>(() => { ... })` 的
 * 回调体文本(花括号配平;先剥注释避免注释里的花括号干扰配平)。
 */
function extractMenuItemsBody(fileRel: string): string {
  const src = readFileSync(join(ROOT, fileRel), 'utf8');
  const marker = 'const menuItems = useMemo<ContextMenuItem[]>(() => {';
  const start = src.indexOf(marker);
  expect(start, `${fileRel} 里找不到 ${marker}`).toBeGreaterThan(-1);
  const open = src.indexOf('{', start);
  const stripped = src
    .slice(open)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  let depth = 0;
  for (let i = 0; i < stripped.length; i += 1) {
    const ch = stripped[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return stripped.slice(0, i);
    }
  }
  throw new Error(`${fileRel}: menuItems 回调体花括号没配平`);
}

/** 收集回调体里的菜单项 id(只取 `id: 'xxx'` 形态的字面量)。 */
function menuItemIds(body: string): string[] {
  const out: string[] = [];
  const re = /\bid:\s*'([a-zA-Z0-9_-]+)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    out.push(m[1]!);
  }
  return out;
}

/** 两侧的语义对齐表:notes 的 'trash' 与 literature 的 'delete' 是同一件事
 *  (都把文件移进系统回收站),归一到 'delete' 再比。 */
const ALIAS: Record<string, string> = { trash: 'delete' };

function normalizedSet(fileRel: string): Set<string> {
  const ids = menuItemIds(extractMenuItemsBody(fileRel));
  return new Set(ids.filter((id) => id !== 'sep1' && id !== 'sep2').map((id) => ALIAS[id] ?? id));
}

describe('两侧栏文件行操作集对应(r187)', () => {
  it('文献行菜单与笔记行菜单提供同一组操作', () => {
    const notes = normalizedSet(NOTES);
    const lit = normalizedSet(LIT);
    // 双方都必须有的操作
    for (const op of ['rename', 'cut', 'copy', 'paste', 'showInFolder', 'delete']) {
      expect(notes.has(op), `notes 侧缺「${op}」`).toBe(true);
      expect(lit.has(op), `literature 侧缺「${op}」`).toBe(true);
    }
    // 且不许出现「只有一侧有」的操作(两侧集合完全相等)
    const onlyNotes = [...notes].filter((op) => !lit.has(op));
    const onlyLit = [...lit].filter((op) => !notes.has(op));
    expect({ onlyNotes, onlyLit }).toEqual({ onlyNotes: [], onlyLit: [] });
  });

  it('文献侧重命名真的接到了 store.renameFile(不是空壳菜单项)', () => {
    const src = readFileSync(join(ROOT, LIT), 'utf8');
    // store 取用
    expect(src).toMatch(/useLiteratureStore\(\(s\) => s\.renameFile\)/);
    // 菜单项回调真的调 openRename
    const body = extractMenuItemsBody(LIT);
    expect(body).toMatch(/id:\s*'rename'/);
    expect(body).toMatch(/openRename\(/);
    // openRename 真的调 store 的 renameFile
    expect(src).toMatch(/await renameFile\(/);
  });
});
