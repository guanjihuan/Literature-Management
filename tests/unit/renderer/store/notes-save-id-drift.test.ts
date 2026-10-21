// tests/unit/renderer/store/notes-save-id-drift.test.ts
//
// 守 r192「保存时 id 漂移」契约 —— 这是「造成数据丢失」的一条真实链路。
//
// 背景:
//   笔记 id = computeFileId(relPath)(相对 notes 根的路径哈希)。但读的时候
//   extractNoteId(note-id.ts)**优先取磁盘上的 frontmatter id**(兼容旧文件),
//   写的时候 writeNote(standalone.ts)又把 fm.id **重钉**为 computeFileId(relPath)
//   (r124 规则)⇒ 当磁盘上的 fm.id 与路径哈希不一致时,保存后 id 会变。
//
//   现实来源(不是理论):
//     - 用户在资源管理器里改了文件名 / 移动了文件(fm.id 还是旧路径的哈希);
//     - 从别的机器 / 别的工具拷进来的 .md(自带别的路径的 fm.id);
//     - 手改过 frontmatter。
//
// 旧行为(丢字):
//   主进程已把旧 byId 键 + 旧 DB 行删掉(新 id 建了新的),renderer 却还拿着
//   旧 id ⇒ **下一次自动保存必撞 NOT_FOUND** ⇒ 正文只进 failedDrafts
//   (纯内存)⇒ **重启即丢**;用户看到的只是「保存失败」红 badge。
//
// 本测锁:
//   1. save() 返回的 id 与请求 id 不同时,store 里**所有以 id 为键的状态**
//      (selectedId / selectedIds / anchorId / activeNoteFull / notes[])
//      全部换成新 id;
//   2. 换完之后的**下一次保存用的是新 id**(不再打旧 id —— 旧 id 已死);
//   3. 请求参数本身不变(expectedMtime 仍按旧 id 的快照走);
//   4. 没有漂移时,状态**不被动**(不回归)。
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
import type { StandaloneNote, StandaloneNoteSummary } from '../../../../src/shared/types';

const OLD_ID = 'aaaaaaaaaaaaaaaa';
const NEW_ID = 'bbbbbbbbbbbbbbbb';

function summary(id: string, mtime: number): StandaloneNoteSummary {
  return {
    id,
    relPath: 'n.md',
    filename: 'n.md',
    title: 'T',
    tags: null,
    mtime,
  };
}

function full(id: string, mtime: number, body: string): StandaloneNote {
  return {
    id,
    relPath: 'n.md',
    filename: 'n.md',
    title: 'T',
    tags: null,
    mtime,
    body,
  };
}

interface MockApi {
  writeNote: ReturnType<typeof vi.fn>;
  listNotes: ReturnType<typeof vi.fn>;
  onNotesChanged: ReturnType<typeof vi.fn>;
}

function setupMockApi(): MockApi {
  const api: MockApi = {
    writeNote: vi.fn(),
    listNotes: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    onNotesChanged: vi.fn().mockReturnValue(() => {}),
  };
  (globalThis as unknown as { window: { api: MockApi } }).window = { api };
  useNotesStore.setState({
    notes: [summary(OLD_ID, 1)],
    selectedIds: new Set<string>([OLD_ID]),
    selectedId: OLD_ID,
    anchorId: OLD_ID,
    activeNoteFull: full(OLD_ID, 1, 'v1'),
    clipboard: null,
    lastError: null,
    displayOrderById: {},
  });
  return api;
}

describe('notes store:保存时 id 漂移(r192)', () => {
  let api: MockApi;

  beforeEach(() => {
    api = setupMockApi();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('主进程返回新 id → selectedId / selectedIds / anchorId / activeNoteFull / 列表行全部换新 id', async () => {
    api.writeNote.mockResolvedValue({ ok: true, data: full(NEW_ID, 2, 'v2') });

    await useNotesStore.getState().save(OLD_ID, 'v2', 'T2');

    const st = useNotesStore.getState();
    expect(st.selectedId).toBe(NEW_ID);
    expect(st.selectedIds.has(NEW_ID)).toBe(true);
    expect(st.selectedIds.has(OLD_ID)).toBe(false);
    expect(st.anchorId).toBe(NEW_ID);
    expect(st.activeNoteFull?.id).toBe(NEW_ID);
    // 列表里那一行也要换成新 id —— 否则侧栏点开拿死 id ⇒ NOT_FOUND
    expect(st.notes.map((n) => n.id)).toEqual([NEW_ID]);
  });

  it('漂移之后下一次保存用**新 id**(旧 id 已死,再打过去必 NOT_FOUND)', async () => {
    api.writeNote.mockResolvedValueOnce({ ok: true, data: full(NEW_ID, 2, 'v2') });
    await useNotesStore.getState().save(OLD_ID, 'v2', 'T2');
    expect(api.writeNote).toHaveBeenCalledTimes(1);

    api.writeNote.mockResolvedValueOnce({ ok: true, data: full(NEW_ID, 3, 'v3') });
    await useNotesStore.getState().save(NEW_ID, 'v3', 'T3');

    // 第二次保存打的是新 id
    expect(api.writeNote).toHaveBeenLastCalledWith(NEW_ID, 'v3', 'T3', 2);
    expect(
      api.writeNote.mock.calls.some((call) => call[0] === OLD_ID && call[1] === 'v3'),
      '漂移后的保存不得再打旧 id',
    ).toBe(false);
  });

  it('请求参数不变:expectedMtime 仍按「请求发出时的 activeNoteFull 快照」走', async () => {
    api.writeNote.mockResolvedValue({ ok: true, data: full(NEW_ID, 2, 'v2') });
    await useNotesStore.getState().save(OLD_ID, 'v2', 'T2');
    expect(api.writeNote).toHaveBeenCalledWith(OLD_ID, 'v2', 'T2', 1);
  });

  it('没有漂移(返回 id === 请求 id)→ 状态原样,不做任何重映射', async () => {
    api.writeNote.mockResolvedValue({ ok: true, data: full(OLD_ID, 2, 'v2') });
    await useNotesStore.getState().save(OLD_ID, 'v2', 'T2');

    const st = useNotesStore.getState();
    expect(st.selectedId).toBe(OLD_ID);
    expect(st.activeNoteFull?.id).toBe(OLD_ID);
    expect(st.notes.map((n) => n.id)).toEqual([OLD_ID]);
    // 正文更新仍要落到列表行上
    expect(st.notes[0]!.mtime).toBe(2);
  });
});
