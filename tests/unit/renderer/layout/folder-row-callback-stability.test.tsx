// tests/unit/renderer/layout/folder-row-callback-stability.test.tsx
//
// 守 FolderRowOption 的**拖拽四件套回调契约** + **渲染稳定性**
// (src/renderer/src/components/common/FolderChrome.tsx r136/r166 头注指向本文件)。
//
// 契约四条,每条都对应一个**用户可见**的后果:
//
//   1. dragstart 交出的是**当前** folder 对象。
//      退化(闭包捕获了旧对象)⇒ 拖走的还是上一次的目录,落点算错,
//      文件被搬进错误的位置。
//   2. dragover / dragleave / drop 交出的是 `folder.relPath` —— 它就是
//      DiskFolderNode 的「id」语义别名(r161 disk-folder 之后没有独立 id 字段)。
//      写成 `folder.id` ⇒ 父级收到 undefined ⇒ 落点区收不到任何目录 id,
//      拖拽文件夹整条链路静默失效(用户看到「拖了没反应」)。
//   3. relPath 变了以后,回调必须跟着变(不许 stale closure)。
//      退化(useMemo 依赖写漏)⇒ 文件夹改名 / 搬移后,拖拽仍按旧路径上报,
//      文件被搬到一个已不存在的位置,用户「东西不见了」。
//   4. props 不变时父级重渲不得让行重渲 —— 行是 memo 组件,每次重渲都要
//      重建四个 handler 并让整棵侧栏树重渲(手柄拖拽时尤其明显)。
//      退化(去掉 memo / 每次造新 props)⇒ 侧栏滚动与拖拽掉帧。
//
// 变异思路(下列任一改动会红):
//   - handleDragOver / handleDragLeave / handleDrop 里把 folder.relPath
//     换成 folder.id(⇒ undefined)或 folder.name(⇒ 名字当 id)
//   - handleDragStart 的 useMemo 依赖去掉 folder
//   - handleDragOver 等的 useMemo 依赖去掉 folder.relPath
//   - 去掉外层 memo(⇒ 渲染稳定性用例红)
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { FolderRowOption } from '../../../../src/renderer/src/components/common/FolderChrome';
import type { DiskFolderNode } from '../../../../src/shared/types';

// 渲染计数探针:FolderRowOption 每次渲染都会调一次 useTranslation,
//   计数变化 = 行真的重渲了(不是「重新渲染了但输出一样」)。
const renderProbe = vi.hoisted(() => ({ count: 0 }));

// i18n:只关心交互,不关心文案;顺带当渲染探针。
vi.mock('react-i18next', () => ({
  useTranslation: () => {
    renderProbe.count += 1;
    return { t: (k: string) => k };
  },
}));

const FOLDER: DiskFolderNode = { relPath: 'a/b', name: 'b', parentRelPath: 'a' };

type RowProps = React.ComponentProps<typeof FolderRowOption>;

function makeProps(overrides: Partial<RowProps> = {}): RowProps {
  return {
    folder: FOLDER,
    domId: 'folder-row-a/b',
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
}

function renderRow(props: RowProps) {
  const utils = render(<FolderRowOption {...props} />);
  const row = utils.container.querySelector('[data-folder-relpath]') as HTMLElement;
  return { ...utils, row };
}

beforeEach(() => {
  renderProbe.count = 0;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('FolderRowOption 拖拽四件套:回调载荷契约', () => {
  it('dragstart 把当前 folder 对象交给父级', () => {
    const props = makeProps();
    const { row } = renderRow(props);
    fireEvent.dragStart(row);
    expect(props.onDragStart).toHaveBeenCalledTimes(1);
    expect((props.onDragStart as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe(FOLDER);
  });

  it('dragover / dragleave / drop 收到的是 folder.relPath(不是 name / parentRelPath)', () => {
    const props = makeProps();
    const { row } = renderRow(props);

    fireEvent.dragOver(row);
    fireEvent.dragLeave(row);
    fireEvent.drop(row);

    expect(props.onDragOver).toHaveBeenCalledTimes(1);
    expect(props.onDragLeave).toHaveBeenCalledTimes(1);
    expect(props.onDrop).toHaveBeenCalledTimes(1);
    for (const cb of [props.onDragOver, props.onDragLeave, props.onDrop]) {
      const [id] = (cb as ReturnType<typeof vi.fn>).mock.calls[0]!;
      // DiskFolderNode 没有 id 字段 —— relPath 就是它的 id 语义别名。
      expect(id).toBe('a/b');
      expect(id).not.toBeUndefined();
      expect(id).not.toBe('b'); // name
      expect(id).not.toBe('a'); // parentRelPath
    }
  });

  it('行 DOM 上的 data-folder-relpath 与 folder.relPath 一致(父级靠它定位行)', () => {
    const { row } = renderRow(makeProps());
    expect(row.getAttribute('data-folder-relpath')).toBe('a/b');
  });
});

describe('FolderRowOption 拖拽回调:不许 stale closure', () => {
  it('folder 换成新对象(改名)后,dragstart 交出的是新对象', () => {
    const props = makeProps();
    const { row, rerender } = renderRow(props);

    const renamed: DiskFolderNode = { relPath: 'a/b', name: 'b2', parentRelPath: 'a' };
    rerender(<FolderRowOption {...props} folder={renamed} />);

    fireEvent.dragStart(row);
    const [f] = (props.onDragStart as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(f).toBe(renamed);
    expect(f).not.toBe(FOLDER);
  });

  it('relPath 变了(文件夹被搬移)后,drop 收到的是**新** relPath', () => {
    const props = makeProps();
    const { row, rerender } = renderRow(props);

    const moved: DiskFolderNode = { relPath: 'x/c', name: 'c', parentRelPath: 'x' };
    rerender(<FolderRowOption {...props} folder={moved} />);

    fireEvent.drop(row);
    expect(props.onDrop).toHaveBeenCalledTimes(1);
    const [id] = (props.onDrop as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(id).toBe('x/c');
  });

  it('relPath 变了之后,dragover / dragleave 也跟着走新路径', () => {
    const props = makeProps();
    const { row, rerender } = renderRow(props);

    const moved: DiskFolderNode = { relPath: 'x/c', name: 'c', parentRelPath: 'x' };
    rerender(<FolderRowOption {...props} folder={moved} />);

    fireEvent.dragOver(row);
    fireEvent.dragLeave(row);
    expect((props.onDragOver as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe('x/c');
    expect((props.onDragLeave as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe('x/c');
  });
});

describe('FolderRowOption 渲染稳定性(memo 命中)', () => {
  it('props 引用不变时,父级重渲不会让行重渲', () => {
    const props = makeProps();
    const { rerender } = renderRow(props);
    expect(renderProbe.count).toBe(1);

    rerender(<FolderRowOption {...props} />);
    expect(renderProbe.count).toBe(1);

    rerender(<FolderRowOption {...props} />);
    expect(renderProbe.count).toBe(1);
  });

  it('folder 变了时行确实重渲(不能被过度 memo 锁死成旧数据)', () => {
    const props = makeProps();
    const { rerender } = renderRow(props);
    expect(renderProbe.count).toBe(1);

    const renamed: DiskFolderNode = { relPath: 'a/b', name: 'b2', parentRelPath: 'a' };
    rerender(<FolderRowOption {...props} folder={renamed} />);
    expect(renderProbe.count).toBe(2);
  });
});
