// tests/unit/renderer/hooks/use-sidebar-menus.test.ts
//
// 守 r232「侧栏右键菜单两段同构块收编」契约:
//
//   收编前,NotesList / LiteratureList 各自持有一份**逐字相同**的
//   ① 文件夹行菜单(folderMenuItems)与 ② 空白区菜单(containerMenuItems)。
//   两域的文件夹操作面(设为落点 / 新建子夹 / 重命名 / 剪切 / 粘贴内容 /
//   粘贴文件夹 / 移到根 / 删除)是**同一个用户心智**,却有两份实现 ——
//   孪生分叉一旦发生,后果是「某一域的某个文件夹操作消失或指向错目标」
//   (r228 即孪生分叉长成真 bug 的实例)。
//
//   收编后两域共用 hooks/use-sidebar-menus.ts,差异只剩注入点:
//   文件夹菜单零注入;空白区菜单注入「首项」+「粘贴项 label key」。
//
// ── 锁两类东西(与 r224-r227 同模式)──────────────────────────────
//   1. 行为契约(收编前既有行为,对 HEAD 也必须绿):
//      文件夹菜单:menu 为空 ⇒ 空;粘贴(内容)看剪贴板;粘贴(文件夹)看
//      文件夹剪贴板且排除自粘;移到根看 parentRelPath;删除恒在末尾;
//      空白区菜单:首项可注入;搜索态隐藏新建文件夹/粘贴文件夹;全选
//      只在有可见条目时出现并把可见 id 全量交给 selectMany;
//   2. 结构契约:两个组件必须走 useFolderMenuItems / useContainerMenuItems,
//      且不得再内联菜单项字面量 —— 孪生块复活即红(修前红)。
import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { readFileSync } from 'fs';
import { join } from 'path';

// i18n —— t 回显 key,便于断言「用的是哪个 key」。
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

import {
  useContainerMenuItems,
  useFolderMenuItems,
} from '../../../../src/renderer/src/hooks/use-sidebar-menus';
import type { DiskFolderSidebar } from '../../../../src/renderer/src/hooks/useDiskFolderSidebar';

interface FolderOpts {
  folderMenu?: unknown;
  folderClipboard?: string | null;
  targetRelPath?: string | null;
}

function makeFolders(over: FolderOpts = {}) {
  const calls: string[] = [];
  const folders = {
    folderMenu:
      over.folderMenu === undefined
        ? { folder: { relPath: 'a/b', name: 'b', parentRelPath: 'a' }, x: 1, y: 2 }
        : over.folderMenu,
    folderClipboard: over.folderClipboard ?? null,
    targetRelPath: over.targetRelPath ?? null,
    startCreateSubfolder: vi.fn((f: { relPath: string }) => calls.push(`newSub:${f.relPath}`)),
    startRename: vi.fn((f: { relPath: string }) => calls.push(`rename:${f.relPath}`)),
    cutFolder: vi.fn((p: string) => calls.push(`cut:${p}`)),
    startCreate: vi.fn(() => calls.push('newFolder')),
    pasteFolderInto: vi.fn(async (p: string) => {
      calls.push(`pasteFolder:${p}`);
      return { ok: true };
    }),
    moveFolderNow: vi.fn(async (p: string, t: string | null) => {
      calls.push(`moveToRoot:${p}->${t}`);
      return { ok: true };
    }),
    requestDelete: vi.fn((f: { relPath: string }) => calls.push(`delete:${f.relPath}`)),
  } as unknown as DiskFolderSidebar;
  return { folders, calls };
}

function renderFolderMenu(over: FolderOpts = {}, clipboard: unknown = null) {
  const { folders, calls } = makeFolders(over);
  const pasteTo = vi.fn(async () => {
    calls.push('pasteTo');
  });
  const runFolderOp = vi.fn((op: () => Promise<unknown>) => {
    void op();
  });
  const { result } = renderHook(() => useFolderMenuItems({ folders, clipboard, pasteTo, runFolderOp }));
  return { items: result.current, calls, pasteTo, runFolderOp };
}

function renderContainerMenu(
  over: {
    folders?: FolderOpts;
    clipboard?: unknown;
    searchActive?: boolean;
    visibleItems?: ReadonlyArray<{ id: string }>;
    primaryItem?: { id: string; labelKey: string; onSelect: () => void };
    pasteLabelKey?: string;
  } = {},
) {
  const { folders, calls } = makeFolders(over.folders ?? {});
  const pasteToTarget = vi.fn(() => calls.push('pasteToTarget'));
  const runFolderOp = vi.fn((op: () => Promise<unknown>) => {
    void op();
  });
  const selectMany = vi.fn((ids: string[]) => calls.push(`selectMany:${ids.join(',')}`));
  const primaryItem = over.primaryItem ?? {
    id: 'newNote',
    labelKey: 'notes.listEmptyAction',
    onSelect: () => calls.push('primary'),
  };
  const { result } = renderHook(() =>
    useContainerMenuItems({
      folders,
      clipboard: over.clipboard ?? null,
      pasteToTarget,
      runFolderOp,
      searchActive: over.searchActive ?? false,
      visibleItems: over.visibleItems ?? [],
      primaryItem,
      pasteLabelKey: over.pasteLabelKey ?? 'notes.contextPaste',
      selectMany,
    }),
  );
  return { items: result.current, calls, selectMany, pasteToTarget, primaryItem };
}

const ids = (items: ReadonlyArray<{ id: string }>) => items.map((i) => i.id);

describe('useFolderMenuItems(r232 收编块的行为契约)', () => {
  it('没有打开的文件夹菜单 ⇒ 空数组', () => {
    const { items } = renderFolderMenu({ folderMenu: null });
    expect(items).toEqual([]);
  });

  it('默认项集合:新建子夹 / 重命名 / 剪切 + 末尾的删除(无「设为当前文件夹」—— 点行即设落点)', () => {
    const { items } = renderFolderMenu();
    expect(ids(items)).toEqual(['newSub', 'rename', 'cut', 'moveToRoot', 'sep1', 'delete']);
    // 删除恒在最后一项
    expect(ids(items).at(-1)).toBe('delete');
  });

  it('「粘贴(内容)」只在内容剪贴板非空时出现;点击打到 pasteTo(目标 = 该文件夹)', () => {
    const empty = renderFolderMenu();
    expect(ids(empty.items)).not.toContain('pasteItems');

    const withClipboard = renderFolderMenu({}, { some: 'payload' });
    expect(ids(withClipboard.items)).toContain('pasteItems');
    withClipboard.items.find((i) => i.id === 'pasteItems')?.onSelect?.();
    expect(withClipboard.pasteTo).toHaveBeenCalledWith('a/b');
  });

  it('「粘贴(文件夹)」在文件夹剪贴板非空且不是自己时出现(防自粘)', () => {
    const self = renderFolderMenu({ folderClipboard: 'a/b' });
    expect(ids(self.items)).not.toContain('pasteFolder');

    const other = renderFolderMenu({ folderClipboard: 'a/c' });
    expect(ids(other.items)).toContain('pasteFolder');
    other.items.find((i) => i.id === 'pasteFolder')?.onSelect?.();
    expect(other.calls).toContain('pasteFolder:a/b');
  });

  it('「移到根」只在非根目录出现;目标 = 根(null)', () => {
    const root = renderFolderMenu({
      folderMenu: { folder: { relPath: 'b', name: 'b', parentRelPath: null }, x: 0, y: 0 },
    });
    expect(ids(root.items)).not.toContain('moveToRoot');

    const nested = renderFolderMenu();
    expect(ids(nested.items)).toContain('moveToRoot');
    nested.items.find((i) => i.id === 'moveToRoot')?.onSelect?.();
    expect(nested.calls).toContain('moveToRoot:a/b->null');
  });

  it('动作接线:新建子夹 / 剪切 / 删除各打到 folders 的对应方法', () => {
    const { items, calls } = renderFolderMenu();
    items.find((i) => i.id === 'newSub')?.onSelect?.();
    items.find((i) => i.id === 'cut')?.onSelect?.();
    items.find((i) => i.id === 'delete')?.onSelect?.();
    expect(calls).toEqual(['newSub:a/b', 'cut:a/b', 'delete:a/b']);
  });
});

describe('useContainerMenuItems(r232 收编块的行为契约)', () => {
  it('首项 = 注入的主操作(id 与 label key 都由调用方给)', () => {
    const { items } = renderContainerMenu({
      primaryItem: { id: 'import', labelKey: 'literature.listEmptyAction', onSelect: () => {} },
    });
    expect(items[0]?.id).toBe('import');
    expect(items[0]?.label).toBe('literature.listEmptyAction');
  });

  it('粘贴项 label 走注入的 pasteLabelKey(两域 locale 树不同)', () => {
    const notes = renderContainerMenu({ clipboard: { x: 1 }, pasteLabelKey: 'notes.contextPaste' });
    expect(notes.items.find((i) => i.id === 'paste')?.label).toBe('notes.contextPaste');

    const lit = renderContainerMenu({
      clipboard: { x: 1 },
      pasteLabelKey: 'literature.contextPaste',
      primaryItem: { id: 'import', labelKey: 'literature.listEmptyAction', onSelect: () => {} },
    });
    expect(lit.items.find((i) => i.id === 'paste')?.label).toBe('literature.contextPaste');
  });

  it('搜索态:隐藏「新建文件夹」与「粘贴(文件夹)」(落点在搜索视图不可见)', () => {
    const normal = renderContainerMenu({
      folders: { folderClipboard: 'x' },
      clipboard: { x: 1 },
    });
    expect(ids(normal.items)).toContain('newFolder');
    expect(ids(normal.items)).toContain('pasteFolder');

    const searching = renderContainerMenu({
      folders: { folderClipboard: 'x' },
      clipboard: { x: 1 },
      searchActive: true,
    });
    expect(ids(searching.items)).not.toContain('newFolder');
    expect(ids(searching.items)).not.toContain('pasteFolder');
    // 剪贴板粘贴与主操作仍保留(都影响可见条目,有反馈)
    expect(ids(searching.items)).toContain('paste');
  });

  it('「全选」只在有可见条目时出现,并把可见 id 全量交给 selectMany', () => {
    const empty = renderContainerMenu();
    expect(ids(empty.items)).not.toContain('selectAll');

    const some = renderContainerMenu({ visibleItems: [{ id: 'n1' }, { id: 'n2' }] });
    expect(ids(some.items)).toContain('selectAll');
    some.items.find((i) => i.id === 'selectAll')?.onSelect?.();
    expect(some.selectMany).toHaveBeenCalledWith(['n1', 'n2']);
  });

  it('分隔符:粘贴块前 sep1、全选前 sep2', () => {
    const { items } = renderContainerMenu({
      clipboard: { x: 1 },
      visibleItems: [{ id: 'n1' }],
    });
    const list = ids(items);
    // audit-r254:旧写法 `expect(list.indexOf('sep1')).toBeLessThan(list.indexOf('paste'))`
    //   在 **sep1 缺席**时是**恒真**的 —— indexOf 缺席返回 -1,而 -1 < 任意
    //   合法下标 ⇒ 分隔符被删掉,守卫照样绿(假绿)。
    //   这里改成:先断言两者**都在**,再断言先后。
    const sep1 = list.indexOf('sep1');
    const paste = list.indexOf('paste');
    const sep2 = list.indexOf('sep2');
    const selectAll = list.indexOf('selectAll');
    expect(sep1, 'sep1 分隔符必须存在').toBeGreaterThanOrEqual(0);
    expect(paste, 'paste 项必须存在').toBeGreaterThanOrEqual(0);
    expect(sep2, 'sep2 分隔符必须存在').toBeGreaterThanOrEqual(0);
    expect(selectAll, 'selectAll 项必须存在').toBeGreaterThanOrEqual(0);
    expect(sep1, 'sep1 必须在 paste 之前').toBeLessThan(paste);
    expect(sep2, 'sep2 必须在 selectAll 之前').toBeLessThan(selectAll);
  });
});

describe('r232 结构契约:孪生块不得复活', () => {
  const ROOT = process.cwd();
  for (const rel of [
    'src/renderer/src/components/notes/NotesList.tsx',
    'src/renderer/src/components/literature/LiteratureList.tsx',
  ]) {
    it(`${rel} 走 useFolderMenuItems / useContainerMenuItems`, () => {
      const src = readFileSync(join(ROOT, rel), 'utf-8');
      expect(src, '文件夹行菜单必须走 hooks/use-sidebar-menus').toContain('useFolderMenuItems');
      expect(src, '空白区菜单必须走 hooks/use-sidebar-menus').toContain('useContainerMenuItems');
      expect(src, '孪生块复活:组件里又内联了文件夹菜单项').not.toContain("id: 'newSub'");
      expect(src, '孪生块复活:组件里又内联了空白区菜单项').not.toContain("id: 'selectAll'");
    });
  }
});
