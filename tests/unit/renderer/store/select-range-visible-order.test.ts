// tests/unit/renderer/store/select-range-visible-order.test.ts
//
// 守 audit-r243「Shift 范围选择的区间口径必须是**屏幕上可见的行序**」契约。
//
// 现象(用户可复现,文献域):
//   1. 侧栏切到「仅收藏」视图(只显示被收藏的 PDF);
//   2. 在第 1 行按住 Shift 点第 3 行 → 高亮 3 行,看起来没问题;
//   3. 但底层 store 的 items 里还有**没被收藏、被过滤掉**的文件。旧实现
//      `selectRange` 切的是 items 序(未过滤),区间两端之间的**每一个**
//      items 元素都被塞进 selectedIds —— 包括用户**根本没看见**的行;
//   4. 按 Delete → 确认框写「删除 N 个文件?」,随后把那些用户没看见、
//      也没打算选的文件**丢进回收站**。
//
// 根因:store 数组序 ≠ 屏幕行序。列表是**树状 + 过滤 + 自定义排序**的:
//   - 文献域 visibleItems 走 favFiltered / 文件夹过滤 / displayOrderById;
//   - 笔记域 visibleItems 走同样的过滤链。
//   store 的 items/notes 只是「磁盘事实」的全集。
//
// 修法:selectRange 多收一个 visibleIds(渲染序),用它的下标切区间。
//   不传 visibleIds 时退回 store 序(向后兼容旧调用点)。
//
// 本测锁三件事:
//   1. 传 visibleIds 时,区间**只含可见行**(被过滤掉的行不在 selectedIds);
//   2. 不传 visibleIds 时退回旧行为(store 序全量)—— 保证没接线的调用点
//      不会静默变成「只选一行」;
//   3. 锚点不在可见序里 / 目标不在可见序里 ⇒ 退化成单选(不越界选)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/renderer/src/store/workspace', () => ({
  useWorkspaceStore: {
    getState: () => ({
      pendingFocusNote: { hasPending: false, payload: null },
      consumeFocusNoteRequest: () => {},
    }),
  },
}));
vi.mock('../../../../src/renderer/src/lib/toast', () => ({
  useToast: {
    getState: () => ({ show: () => {} }),
  },
}));

import { useNotesStore } from '../../../../src/renderer/src/store/notes';
import { useLiteratureStore } from '../../../../src/renderer/src/store/literature';
import type {
  LiteratureResource,
  ResourceId,
  StandaloneNoteSummary,
} from '../../../../src/shared/types';

function note(id: string): StandaloneNoteSummary {
  return { id, relPath: `${id}.md`, filename: `${id}.md`, title: null, tags: null, mtime: 0 };
}

function lit(id: string): LiteratureResource {
  return {
    id: id as ResourceId,
    kind: 'literature',
    title: id,
    mtime: 0,
    size: 0,
    indexedAt: 0,
    absPath: `C:/root/literature/${id}.pdf`,
    relPath: `${id}.pdf`,
    rootId: 'r1',
    extractStatus: 'ok',
  };
}

describe('audit-r243:Shift 范围选择按可见行序切区间', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: { api: unknown } }).window = { api: {} };
    useNotesStore.setState({
      notes: [],
      selectedIds: new Set<string>(),
      selectedId: null,
      activeNoteFull: null,
      anchorId: null,
      clipboard: null,
      lastError: null,
      displayOrderById: {},
    });
    useLiteratureStore.setState({
      items: [],
      selectedIds: new Set<string>(),
      selectedId: null,
      anchorId: null,
      clipboard: null,
      loading: false,
      lastError: null,
      displayOrderById: {},
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('笔记域:传 visibleIds 时区间不含被过滤掉的行', () => {
    // store 全量序:a b c d e;屏幕(搜索过滤后)只显示 a c e
    useNotesStore.setState({
      notes: [note('a'), note('b'), note('c'), note('d'), note('e')],
      selectedIds: new Set(['a']),
      anchorId: 'a',
    });

    useNotesStore.getState().selectRange('c', ['a', 'c', 'e']);

    // 旧实现会选到 a b c(含看不见的 b);正确结果只含 a c
    expect([...useNotesStore.getState().selectedIds].sort()).toEqual(['a', 'c']);
  });

  it('文献域:传 visibleIds 时区间不含被过滤掉的行(仅收藏视图)', () => {
    // store 全量序:fav1 x1 fav2 x2 fav3;屏幕(仅收藏)只显示 fav1 fav2 fav3
    useLiteratureStore.setState({
      items: [lit('fav1'), lit('x1'), lit('fav2'), lit('x2'), lit('fav3')],
      selectedIds: new Set(['fav1']),
      anchorId: 'fav1',
    });

    useLiteratureStore.getState().selectRange('fav3', ['fav1', 'fav2', 'fav3']);

    // 旧实现会选到 fav1 x1 fav2 x2 fav3(4 个看不见/不存在的行被删)
    expect([...useLiteratureStore.getState().selectedIds].sort()).toEqual([
      'fav1',
      'fav2',
      'fav3',
    ]);
  });

  it('不传 visibleIds 时退回 store 序(旧调用点行为不变)', () => {
    useNotesStore.setState({
      notes: [note('a'), note('b'), note('c')],
      selectedIds: new Set(['a']),
      anchorId: 'a',
    });

    useNotesStore.getState().selectRange('c');

    expect([...useNotesStore.getState().selectedIds].sort()).toEqual(['a', 'b', 'c']);
  });

  it('锚点 / 目标不在可见序里 ⇒ 退化成单选(不越界选)', () => {
    useLiteratureStore.setState({
      items: [lit('fav1'), lit('x1'), lit('fav2')],
      selectedIds: new Set(['x1']),
      anchorId: 'x1',
    });

    // 锚点 x1 被过滤掉了 ⇒ 区间无意义 ⇒ 只选目标行
    useLiteratureStore.getState().selectRange('fav2', ['fav1', 'fav2']);
    expect([...useLiteratureStore.getState().selectedIds]).toEqual(['fav2']);

    // 目标不在可见序里 ⇒ 同样退化
    useLiteratureStore.setState({ selectedIds: new Set(['fav1']), anchorId: 'fav1' });
    useLiteratureStore.getState().selectRange('x1', ['fav1', 'fav2']);
    expect([...useLiteratureStore.getState().selectedIds]).toEqual(['x1']);
  });
});
