// tests/unit/renderer/store/notes-selection-survives-reload.test.ts
//
// 守 r193「列表刷新不该吃掉多选」契约。
//
// 现象(用户可复现):
//   1. 侧栏里 Ctrl 多选 3 篇笔记;
//   2. 侧栏发生一次**与这 3 篇无关**的刷新 —— 新建一篇 / 触发一次
//      NOTES_CHANGED 广播(另一个窗口写盘、chokidar 事件、网盘同步落盘……);
//   3. 按 Delete(或 Ctrl+X 剪切)→ **静默无反应**:菜单项在、点了没动静。
//
// 根因:notes store 的 load() 无条件 `selectedIds: new Set()` +
//   `anchorId: null`,而 load() 的调用点有一大把(create / trash / rename /
//   paste(copy) / NOTES_CHANGED 广播)。「防 stale id」的意图没错,但实现
//   过头了 —— 活着的 id 也被清掉。
//
// 两侧不对称(literature 的 loadImpl 从不清多选)⇒ 同一个「多选 → 删」的
// 动作在文献侧好用、在笔记侧不好用 —— 与用户诉求「两侧操作要对齐」冲突。
//
// 本测锁:
//   1. reload 后**活着的**多选 id 保留(且 Set 引用不变 —— 不引无谓重渲);
//   2. reload 后**已经不存在的** id 被剔掉(这才是 stale id 该防的);
//   3. 锚点(id)在列表里消失时置 null(否则 Shift 范围选择会算错);
//   4. 改名的笔记**跟着换 id**留在多选里(旧 id 已死,不该静默掉出选择)。
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
import type { StandaloneNoteSummary } from '../../../../src/shared/types';

function summary(id: string, relPath: string): StandaloneNoteSummary {
  return { id, relPath, filename: relPath, title: null, tags: null, mtime: 0 };
}

interface MockApi {
  listNotes: ReturnType<typeof vi.fn>;
  renameNoteFile: ReturnType<typeof vi.fn>;
  onNotesChanged: ReturnType<typeof vi.fn>;
}

function setupMockApi(): MockApi {
  const api: MockApi = {
    listNotes: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    renameNoteFile: vi.fn(),
    onNotesChanged: vi.fn().mockReturnValue(() => {}),
  };
  (globalThis as unknown as { window: { api: MockApi } }).window = { api };
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
  return api;
}

describe('notes store:刷新不吃掉多选(r193)', () => {
  let api: MockApi;

  beforeEach(() => {
    api = setupMockApi();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reload 后活着的多选 id 保留,Set 引用不变(不引无谓重渲)', async () => {
    useNotesStore.setState({
      notes: [summary('a', 'a.md'), summary('b', 'b.md')],
      selectedIds: new Set(['a', 'b']),
      anchorId: 'a',
    });
    const before = useNotesStore.getState().selectedIds;

    api.listNotes.mockResolvedValue({
      ok: true,
      data: [summary('a', 'a.md'), summary('b', 'b.md'), summary('c', 'c.md')],
    });
    await useNotesStore.getState().load();

    const st = useNotesStore.getState();
    expect([...st.selectedIds].sort()).toEqual(['a', 'b']);
    expect(st.selectedIds).toBe(before);
    expect(st.anchorId).toBe('a');
  });

  it('reload 后已经不存在的 id 被剔掉(这才是 stale id 该防的)', async () => {
    useNotesStore.setState({
      notes: [summary('a', 'a.md'), summary('b', 'b.md')],
      selectedIds: new Set(['a', 'b']),
      anchorId: 'b',
    });

    api.listNotes.mockResolvedValue({ ok: true, data: [summary('a', 'a.md')] });
    await useNotesStore.getState().load();

    const st = useNotesStore.getState();
    expect([...st.selectedIds]).toEqual(['a']);
    // 锚点没了 → 置 null(留着会让 Shift 范围选择算错区间)
    expect(st.anchorId).toBeNull();
  });

  it('改名的笔记跟着换 id 留在多选里(旧 id 已死,不该静默掉出选择)', async () => {
    useNotesStore.setState({
      notes: [summary('a', 'a.md'), summary('b', 'b.md')],
      selectedIds: new Set(['a', 'b']),
      anchorId: 'a',
    });

    api.renameNoteFile.mockResolvedValue({
      ok: true,
      data: { id: 'a2', relPath: 'a2.md', filename: 'a2.md', title: null, tags: null, mtime: 1 },
    });
    api.listNotes.mockResolvedValue({
      ok: true,
      data: [summary('a2', 'a2.md'), summary('b', 'b.md')],
    });

    await useNotesStore.getState().renameFile('a', 'a2.md');

    const st = useNotesStore.getState();
    expect([...st.selectedIds].sort()).toEqual(['a2', 'b']);
    expect(st.anchorId).toBe('a2');
  });
});
