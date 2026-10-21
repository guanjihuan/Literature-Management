// tests/unit/renderer/hooks/folder-tree-external-refresh.test.ts
//
// 守 r184「磁盘目录结构被**外部**改动后,左侧栏树必须跟着变」契约。
//
// 背景(用户诉求:「左侧的文献和笔记列表应该和对应的文件夹完全一致」):
//   树的数据源 childrenByDir 是**懒加载 + 缓存**的 —— 每个目录一次
//   listDirs IPC,结果进缓存,之后只靠应用自己的操作(新建 / 改名 /
//   删除 / 搬移)去 applyStructuralChange + loadChildren 修正。
//
//   ⇒ 磁盘上**目录结构**被外部改动时(用户在资源管理器里建了夹 / 删了夹 /
//   改了名 —— 这在本项目里是常规操作:用户的笔记就放在
//   <rootPath>/notes/ 下),缓存从来没被碰过:
//     - 外部新建的夹**永远不出现**(缓存里没有,且 expandFolder 只在
//       「没缓存过」时才拉 → 折叠再展开也刷不出来);
//     - 外部删掉的夹**永远还在**(点进去是空的);
//     - 外部改名的夹显示**旧名**,里面文件的 relPath 变了 ⇒ 文件行从
//       当前目录视图里「消失」—— 用户视角就是「文件凭空不见了」。
//
//   主进程侧同样有洞:notes / literature 的 chokidar 只监听
//   add / change / unlink,**不监听 addDir / unlinkDir** ⇒ 光建一个空
//   夹(没有文件)时主进程连 'changed' 都不发,renderer 根本不知道。
//
// 本测锁(渲染层):
//   1. 外部新建文件夹 → 树的根子项跟着多出该夹;
//     2. 外部删除文件夹 → 树的根子项跟着少掉该夹(且缓存里的孤儿键清掉);
//   3. 外部事件不该引发**无谓重渲**(内容没变就不换引用)。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
  useDiskFolderSidebar,
  resetFolderTreeRegistry,
} from '../../../../src/renderer/src/hooks/useDiskFolderSidebar';
import type { Api } from '../../../../src/shared/api-types';

function node(relPath: string, parentRelPath: string | null) {
  return { relPath, name: relPath.slice(relPath.lastIndexOf('/') + 1), parentRelPath };
}

describe('useDiskFolderSidebar —— 外部目录改动后树跟着变(r184)', () => {
  let tree: Record<string, ReturnType<typeof node>[]>;
  let changedHandler: (() => void) | null;
  let api: Api;
  let listDirsMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tree = { '': [node('a', null)], a: [] };
    changedHandler = null;
    listDirsMock = vi.fn((kind: string, rel: string | null) =>
      Promise.resolve({ ok: true, data: tree[rel ?? ''] ?? [] }),
    );
    api = {
      notesListDirs: listDirsMock,
      litListDirs: vi.fn().mockResolvedValue({ ok: true, data: [] }),
      onNotesChanged: vi.fn((h: () => void) => {
        changedHandler = h;
        return () => {
          changedHandler = null;
        };
      }),
      onLiteratureChanged: vi.fn(() => () => {}),
    } as unknown as Api;
    resetFolderTreeRegistry('note');
  });

  it('外部新建文件夹 → 树里出现该夹', async () => {
    const { result } = renderHook(() =>
      useDiskFolderSidebar({ kind: 'note', searchActive: false, api }),
    );
    await waitFor(() => {
      expect(result.current.childrenByDir.get('')?.map((f) => f.relPath)).toEqual(['a']);
    });

    // 用户在资源管理器里建了 notes/newdir/
    tree = { '': [node('a', null), node('newdir', null)], a: [] };
    act(() => {
      changedHandler?.();
    });

    await waitFor(() => {
      expect(result.current.childrenByDir.get('')?.map((f) => f.relPath)).toEqual([
        'a',
        'newdir',
      ]);
    });
  });

  it('外部删除文件夹 → 树里少掉该夹,缓存里的孤儿键也清掉', async () => {
    tree = { '': [node('a', null), node('b', null)], a: [], b: [] };
    const { result } = renderHook(() =>
      useDiskFolderSidebar({ kind: 'note', searchActive: false, api }),
    );
    await waitFor(() => {
      expect(result.current.childrenByDir.get('')?.map((f) => f.relPath)).toEqual(['a', 'b']);
    });
    // 展开 a → 缓存里出现 'a' 这个 key
    await act(async () => {
      result.current.activateFolder('a');
    });
    await waitFor(() => {
      expect(result.current.childrenByDir.get('a')).toBeDefined();
    });

    // 用户在资源管理器里删了 notes/a/
    tree = { '': [node('b', null)], b: [] };
    act(() => {
      changedHandler?.();
    });

    await waitFor(() => {
      expect(result.current.childrenByDir.get('')?.map((f) => f.relPath)).toEqual(['b']);
    });
    // 孤儿缓存键(a)不该留着 —— 否则展开态残留 + 再次展开时拉回幽灵子树
    expect(result.current.childrenByDir.has('a')).toBe(false);
  });

  it('外部删掉「落点」目录 → 落点回根(否则新建/粘贴会把刚删的夹凭空建回来)', async () => {
    tree = { '': [node('a', null)], a: [] };
    const { result } = renderHook(() =>
      useDiskFolderSidebar({ kind: 'note', searchActive: false, api }),
    );
    await waitFor(() => {
      expect(result.current.childrenByDir.get('')).toBeDefined();
    });
    await act(async () => {
      result.current.activateFolder('a');
    });
    expect(result.current.targetRelPath).toBe('a');

    tree = { '': [] };
    act(() => {
      changedHandler?.();
    });

    await waitFor(() => {
      expect(result.current.targetRelPath).toBeNull();
    });
  });

  it('外部删掉已展开的目录 → 展开态里不再有它', async () => {
    tree = { '': [node('a', null)], a: [] };
    const { result } = renderHook(() =>
      useDiskFolderSidebar({ kind: 'note', searchActive: false, api }),
    );
    await act(async () => {
      result.current.activateFolder('a');
    });
    expect(result.current.expanded.has('a')).toBe(true);

    tree = { '': [] };
    act(() => {
      changedHandler?.();
    });

    await waitFor(() => {
      expect(result.current.expanded.has('a')).toBe(false);
    });
  });

  it('内容没变时不换引用(不引发无谓重渲)', async () => {
    const { result } = renderHook(() =>
      useDiskFolderSidebar({ kind: 'note', searchActive: false, api }),
    );
    await waitFor(() => {
      expect(result.current.childrenByDir.get('')).toBeDefined();
    });
    const before = result.current.childrenByDir.get('');

    act(() => {
      changedHandler?.();
    });
    await waitFor(() => {
      expect(listDirsMock.mock.calls.length).toBeGreaterThan(1);
    });

    expect(result.current.childrenByDir.get('')).toBe(before);
  });
});
