// tests/unit/renderer/lib/literature-folder-view.test.ts
//
// 守 renderer 侧「文献行按文件夹分组」(r172)。
//
// visibleItemRows 靠 dirname(relPath) 分组(根 = '')。literature 行以前
// **没有 relPath**(LiteratureResource 无此字段)⇒ dirname 恒为 '' ⇒ 文献行
// 永远只在根视图可见,子目录视图恒空 —— 「粘贴进文件夹」后文件还在根。
//
// r172 起 LiteratureService 给每行填真实 relPath(相对 literature 根),
// renderer 这层只需把它交给分组器(旧代码在这里做的是假 cast:注释声称
// 「把 absPath 当 relPath 走」,实际一行映射都没有)。本用例锁住分组
// 契约,防止再出现「文献行永远只在根」。
//
// r176(树状改造):visibleItemRows(钻入式单层过滤)整体下线,分组职责搬到
//   lib/folder-tree.ts 的 groupItemsByDir + buildTreeRows(树形行合成)。
//   本测同步改成锁**树形**下的同款契约:文献行按 relPath 归到对应目录,
//   折叠的目录不露出子行,展开才露出。
import { describe, expect, it } from 'vitest';
import { dirnameOfRelPath } from '../../../../src/renderer/src/lib/folder-view';
import {
  buildTreeRows,
  groupItemsByDir,
  type TreeRow,
} from '../../../../src/renderer/src/lib/folder-tree';
import type { LiteratureResource } from '../../../../src/shared/types';

function lit(id: string, relPath: string): LiteratureResource {
  return {
    id: id as unknown as LiteratureResource['id'],
    kind: 'literature',
    absPath: `C:/lib/${relPath}`,
    relPath,
    rootId: null,
    extractStatus: 'ok',
    title: relPath,
    mtime: 0,
    size: 0,
    indexedAt: 0,
  };
}

const ITEMS = [lit('a', 'top.pdf'), lit('b', 'sub/inner.pdf'), lit('c', 'sub/deep/deeper.pdf')];

const EMPTY_CHILDREN = new Map<string, never[]>();

function treeRows(
  items: readonly LiteratureResource[],
  expanded: readonly string[] = [],
): TreeRow<LiteratureResource>[] {
  return buildTreeRows<LiteratureResource>({
    childrenByDir: EMPTY_CHILDREN,
    itemsByDir: groupItemsByDir(items),
    expanded: new Set(expanded),
    targetRelPath: null,
    searchActive: false,
  });
}

describe('literature 行按 relPath 分组(r172 / r176 树形态)', () => {
  it('子目录里的文献不在根层出现(粘贴进文件夹后不再显示在根)', () => {
    const byDir = groupItemsByDir(ITEMS);
    expect(byDir.get('')?.map((r) => r.id)).toEqual(['a']);
  });

  it('子目录里的文献归到自己的目录', () => {
    const byDir = groupItemsByDir(ITEMS);
    expect(byDir.get('sub')?.map((r) => r.id)).toEqual(['b']);
    expect(byDir.get('sub/deep')?.map((r) => r.id)).toEqual(['c']);
  });

  it('搜索态返回全量(不分文件夹)', () => {
    const rows = buildTreeRows<LiteratureResource>({
      childrenByDir: EMPTY_CHILDREN,
      itemsByDir: groupItemsByDir(ITEMS),
      expanded: new Set(),
      targetRelPath: null,
      searchActive: true,
      searchItems: ITEMS,
    });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.rowType === 'item')).toBe(true);
  });

  it('dirnameOfRelPath:relPath 末段之前的部分即归属(根 = 空串)', () => {
    expect(dirnameOfRelPath({ relPath: 'top.pdf' })).toBe('');
    expect(dirnameOfRelPath({ relPath: 'sub/inner.pdf' })).toBe('sub');
    expect(dirnameOfRelPath({ relPath: 'sub/deep/deeper.pdf' })).toBe('sub/deep');
    // 缺 relPath 兜底到根(老行 / DB 直读路径)
    expect(dirnameOfRelPath({})).toBe('');
  });

  // === r176:树形行合成 ===
  it('没有子文件夹缓存时,文献行只出根层那一条', () => {
    const rows = treeRows(ITEMS);
    expect(rows.map((r) => r.id)).toEqual(['a']);
  });

  it('展开子目录后,目录内的文献行才出现(depth 随层级递增)', () => {
    const children = new Map<string, { relPath: string; name: string; parentRelPath: string | null }[]>([
      ['', [{ relPath: 'sub', name: 'sub', parentRelPath: null }]],
      ['sub', [{ relPath: 'sub/deep', name: 'deep', parentRelPath: 'sub' }]],
    ]);
    const rows = buildTreeRows<LiteratureResource>({
      childrenByDir: children,
      itemsByDir: groupItemsByDir(ITEMS),
      expanded: new Set(['sub', 'sub/deep']),
      targetRelPath: null,
      searchActive: false,
    });
    expect(rows.map((r) => r.id)).toEqual([
      'folder:sub',
      'folder:sub/deep',
      'c', // sub/deep 里的文献
      'b', // sub 里的文献
      'a', // 根层文献
    ]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get('folder:sub')?.depth).toBe(0);
    expect(byId.get('folder:sub/deep')?.depth).toBe(1);
    expect(byId.get('b')?.depth).toBe(1);
    expect(byId.get('a')?.depth).toBe(0);
  });
});
