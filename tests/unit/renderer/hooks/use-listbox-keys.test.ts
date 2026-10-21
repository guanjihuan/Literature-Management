// tests/unit/renderer/hooks/use-listbox-keys.test.ts
//
// 守 r225「handleListboxKeyDown 同构块收编」契约(收编 ②):
//   NotesList(153 行)/ LiteratureList(136 行)的容器级键盘处理收进
//   hooks/use-listbox-keys.ts。差异收敛为注入点(onPasteItems /
//   onDeleteSelection / 可选 onRenameItem);lit 的 Delete 分支
//   `!== 'input'` 与 notes 的 `=== 'item'` 在封闭三元并
//   {'folder','item','input'} 下等价,统一为后者。
//
// ── 锁两类东西(与 r224 同模式)────────────────────────────────────
//   1. 行为契约:输入焦点 gate / mod+c/x/v/a/n / F2(folder + 可选 item)/
//      Delete(folder + item)/ Enter/Space 容器 commit 与防二次触发 gate /
//      ←/→ 树导航 —— 这些是收编前两块代码的既有行为,对 HEAD 也必须绿;
//   2. 结构契约:两组件源码不得再出现 findFirstChildRow /
//      `handleListboxKeyDown = useCallback`,孪生块复活即红(修前红)。
import { describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useListboxKeys, type UseListboxKeysOptions } from '../../../../src/renderer/src/hooks/use-listbox-keys';
import type { TreeRow } from '../../../../src/renderer/src/lib/folder-tree';
import type { DiskFolderSidebar } from '../../../../src/renderer/src/hooks/useDiskFolderSidebar';

interface Row {
  id: string;
  relPath: string;
}

const N1: Row = { id: 'n1', relPath: 'docs/n1.md' };
const N2: Row = { id: 'n2', relPath: 'n2.md' };

function folderRow(relPath: string, expanded: boolean): TreeRow<Row> {
  return {
    rowType: 'folder',
    id: 'folder:' + relPath,
    folder: { relPath, name: relPath },
    depth: 0,
    expanded,
    hasChildren: true,
    isTarget: false,
    parentRelPath: '',
    posInSet: 1,
    setSize: 1,
  } as unknown as TreeRow<Row>;
}
function itemRow(item: Row, parentRelPath: string): TreeRow<Row> {
  return {
    rowType: 'item',
    id: item.id,
    item,
    depth: parentRelPath === '' ? 0 : 1,
    parentRelPath,
    posInSet: 1,
    setSize: 1,
  } as unknown as TreeRow<Row>;
}

// 0: folder docs(expanded) / 1: item n1 ∈ docs / 2: item n2 ∈ 根 / 3: folder empty(折叠)
const ROWS: TreeRow<Row>[] = [
  folderRow('docs', true),
  itemRow(N1, 'docs'),
  itemRow(N2, ''),
  folderRow('empty', false),
];

function makeFolders() {
  return {
    cutFolder: vi.fn(),
    folderClipboard: null as string | null,
    pasteFolderInto: vi.fn().mockResolvedValue(undefined),
    targetRelPath: '',
    startCreate: vi.fn(),
    startRename: vi.fn(),
    requestDelete: vi.fn().mockResolvedValue(undefined),
    activateFolder: vi.fn(),
    expandFolder: vi.fn(),
    collapseFolder: vi.fn(),
  } as unknown as DiskFolderSidebar;
}

function makeKeyEvent(
  key: string,
  opts: { mod?: boolean; shift?: boolean; targetIsInput?: boolean; containerGate?: boolean } = {},
) {
  const container = { tagName: 'DIV', isContentEditable: false };
  const target = opts.targetIsInput
    ? { tagName: 'INPUT', isContentEditable: false }
    : container;
  return {
    key,
    ctrlKey: opts.mod ?? false,
    metaKey: false,
    altKey: false,
    shiftKey: opts.shift ?? false,
    target,
    currentTarget: opts.containerGate === false ? { tagName: 'DIV' } : container,
    preventDefault: vi.fn(),
  } as unknown as ReactKeyboardEvent;
}

function setup(overrides: Partial<UseListboxKeysOptions<Row>> = {}) {
  const calls = {
    copySelection: vi.fn(),
    cutSelection: vi.fn(),
    onPasteItems: vi.fn(),
    runFolderOp: vi.fn((op: () => Promise<unknown>) => void op()),
    selectMany: vi.fn(),
    onDeleteSelection: vi.fn(),
    handleSelect: vi.fn(),
    handleActiveById: vi.fn(),
    onRenameItem: vi.fn(),
  };
  const folders = makeFolders();
  const opts: UseListboxKeysOptions<Row> = {
    rows: ROWS,
    activeId: null,
    visibleItems: [N1, N2],
    clipboard: null,
    searchActive: false,
    folders,
    ...calls,
    ...overrides,
  };
  const hook = renderHook((p: UseListboxKeysOptions<Row>) => useListboxKeys<Row>(p), {
    initialProps: opts,
  });
  return { ...hook, calls, folders };
}

describe('useListboxKeys(r225 收编块的行为契约)', () => {
  it('输入焦点 gate:目标是 INPUT/TEXTAREA/contentEditable ⇒ 全键让行', () => {
    const { result, calls } = setup();
    act(() => result.current(makeKeyEvent('c', { mod: true, targetIsInput: true })));
    expect(calls.copySelection).not.toHaveBeenCalled();
  });

  it('mod+c 复制选区;mod+x 在文件夹行剪切文件夹、否则剪切选区', () => {
    const { result, calls, folders, rerender } = setup({ activeId: 'folder:docs' });
    act(() => result.current(makeKeyEvent('c', { mod: true })));
    expect(calls.copySelection).toHaveBeenCalledTimes(1);

    act(() => result.current(makeKeyEvent('x', { mod: true })));
    expect(folders.cutFolder).toHaveBeenCalledWith('docs');
    expect(calls.cutSelection).not.toHaveBeenCalled();

    // active 是 item 行 ⇒ 按选区剪切
    rerender({ ...setupDefaults(calls, folders), activeId: 'n2' });
    act(() => result.current(makeKeyEvent('x', { mod: true })));
    expect(calls.cutSelection).toHaveBeenCalledTimes(1);
  });

  it('mod+v:条目剪贴板优先;空则文件夹剪贴板兜底;搜索态不兜底(r131/r134)', () => {
    const { result, calls, folders, rerender } = setup({ clipboard: { ids: ['n2'] } });
    act(() => result.current(makeKeyEvent('v', { mod: true })));
    expect(calls.onPasteItems).toHaveBeenCalledTimes(1);
    expect(folders.pasteFolderInto).not.toHaveBeenCalled();

    // 条目剪贴板空 + 文件夹剪贴板非空 ⇒ runFolderOp 兜底
    (folders as { folderClipboard: string | null }).folderClipboard = 'docs';
    rerender({ ...setupDefaults(calls, folders), clipboard: null });
    act(() => result.current(makeKeyEvent('v', { mod: true })));
    expect(calls.runFolderOp).toHaveBeenCalled();
    expect(folders.pasteFolderInto).toHaveBeenCalledWith('');

    // 搜索态 ⇒ 不兜底
    calls.runFolderOp.mockClear();
    (folders.pasteFolderInto as ReturnType<typeof vi.fn>).mockClear();
    rerender({ ...setupDefaults(calls, folders), clipboard: null, searchActive: true });
    act(() => result.current(makeKeyEvent('v', { mod: true })));
    expect(calls.runFolderOp).not.toHaveBeenCalled();
  });

  it('mod+a 全选当前可见项;mod+Shift+N 搜索态不接收(r134)', () => {
    const { result, calls, folders, rerender } = setup();
    act(() => result.current(makeKeyEvent('a', { mod: true, shift: true })));
    expect(calls.selectMany).toHaveBeenCalledWith(['n1', 'n2']);

    act(() => result.current(makeKeyEvent('n', { mod: true, shift: true })));
    expect(folders.startCreate).toHaveBeenCalledTimes(1);

    rerender({ ...setupDefaults(calls, folders), searchActive: true });
    act(() => result.current(makeKeyEvent('n', { mod: true, shift: true })));
    expect(folders.startCreate).toHaveBeenCalledTimes(1); // 没有第二次
  });

  it('F2:文件夹行重命名;item 行仅在传了 onRenameItem 时触发(文献域不传)', () => {
    const { result, calls, folders, rerender } = setup({ activeId: 'folder:docs' });
    act(() => result.current(makeKeyEvent('F2')));
    expect(folders.startRename).toHaveBeenCalledTimes(1);
    expect(calls.onRenameItem).not.toHaveBeenCalled();

    rerender({ ...setupDefaults(calls, folders), activeId: 'n1' });
    act(() => result.current(makeKeyEvent('F2')));
    expect(calls.onRenameItem).toHaveBeenCalledWith('n1');

    // 不传 onRenameItem ⇒ F2 在 item 行什么都不做(文献域原行为)
    const bare = setup({ activeId: 'n1', onRenameItem: undefined });
    const e = makeKeyEvent('F2');
    act(() => bare.result.current(e));
    expect(bare.calls.onRenameItem).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('Delete:文件夹行 requestDelete;item 行 onDeleteSelection', () => {
    const { result, calls, folders, rerender } = setup({ activeId: 'folder:docs' });
    act(() => result.current(makeKeyEvent('Delete')));
    expect(folders.requestDelete).toHaveBeenCalledTimes(1);
    expect(calls.onDeleteSelection).not.toHaveBeenCalled();

    rerender({ ...setupDefaults(calls, folders), activeId: 'n1' });
    act(() => result.current(makeKeyEvent('Delete')));
    expect(calls.onDeleteSelection).toHaveBeenCalledTimes(1);
  });

  it('Enter/Space 容器级 commit:folder=activate,item=select;行持焦不二次触发(r76)', () => {
    const { result, calls, folders, rerender } = setup({ activeId: 'folder:docs' });
    act(() => result.current(makeKeyEvent('Enter')));
    expect(folders.activateFolder).toHaveBeenCalledWith('docs');

    rerender({ ...setupDefaults(calls, folders), activeId: 'n1' });
    act(() => result.current(makeKeyEvent(' ')));
    expect(calls.handleSelect).toHaveBeenCalledWith(N1);

    // gate:target !== currentTarget(行持焦)⇒ 容器不接管
    calls.handleSelect.mockClear();
    act(() => result.current(makeKeyEvent('Enter', { containerGate: false })));
    expect(calls.handleSelect).not.toHaveBeenCalled();
  });

  it('←/→ 树导航:→ 折叠=展开 / 展开=跳首个子行;← 展开=折叠 / 否则跳父行(r176)', () => {
    const { result, calls, folders, rerender } = setup({ activeId: 'folder:empty' });
    // → 折叠文件夹 ⇒ 展开
    act(() => result.current(makeKeyEvent('ArrowRight')));
    expect(folders.expandFolder).toHaveBeenCalledWith('empty');

    // → 展开文件夹 ⇒ 跳到第一个子行
    rerender({ ...setupDefaults(calls, folders), activeId: 'folder:docs' });
    act(() => result.current(makeKeyEvent('ArrowRight')));
    expect(calls.handleActiveById).toHaveBeenCalledWith('n1');

    // → 文件行 ⇒ 无意义
    calls.handleActiveById.mockClear();
    rerender({ ...setupDefaults(calls, folders), activeId: 'n2' });
    act(() => result.current(makeKeyEvent('ArrowRight')));
    expect(calls.handleActiveById).not.toHaveBeenCalled();

    // ← 展开文件夹 ⇒ 折叠
    rerender({ ...setupDefaults(calls, folders), activeId: 'folder:docs' });
    act(() => result.current(makeKeyEvent('ArrowLeft')));
    expect(folders.collapseFolder).toHaveBeenCalledWith('docs');

    // ← 子项 ⇒ 跳父文件夹行
    rerender({ ...setupDefaults(calls, folders), activeId: 'n1' });
    act(() => result.current(makeKeyEvent('ArrowLeft')));
    expect(calls.handleActiveById).toHaveBeenCalledWith('folder:docs');
  });
});

// rerender 需要整棵 opts;把 setup 的内部默认抽出来复用
function setupDefaults(
  calls: ReturnType<typeof makeCalls>,
  folders: DiskFolderSidebar,
): UseListboxKeysOptions<Row> {
  return {
    rows: ROWS,
    activeId: null,
    visibleItems: [N1, N2],
    clipboard: null,
    searchActive: false,
    folders,
    ...calls,
  };
}
function makeCalls() {
  return {
    copySelection: vi.fn(),
    cutSelection: vi.fn(),
    onPasteItems: vi.fn(),
    runFolderOp: vi.fn((op: () => Promise<unknown>) => void op()),
    selectMany: vi.fn(),
    onDeleteSelection: vi.fn(),
    handleSelect: vi.fn(),
    handleActiveById: vi.fn(),
    onRenameItem: vi.fn(),
  };
}

describe('r225 结构契约:孪生块不得复活', () => {
  const ROOT = process.cwd();
  for (const rel of [
    'src/renderer/src/components/notes/NotesList.tsx',
    'src/renderer/src/components/literature/LiteratureList.tsx',
  ]) {
    it(`${rel} 走 useListboxKeys,不再自带键盘处理块`, () => {
      const src = readFileSync(join(ROOT, rel), 'utf-8');
      expect(src, 'listbox 键盘处理必须走 hooks/use-listbox-keys').toContain('useListboxKeys');
      expect(src, '孪生块复活:组件里又出现树导航 helper').not.toContain('findFirstChildRow');
      expect(src, '孪生块复活:组件里又出现 useCallback 版键盘块').not.toContain(
        'handleListboxKeyDown = useCallback',
      );
    });
  }
});
