// tests/unit/renderer/store/notes-create-in-folder.test.ts
//
// 守 r175「新建笔记必须落在当前文件夹」契约。
//
// 旧实现:`create: async (filename, folderId) => { void folderId; … }` ——
// 目标目录被整个丢弃,笔记**永远**建在 notes 根。后果:
//
//   1. 在子文件夹视图里按「+ 新建」→ 文件落在 notes 根;
//   2. sidebar 的 visibleItemRows 按 dirname(relPath) === currentRelPath
//      过滤 → 当前文件夹里**看不到**刚建的笔记(用户视角 =「新建坏了」);
//   3. 文件落点与 UI 展示的文件夹不一致 —— 直接违反用户诉求
//      「左侧列表要和对应文件夹完全一致」。
//
// 本测锁:
//   A. folderId = 'sub' → createNote 收到 'sub/<name>.md';
//   B. folderId = null / undefined / '' (根) → createNote 收到裸文件名;
//   C. DUPLICATE_NAME 重试换名后,目录前缀**仍然带**(不能退到根);
//   D. 越界目录('.', '..')→ 归一到根,不把路径拼出 notes 子树。
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

interface MockApi {
  notesMove: ReturnType<typeof vi.fn>;
  litMove: ReturnType<typeof vi.fn>;
  listNotes: ReturnType<typeof vi.fn>;
  readNote: ReturnType<typeof vi.fn>;
  createNote: ReturnType<typeof vi.fn>;
  writeNote: ReturnType<typeof vi.fn>;
  onNotesChanged: ReturnType<typeof vi.fn>;
}

function setupMockApi(): MockApi {
  const api: MockApi = {
    notesMove: vi.fn(),
    litMove: vi.fn(),
    listNotes: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    readNote: vi.fn(),
    createNote: vi.fn(),
    writeNote: vi.fn(),
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

const created = (relPath: string) => ({
  id: 'id-1',
  relPath,
  filename: relPath.split('/').pop() ?? relPath,
  body: '',
  mtime: 0,
  tags: null,
  title: null,
});

describe('notes store create —— 落点跟随当前文件夹(r175)', () => {
  beforeEach(() => {
    setupMockApi();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('folderId = sub → createNote 收到 sub/<name>.md(旧实现丢弃目录,笔记落根)', async () => {
    const api = (globalThis as unknown as { window: { api: MockApi } }).window.api;
    api.createNote.mockResolvedValue({ ok: true, data: created('sub/未命名.md') });

    await useNotesStore.getState().create('未命名.md', 'sub');

    expect(api.createNote).toHaveBeenCalledTimes(1);
    expect(api.createNote).toHaveBeenCalledWith('sub/未命名.md');
  });

  it('folderId = null(根)→ createNote 收到裸文件名,不拼目录', async () => {
    const api = (globalThis as unknown as { window: { api: MockApi } }).window.api;
    api.createNote.mockResolvedValue({ ok: true, data: created('未命名.md') });

    await useNotesStore.getState().create('未命名.md', null);

    expect(api.createNote).toHaveBeenCalledWith('未命名.md');
  });

  it('folderId = undefined / 空串(根)→ 同样不拼目录', async () => {
    const api = (globalThis as unknown as { window: { api: MockApi } }).window.api;
    api.createNote.mockResolvedValue({ ok: true, data: created('未命名.md') });

    await useNotesStore.getState().create('未命名.md', undefined);
    await useNotesStore.getState().create('未命名.md', '');

    expect(api.createNote).toHaveBeenNthCalledWith(1, '未命名.md');
    expect(api.createNote).toHaveBeenNthCalledWith(2, '未命名.md');
  });

  it('多级目录(sub/deep)→ 整条路径都带上', async () => {
    const api = (globalThis as unknown as { window: { api: MockApi } }).window.api;
    api.createNote.mockResolvedValue({ ok: true, data: created('sub/deep/未命名.md') });

    await useNotesStore.getState().create('未命名.md', 'sub/deep');

    expect(api.createNote).toHaveBeenCalledWith('sub/deep/未命名.md');
  });

  it('DUPLICATE_NAME 重试换名后,目录前缀仍然带(不能退到根)', async () => {
    const api = (globalThis as unknown as { window: { api: MockApi } }).window.api;
    api.createNote
      .mockResolvedValueOnce({ ok: false, code: 'DUPLICATE_NAME', message: 'exists' })
      .mockResolvedValueOnce({ ok: true, data: created('sub/未命名 1-xxxx.md') });

    await useNotesStore.getState().create('未命名.md', 'sub');

    expect(api.createNote).toHaveBeenCalledTimes(2);
    expect(api.createNote).toHaveBeenNthCalledWith(1, 'sub/未命名.md');
    // 第二次换名后的路径仍带目录前缀
    expect(String(api.createNote.mock.calls[1]![0])).toMatch(/^sub\//);
  });

  it('越界目录(., ..)→ 归一到根,绝不把路径拼出 notes 子树', async () => {
    const api = (globalThis as unknown as { window: { api: MockApi } }).window.api;
    api.createNote.mockResolvedValue({ ok: true, data: created('未命名.md') });

    await useNotesStore.getState().create('未命名.md', '../evil');

    expect(api.createNote).toHaveBeenCalledWith('未命名.md');
  });

  it('越界段的各种写法(混合 / 中缀 / 单独)→ 一律归一到根', async () => {
    // '.', '..' 段整个丢掉是错的(会把 'sub/./x' 误降级到根,但拼出去也
    // 不安全);这里统一**整条归一到根** —— 越界时宁可落在根,也不能拼出
    // notes 子树之外的路径。sidebar 给的 currentId 永远是合法 relPath,
    // 这条只是防御性兜底。
    for (const target of ['../evil', 'sub/../../evil', '.', './x', 'sub/./x']) {
      const api = (globalThis as unknown as { window: { api: MockApi } }).window.api;
      api.createNote.mockResolvedValue({ ok: true, data: created('未命名.md') });

      await useNotesStore.getState().create('未命名.md', target);

      const called = String(api.createNote.mock.calls[0]![0]);
      expect(called).not.toContain('..');
      expect(called.endsWith('未命名.md')).toBe(true);
    }
  });

  it('返回的是主进程回的那份 note(含目录的 relPath)', async () => {
    const api = (globalThis as unknown as { window: { api: MockApi } }).window.api;
    api.createNote.mockResolvedValue({ ok: true, data: created('sub/未命名.md') });

    const note = await useNotesStore.getState().create('未命名.md', 'sub');

    expect(note.relPath).toBe('sub/未命名.md');
  });
});
