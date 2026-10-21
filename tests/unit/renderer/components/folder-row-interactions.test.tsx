// tests/unit/renderer/components/folder-row-interactions.test.tsx
//
// 守 r174「文件夹行是死的」契约 —— FolderRowOption 此前是 Phase 1 stub:
//   声明了 onContextMenu / onContextMenuAt / onHover 三个 prop 却一个都没用,
//   并且 draggable={false} 让浏览器根本不发起原生 drag。后果:
//     - 右键文件夹 → 菜单永远不弹(NotesList / LiteratureList 里那套
//       folderMenuItems:剪切 / 粘贴 / 移到根目录 / 删除 全都够不着);
//     - hover 文件夹 → activeId 不跟手(SR 的 aria-activedescendant 落在
//       别的行上);
//     - 拖文件夹 → r173 接好的 folders-move-dir 链路永远收不到载荷。
//
// 本测是**行为级** guard:不锁实现细节,只锁「用户做的动作真的到达了
// 父级回调」。父级接线(坐标 vs 事件)另由 NotesList / LiteratureList 侧
// 负责。
//
// r176(树状改造)追加:a11y 语义升格 —— 侧栏从 listbox/option 变成
//   tree/treeitem,aria-level / aria-expanded 必须在行上,否则读屏器
//   报「树里没有层级」;缩进也必须真的按 depth 走(层级感是树的核心
//   视觉线索)。另 `onOpen` 改名 `onActivate`(语义从「钻入」变成
//   「设为落点 + 切换展开」)。
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { FolderRowOption } from '../../../../src/renderer/src/components/common/FolderChrome';
import type { DiskFolderNode } from '../../../../src/shared/types';

// i18n:组件内 FolderNameInput / aria 走 useTranslation —— 测试里只关心
//   交互,不关心文案,直接 mock 成 key 原样返回。
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

const folder: DiskFolderNode = { relPath: 'a/b', name: 'b', parentRelPath: 'a' };

function renderRow(overrides: Partial<React.ComponentProps<typeof FolderRowOption>> = {}) {
  const props = {
    folder,
    domId: 'note-row-folder-a/b',
    isActive: false,
    isCut: false,
    isDropHot: false,
    isRenaming: false,
    depth: 1,
    expanded: false,
    hasChildren: true,
    isTarget: false,
    posInSet: 1,
    setSize: 3,
    onActivate: vi.fn(),
    onContextMenu: vi.fn(),
    onContextMenuAt: vi.fn(),
    onHover: vi.fn(),
    onDragStart: vi.fn(),
    onDragOver: vi.fn(),
    onDragLeave: vi.fn(),
    onDrop: vi.fn(),
    onCommitRename: vi.fn().mockResolvedValue(true),
    onCancelRename: vi.fn(),
    ...overrides,
  };
  const utils = render(<FolderRowOption {...props} />);
  const row = utils.container.querySelector('[data-folder-relpath]') as HTMLElement;
  return { ...utils, row, props };
}

describe('FolderRowOption 交互接线(r174)', () => {
  beforeEach(() => {
    cleanup();
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('右键文件夹 → 父级 onContextMenu 收到 (folder, event)', () => {
    const { row, props } = renderRow();
    fireEvent.contextMenu(row, { clientX: 12, clientY: 34 });
    expect(props.onContextMenu).toHaveBeenCalledTimes(1);
    const [f, ev] = (props.onContextMenu as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(f).toBe(folder);
    expect((ev as MouseEvent).clientX).toBe(12);
  });

  it('hover 文件夹 → 父级 onHover 收到 folder', () => {
    const { row, props } = renderRow();
    fireEvent.mouseEnter(row);
    expect(props.onHover).toHaveBeenCalledWith(folder);
  });

  it('文件夹行 draggable=true,dragstart 真的到达父级', () => {
    const { row, props } = renderRow();
    expect(row.getAttribute('draggable')).toBe('true');
    fireEvent.dragStart(row);
    expect(props.onDragStart).toHaveBeenCalledTimes(1);
    expect((props.onDragStart as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe(folder);
  });

  it('renaming 态 draggable=false(别拖 input)', () => {
    const { row } = renderRow({ isRenaming: true });
    expect(row.getAttribute('draggable')).toBe('false');
  });

  it('Shift+F10 → 父级 onContextMenuAt 收到坐标', () => {
    const { row, props } = renderRow();
    fireEvent.keyDown(row, { key: 'F10', shiftKey: true });
    expect(props.onContextMenuAt).toHaveBeenCalledTimes(1);
    const [f, x, y] = (props.onContextMenuAt as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(f).toBe(folder);
    expect(typeof x).toBe('number');
    expect(typeof y).toBe('number');
  });

  it('Enter → 父级 onActivate 收到 folder', () => {
    const { row, props } = renderRow();
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(props.onActivate).toHaveBeenCalledWith(folder);
  });

  // === r176:树语义 ===

  it('行是 treeitem(不是 option)—— aria-level / aria-expanded 只在 treeitem 上有效', () => {
    const { row } = renderRow({ depth: 2, expanded: true, hasChildren: true });
    expect(row.getAttribute('role')).toBe('treeitem');
    expect(row.getAttribute('aria-level')).toBe('3'); // depth + 1
    expect(row.getAttribute('aria-expanded')).toBe('true');
  });

  it('叶子文件夹(无子节点)不带 aria-expanded —— 免得读屏 announce 一个不存在的展开态', () => {
    const { row } = renderRow({ hasChildren: false, expanded: false });
    expect(row.hasAttribute('aria-expanded')).toBe(false);
  });

  it('缩进按 depth 递增(层级感是树的核心视觉线索)', () => {
    const { row: d0 } = renderRow({ depth: 0 });
    const { row: d2 } = renderRow({ depth: 2 });
    expect(d0.style.paddingLeft).toBe('12px');
    expect(d2.style.paddingLeft).toBe('36px'); // 12 + 2*12
  });

  it('落点文件夹(isTarget)带 list-row-tree-target 类(与主选中态区分的视觉)', () => {
    const { row } = renderRow({ isTarget: true });
    expect(row.className).toContain('list-row-tree-target');
  });
});
