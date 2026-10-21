// tests/unit/renderer/hooks/disk-folder-tree.test.ts
//
// 守 r176「左侧栏改树状」的**端到端接线**契约 —— 纯函数(建树)在
// folder-tree.test.ts 里锁,本测锁「hook 状态 → 建树输入」这一段:
//   挂载 → 拉根目录子项
//   点文件夹 → 展开 + 设为落点 + 懒加载该目录子项
//   新建文件夹 → 落在**当前落点**下(不是「钻入到的目录」)
//   落点处于折叠态 → 新建前先展开(否则 input 行落在看不见的地方)
//
// 这段是「用户点了文件夹 → 树真的长出子树 → 新建落在点上的文件夹」
// 这条主链路的唯一自动化防线 —— 组件层(NotesList / LiteratureList)
// 依赖 react-virtuoso,jsdom 容器高度 0 ⇒ 行不渲染,渲染测覆盖不到。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
  useDiskFolderSidebar,
  resetFolderTreeRegistry,
} from '../../../../src/renderer/src/hooks/useDiskFolderSidebar';
import { buildTreeRows } from '../../../../src/renderer/src/lib/folder-tree';
import type { Api } from '../../../../src/shared/api-types';

function node(relPath: string, parentRelPath: string | null) {
  return { relPath, name: relPath.slice(relPath.lastIndexOf('/') + 1), parentRelPath };
}

// 磁盘形状:
//   root
//   ├── a
//   │   └── deep
//   └── b
const TREE: Record<string, ReturnType<typeof node>[]> = {
  '': [node('a', null), node('b', null)],
  a: [node('a/deep', 'a')],
  'a/deep': [],
  b: [],
};

function makeApi(): Api {
  return {
    notesListDirs: vi.fn().mockImplementation((kind: string, rel: string | null) => {
      const key = rel ?? '';
      return Promise.resolve({ ok: true, data: TREE[key] ?? [] });
    }),
    litListDirs: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  } as unknown as Api;
}

describe('useDiskFolderSidebar —— 树状接线(r176)', () => {
  let api: ReturnType<typeof makeApi>;

  beforeEach(() => {
    api = makeApi();
    resetFolderTreeRegistry('note');
  });

  it('挂载时拉一次根目录子项(根 = null)', async () => {
    renderHook(() => useDiskFolderSidebar({ kind: 'note', searchActive: false, api }));
    await waitFor(() => {
      expect((api.notesListDirs as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
        'note',
        null,
      ]);
    });
  });

  it('点文件夹(a)→ 展开 + 设为落点 + 懒加载该目录子项', async () => {
    const { result } = renderHook(() =>
      useDiskFolderSidebar({ kind: 'note', searchActive: false, api }),
    );
    await waitFor(() => {
      expect(result.current.childrenByDir.get('')?.map((f) => f.relPath)).toEqual(['a', 'b']);
    });

    await act(async () => {
      result.current.activateFolder('a');
    });

    expect(result.current.targetRelPath).toBe('a');
    expect(result.current.expanded.has('a')).toBe(true);
    await waitFor(() => {
      expect(result.current.childrenByDir.get('a')?.map((f) => f.relPath)).toEqual(['a/deep']);
    });
    expect((api.notesListDirs as ReturnType<typeof vi.fn>).mock.calls).toContainEqual([
      'note',
      'a',
    ]);
  });

  it('hook 状态直接喂建树函数 → 展开的目录长出子树', async () => {
    const { result } = renderHook(() =>
      useDiskFolderSidebar({ kind: 'note', searchActive: false, api }),
    );
    await waitFor(() => {
      expect(result.current.childrenByDir.get('')).toBeDefined();
    });

    const build = () =>
      buildTreeRows<{ id: string; relPath: string }>({
        childrenByDir: result.current.childrenByDir,
        itemsByDir: new Map(),
        expanded: result.current.expanded,
        targetRelPath: result.current.targetRelPath,
        searchActive: false,
      });

    expect(build().map((r) => r.id)).toEqual(['folder:a', 'folder:b']);

    await act(async () => {
      result.current.activateFolder('a');
    });
    await waitFor(() => {
      expect(result.current.childrenByDir.get('a')).toBeDefined();
    });
    expect(build().map((r) => r.id)).toEqual(['folder:a', 'folder:a/deep', 'folder:b']);
  });

  it('新建文件夹落在**当前落点**下(不是根)', async () => {
    const { result } = renderHook(() =>
      useDiskFolderSidebar({ kind: 'note', searchActive: false, api }),
    );
    await act(async () => {
      result.current.activateFolder('a');
    });
    act(() => {
      result.current.startCreate();
    });
    expect(result.current.editing).toEqual({ mode: 'create', parentRelPath: 'a', name: '' });
  });

  it('没有落点时新建落在根', () => {
    const { result } = renderHook(() =>
      useDiskFolderSidebar({ kind: 'note', searchActive: false, api }),
    );
    act(() => {
      result.current.startCreate();
    });
    expect(result.current.editing).toEqual({ mode: 'create', parentRelPath: null, name: '' });
  });

  it('落点处于折叠态时,新建前先把它展开(input 行才看得见)', async () => {
    const { result } = renderHook(() =>
      useDiskFolderSidebar({ kind: 'note', searchActive: false, api }),
    );
    // 先让落点处于折叠态:activate 一次展开、再一次折叠(落点保持)
    act(() => {
      result.current.activateFolder('a');
    });
    act(() => {
      result.current.activateFolder('a');
    });
    expect(result.current.targetRelPath).toBe('a');
    expect(result.current.expanded.has('a')).toBe(false);

    act(() => {
      result.current.startCreate();
    });
    expect(result.current.expanded.has('a')).toBe(true);
  });

  it('子目录新建:父目录就是被点的那个文件夹', () => {
    const { result } = renderHook(() =>
      useDiskFolderSidebar({ kind: 'note', searchActive: false, api }),
    );
    act(() => {
      result.current.startCreateSubfolder(node('a', null));
    });
    expect(result.current.editing).toEqual({ mode: 'create', parentRelPath: 'a', name: '' });
  });
});
