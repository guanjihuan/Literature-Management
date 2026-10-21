// tests/unit/renderer/lib/folder-tree.test.ts
//
// 守 r176「左侧栏改树状」的行合成契约。
//
// 树行合成是纯函数(无 IO / 无 React)—— 放在 lib/folder-tree.ts,本测
// 直接单测,不必起 renderer。锁的契约:
//
//  1. 顺序:同目录下**文件夹 → input 行 → 文件**(VS Code 资源管理器同款);
//  2. 折叠的文件夹不递归,展开的才把子树插在它下面;
//  3. depth 从 0 起,子节点 = 父 + 1;
//  4. aria-posinset / aria-setsize 按**同级**算(不是全局序号);
//  5. 搜索态:扁平返回命中项,不渲染文件夹行;
//  6. 落点标记 isTarget 只打在 targetRelPath 那一个文件夹行上;
//  7. 树键盘辅助:← 找父文件夹行、→ 找第一个子行。
//
// 这套契约锁死了「树」与「钻入式列表」的本质差别 —— 钻入式只需要
// 「当前目录的一层」,树需要层级、展开态、落点三者同时正确。
import { describe, expect, it } from 'vitest';
import {
  buildTreeRows,
  findFirstChildRow,
  findParentFolderRow,
  groupItemsByDir,
  NEW_FOLDER_ROW_ID,
  type TreeFolderRow,
  type TreeRow,
} from '../../../../src/renderer/src/lib/folder-tree';
import type { DiskFolderNode } from '../../../../src/shared/types';

function node(relPath: string, parentRelPath: string | null): DiskFolderNode {
  return {
    relPath,
    name: relPath.slice(relPath.lastIndexOf('/') + 1),
    parentRelPath,
  };
}

interface Item {
  id: string;
  relPath: string;
}

const ITEMS: Item[] = [
  { id: 'f1', relPath: 'top.md' },
  { id: 'f2', relPath: 'a/one.md' },
  { id: 'f3', relPath: 'a/b/two.md' },
  { id: 'f4', relPath: 'a/b/three.md' },
  { id: 'f5', relPath: 'z.md' },
];

// 磁盘形状:
//   root
//   ├── a
//   │   ├── one.md
//   │   └── b
//   │       ├── two.md
//   │       └── three.md
//   ├── top.md
//   └── z.md
const CHILDREN = new Map<string, DiskFolderNode[]>([
  ['', [node('a', null)]],
  ['a', [node('a/b', 'a')]],
  ['a/b', []],
]);

function rows(opts: {
  expanded?: string[];
  targetRelPath?: string | null;
  pendingInput?: { parentRelPath: string | null } | null;
  searchActive?: boolean;
}): TreeRow<Item>[] {
  return buildTreeRows<Item>({
    childrenByDir: CHILDREN,
    itemsByDir: groupItemsByDir(ITEMS),
    expanded: new Set(opts.expanded ?? []),
    targetRelPath: opts.targetRelPath ?? null,
    searchActive: opts.searchActive ?? false,
    searchItems: opts.searchActive ? ITEMS : undefined,
    pendingInput: opts.pendingInput ?? null,
  });
}

/** 取某个文件夹行(找不到 / 不是文件夹行 → 直接 fail,免得断言被 any 吞掉)。 */
function folderRow(r: readonly TreeRow<Item>[], id: string): TreeFolderRow {
  const hit = r.find((x) => x.id === id);
  if (!hit || hit.rowType !== 'folder') throw new Error(`not a folder row: ${id}`);
  return hit;
}

describe('buildTreeRows —— 树行合成(r176)', () => {
  it('折叠:只出根层文件夹 + 根层文件(子目录内容不露头)', () => {
    const r = rows({});
    expect(r.map((x) => x.id)).toEqual(['folder:a', 'f1', 'f5']);
  });

  it('展开:子行紧跟在父文件夹行下面,depth 递增', () => {
    const r = rows({ expanded: ['a'] });
    // a 展开后:它的子文件夹 a/b 在前,a 直属的 one.md 在后(文件夹在前)
    expect(r.map((x) => x.id)).toEqual(['folder:a', 'folder:a/b', 'f2', 'f1', 'f5']);
    const byId = new Map(r.map((x) => [x.id, x]));
    expect(byId.get('folder:a')?.depth).toBe(0);
    expect(byId.get('f2')?.depth).toBe(1);
    expect(byId.get('folder:a/b')?.depth).toBe(1);
  });

  it('两层全展开:三层 depth = 0 / 1 / 2', () => {
    const r = rows({ expanded: ['a', 'a/b'] });
    expect(r.map((x) => x.id)).toEqual([
      'folder:a',
      'folder:a/b',
      'f3',
      'f4',
      'f2',
      'f1',
      'f5',
    ]);
    const byId = new Map(r.map((x) => [x.id, x]));
    expect(byId.get('folder:a')?.depth).toBe(0);
    expect(byId.get('folder:a/b')?.depth).toBe(1);
    expect(byId.get('f3')?.depth).toBe(2);
    expect(byId.get('f4')?.depth).toBe(2);
  });

  it('顺序:同目录下文件夹在前、文件在后', () => {
    const r = rows({ expanded: ['a', 'a/b'] });
    const ids = r.map((x) => x.id);
    expect(ids.indexOf('folder:a')).toBeLessThan(ids.indexOf('f1'));
    expect(ids.indexOf('folder:a/b')).toBeLessThan(ids.indexOf('f2'));
  });

  it('aria-posinset / aria-setsize 按同级算(不是全局序号)', () => {
    const r = rows({ expanded: ['a'] });
    const byId = new Map(r.map((x) => [x.id, x]));
    // 根层:文件夹 a + 文件 top.md + 文件 z.md = 3 个兄弟
    expect(byId.get('folder:a')?.posInSet).toBe(1);
    expect(byId.get('folder:a')?.setSize).toBe(3);
    expect(byId.get('f1')?.posInSet).toBe(2);
    expect(byId.get('f5')?.posInSet).toBe(3);
    // a 目录里:子文件夹 b + 文件 one.md = 2 个兄弟(文件夹在前)
    expect(byId.get('folder:a/b')?.posInSet).toBe(1);
    expect(byId.get('folder:a/b')?.setSize).toBe(2);
    expect(byId.get('f2')?.posInSet).toBe(2);
    expect(byId.get('f2')?.setSize).toBe(2);
  });

  it('搜索态:扁平返回命中项,不渲染文件夹行', () => {
    const r = rows({ searchActive: true });
    expect(r.map((x) => x.id)).toEqual(['f1', 'f2', 'f3', 'f4', 'f5']);
    expect(r.every((x) => x.rowType === 'item')).toBe(true);
    expect(r.every((x) => x.depth === 0)).toBe(true);
  });

  it('落点标记只打在 targetRelPath 那一个文件夹行上', () => {
    const r = rows({ expanded: ['a'], targetRelPath: 'a/b' });
    expect(folderRow(r, 'folder:a/b').isTarget).toBe(true);
    expect(folderRow(r, 'folder:a').isTarget).toBe(false);
  });

  it('inline input 行挂在目标目录下、文件夹之后文件之前', () => {
    const r = rows({ expanded: ['a'], pendingInput: { parentRelPath: 'a' } });
    const ids = r.map((x) => x.id);
    expect(ids).toContain(NEW_FOLDER_ROW_ID);
    // a 目录的集合 = 子文件夹 b + input + 文件 one.md
    const byId = new Map(r.map((x) => [x.id, x]));
    expect(byId.get(NEW_FOLDER_ROW_ID)?.depth).toBe(1);
    expect(byId.get(NEW_FOLDER_ROW_ID)?.setSize).toBe(3);
    expect(byId.get(NEW_FOLDER_ROW_ID)?.posInSet).toBe(2);
    expect(ids.indexOf('folder:a/b')).toBeLessThan(ids.indexOf(NEW_FOLDER_ROW_ID));
    expect(ids.indexOf(NEW_FOLDER_ROW_ID)).toBeLessThan(ids.indexOf('f2'));
  });

  it('在**根目录**新建文件夹时 input 行也要渲染(parentRelPath = null)', () => {
    // r176 初版把「根目录」和「没有 pendingInput」都归一成 null,
    // 于是根目录建夹的 input 行永远不渲染(点 ✚ 什么都不发生)。
    const r = rows({ pendingInput: { parentRelPath: null } });
    const input = r.find((x) => x.rowType === 'input');
    expect(input).toBeDefined();
    expect(input?.id).toBe(NEW_FOLDER_ROW_ID);
    expect(input?.depth).toBe(0);
  });

  it('NEW_FOLDER_ROW_ID 不与真名为 "new" 的文件夹撞 id', () => {
    const children = new Map<string, DiskFolderNode[]>([['', [node('new', null)]]]);
    const r = buildTreeRows<Item>({
      childrenByDir: children,
      itemsByDir: groupItemsByDir([]),
      expanded: new Set(),
      targetRelPath: null,
      searchActive: false,
      pendingInput: { parentRelPath: null },
    });
    const ids = r.map((x) => x.id);
    expect(ids).toContain('folder:new');
    expect(ids).toContain(NEW_FOLDER_ROW_ID);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('hasChildren:未加载的目录乐观为 true(画 chevron),已加载的空目录为 false', () => {
    const children = new Map<string, DiskFolderNode[]>([
      ['', [node('empty', null), node('unknown', null)]],
      ['empty', []],
    ]);
    const r = buildTreeRows<Item>({
      childrenByDir: children,
      itemsByDir: groupItemsByDir([]),
      expanded: new Set(),
      targetRelPath: null,
      searchActive: false,
    });
    // empty 已 listDirs 过且为空 → 不画 chevron
    expect(folderRow(r, 'folder:empty').hasChildren).toBe(false);
    // unknown 没 listDirs 过 → 乐观画 chevron(展开后由缓存纠正)
    expect(folderRow(r, 'folder:unknown').hasChildren).toBe(true);
  });
});

describe('groupItemsByDir —— 按 dirname(relPath) 分组', () => {
  it('根层 / 各子目录各归各位', () => {
    const byDir = groupItemsByDir(ITEMS);
    expect(byDir.get('')?.map((x) => x.id)).toEqual(['f1', 'f5']);
    expect(byDir.get('a')?.map((x) => x.id)).toEqual(['f2']);
    expect(byDir.get('a/b')?.map((x) => x.id)).toEqual(['f3', 'f4']);
  });
});

describe('树键盘辅助:← 找父行、→ 找子行', () => {
  it('findParentFolderRow:子行找得到它的父文件夹行', () => {
    const r = rows({ expanded: ['a', 'a/b'] });
    const child = r.find((x) => x.id === 'f3')!;
    const parent = findParentFolderRow(r, child);
    expect(parent?.id).toBe('folder:a/b');
  });

  it('findParentFolderRow:根层行没有父文件夹行 → null', () => {
    const r = rows({});
    const rootRow = r.find((x) => x.id === 'f1')!;
    expect(findParentFolderRow(r, rootRow)).toBeNull();
  });

  it('findFirstChildRow:展开的文件夹 → 下一行;折叠的 → null', () => {
    const r = rows({ expanded: ['a'] });
    const idx = r.findIndex((x) => x.id === 'folder:a');
    // a 的第一个子节点是子文件夹 a/b(文件夹在前)
    expect(findFirstChildRow(r, idx)?.id).toBe('folder:a/b');
    // 折叠态
    const collapsed = rows({});
    const cIdx = collapsed.findIndex((x) => x.id === 'folder:a');
    expect(findFirstChildRow(collapsed, cIdx)).toBeNull();
  });
});
