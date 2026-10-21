// tests/unit/renderer/store/move-remap.test.ts
//
// 守卫(r175):搬移之后 **id 重映射必须覆盖 selectedIds(复数选中集)**,
//   且 moveToFolder 必须把 idRemap 交回给 caller。
//
// 背景 —— 两处真实缺陷:
//
// 1. applyMoveRemapImpl / applyLitMoveRemapImpl 只刷单数 selectedId,
//    复数 selectedIds 里留着**已不存在的旧 id**(fs.rename 后 id 随
//    relPath / absPath 重算)。窗口期(NOTES_CHANGED 推送触发 load()
//    清空 selectedIds 之前,约 50~500ms)用户按 Delete / Ctrl+X:
//      - cut/copy:ids = notes.filter(n => selectedIds.has(n.id)) → 空
//        → 剪贴板不落,「按了没反应」
//      - trash:按 selectedIds 过滤 → 一条都删不掉(静默)
//
// 2. moveToFolder 原来返回 void,caller 拿不到 oldId → newId 映射。
//    NotesList.importFiles 因此在「导入到子文件夹」后用**搬移前**的
//    createdIds 去 select —— 选到一个死 id,右侧 NotesView 报 NOT_FOUND,
//    用户看到「导入成功却打不开」。文献侧同款路径早已用搬移后的 id。
//
// 契约锁定:
//   - moveToFolder 全成功 → 返回完整 idRemap Map
//   - moveToFolder 部分失败 → throw,但 error.idRemap 带**成功那部分**的
//     映射,且成功那部分的重映射同样已经落到 store(已搬走的 id 确实变了)
//   - applyMoveRemap / moveToFolder 两条路径都把 selectedIds 里的旧 id
//     换成新 id
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
import type { ResourceId } from '../../../../src/shared/types';

interface MockApi {
  notesMove: ReturnType<typeof vi.fn>;
  litMove: ReturnType<typeof vi.fn>;
  listNotes: ReturnType<typeof vi.fn>;
  listLiterature: ReturnType<typeof vi.fn>;
  onNotesChanged: ReturnType<typeof vi.fn>;
  onLiteratureChanged: ReturnType<typeof vi.fn>;
}

function setupMockApi(): MockApi {
  const api: MockApi = {
    notesMove: vi.fn(),
    litMove: vi.fn(),
    listNotes: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    listLiterature: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    onNotesChanged: vi.fn().mockReturnValue(() => {}),
    onLiteratureChanged: vi.fn().mockReturnValue(() => {}),
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
  useLiteratureStore.setState({
    items: [],
    selectedIds: new Set<string>(),
    selectedId: null,
    anchorId: null,
    clipboard: null,
    lastError: null,
    displayOrderById: {},
  });
  return api;
}

describe('搬移后的 id 重映射(r175)', () => {
  beforeEach(() => {
    setupMockApi();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('notes moveToFolder 全成功 → 返回 oldId→newId 映射', async () => {
    const api = (globalThis as unknown as { window: { api: MockApi } }).window.api;
    api.notesMove.mockImplementation((id: string) =>
      Promise.resolve({ ok: true, data: { id: `${id}-new`, relPath: `sub/${id}.md` } }),
    );
    const remap = await useNotesStore.getState().moveToFolder(['a', 'b'], 'sub');
    expect(remap.get('a')).toEqual({ id: 'a-new', relPath: 'sub/a.md' });
    expect(remap.get('b')).toEqual({ id: 'b-new', relPath: 'sub/b.md' });
  });

  it('notes moveToFolder 把 selectedIds 里的旧 id 换成新 id', async () => {
    const api = (globalThis as unknown as { window: { api: MockApi } }).window.api;
    api.notesMove.mockImplementation((id: string) =>
      Promise.resolve({ ok: true, data: { id: `${id}-new`, relPath: `sub/${id}.md` } }),
    );
    useNotesStore.setState({
      notes: [
        { id: 'a', relPath: 'a.md', filename: 'a.md', mtime: 0, tags: [], title: null },
        { id: 'b', relPath: 'b.md', filename: 'b.md', mtime: 0, tags: [], title: null },
      ],
      selectedIds: new Set(['a', 'b']),
      selectedId: 'a',
    });
    await useNotesStore.getState().moveToFolder(['a', 'b'], 'sub');
    const st = useNotesStore.getState();
    // 单数:编辑器打开态跟到新 id
    expect(st.selectedId).toBe('a-new');
    // 复数:多选集合里**不能**留着已不存在的旧 id
    expect(st.selectedIds.has('a')).toBe(false);
    expect(st.selectedIds.has('b')).toBe(false);
    expect(st.selectedIds.has('a-new')).toBe(true);
    expect(st.selectedIds.has('b-new')).toBe(true);
  });

  it('notes moveToFolder 部分失败 → throw,但 error.idRemap 带成功那部分', async () => {
    const api = (globalThis as unknown as { window: { api: MockApi } }).window.api;
    api.notesMove.mockImplementation((id: string) => {
      if (id === 'b') {
        return Promise.resolve({ ok: false, code: 'IO_ERROR', message: 'disk fail' });
      }
      return Promise.resolve({ ok: true, data: { id: `${id}-new`, relPath: `sub/${id}.md` } });
    });
    useNotesStore.setState({
      selectedIds: new Set(['a', 'b']),
      selectedId: null,
    });
    let caught: unknown = null;
    try {
      await useNotesStore.getState().moveToFolder(['a', 'b'], 'sub');
    } catch (err: unknown) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const remap = (caught as { idRemap?: Map<string, { id: string }> }).idRemap;
    expect(remap).toBeInstanceOf(Map);
    expect(remap?.get('a')?.id).toBe('a-new');
    expect(remap?.has('b')).toBe(false);
    // 成功搬走的那条,复数选中集也要跟着换
    expect(useNotesStore.getState().selectedIds.has('a-new')).toBe(true);
    expect(useNotesStore.getState().selectedIds.has('a')).toBe(false);
  });

  it('notes applyMoveRemap(drag 路径)同样把 selectedIds 的旧 id 换成新 id', () => {
    useNotesStore.setState({
      selectedIds: new Set(['a', 'z']),
      selectedId: 'a',
    });
    useNotesStore.getState().applyMoveRemap(
      new Map([['a', { id: 'a-new', relPath: 'sub/a.md' }]]),
    );
    const st = useNotesStore.getState();
    expect(st.selectedId).toBe('a-new');
    expect(st.selectedIds.has('a')).toBe(false);
    expect(st.selectedIds.has('a-new')).toBe(true);
    // 不在搬移集合内的成员保持原样
    expect(st.selectedIds.has('z')).toBe(true);
  });

  it('literature moveToFolder 把 selectedIds 里的旧 id 换成新 id', async () => {
    const api = (globalThis as unknown as { window: { api: MockApi } }).window.api;
    api.litMove.mockImplementation((id: string) =>
      Promise.resolve({ ok: true, data: { id: `${id}-new`, absPath: `/root/sub/${id}.pdf` } }),
    );
    useLiteratureStore.setState({
      items: [],
      selectedIds: new Set(['a', 'b']),
      selectedId: 'a' as ResourceId,
    });
    await useLiteratureStore.getState().moveToFolder(['a', 'b'], 'sub');
    const st = useLiteratureStore.getState();
    expect(st.selectedId).toBe('a-new');
    expect(st.selectedIds.has('a')).toBe(false);
    expect(st.selectedIds.has('b')).toBe(false);
    expect(st.selectedIds.has('a-new')).toBe(true);
    expect(st.selectedIds.has('b-new')).toBe(true);
  });

  it('literature applyMoveRemap(drag 路径)同样把 selectedIds 的旧 id 换成新 id', () => {
    useLiteratureStore.setState({
      selectedIds: new Set(['a']),
      selectedId: 'a' as ResourceId,
    });
    useLiteratureStore.getState().applyMoveRemap(new Map([['a', { id: 'a-new' }]]));
    const st = useLiteratureStore.getState();
    expect(st.selectedId).toBe('a-new');
    expect(st.selectedIds.has('a')).toBe(false);
    expect(st.selectedIds.has('a-new')).toBe(true);
  });
});
