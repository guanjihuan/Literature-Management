// tests/unit/renderer/store/notes-cut-paste.test.ts
//
// 守卫:notes store 的 cut + paste(cut) + moveToFolder 三个 action 必须
//   真的发 IPC(api.notesMove),targetRelPath 取正确语义(空串 = 根;
//   null / undefined 视为根),失败累计 + 首个 throw。直接复用 r161+
//   链路 —— 在 r166 之前这些 action 走得是 placeholder, 这次行为级
//   接管后必须守住契约, 防止后续 r167+ 静默回退成「clear clipboard only」。
//
// 与 useFolderSidebar shim 的 moveItems 对齐 —— disk hook 直接走 IPC,
//   store path 不绕 disk hook(shim 的 onMoveItems 入口可选)以保证单元
//   测不必启动 React 渲染。
//
// 间接验证用户反馈「文件拖入文件夹 + 剪切粘贴有问题」:
//
// 1. cut 后不调 IPC, 只写 clipboard —— 这是设计(真正的搬移落在 paste,
//    类似 VS Code 的 cut-then-paste)。
// 2. paste(targetRelPath === '') 默认语义是把 rows 移到「根」。
// 3. paste(targetRelPath === null) 同 '' 语义,与 disk hook 对齐(
//    null = 根, store path 落库写 '' 是搬迁细节)。
// 4. paste(cut) 的逐条循环不会因头一条失败而吞后续(累计 errors 抛首条)。
// 5. paste(copy) 副本**直接建在目标目录**(createNote 一次到位,r170),
//    copy 模式剪贴板不消费。
// 6. moveToFolder 走 cut 的同一 IPC, 失败 throw + 不消费剪贴板;
//    成功消费(cut 模式下)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// store 顶层 import i18next;测试环境 i18next 不挂全局实例会被 init 调用
// 牵动 chrome → settings → toast 等重模块。mock 掉这两个 hook,store 本体
// 仍能跑(r166+ 不依赖 chrome 的实际形态,只 import 类型)。
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
  (globalThis as unknown as { window: { api: MockApi } }).window = {
    api,
  };
  // reset store 状态:cut afterEach 把 notes/selectedIds/clipboard 重置;再
  // 显式重置 selectedId/activeNoteFull 以防上一用例残留。
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

describe('notes store cut/paste/moveToFolder', () => {
  beforeEach(() => {
    setupMockApi();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('cut 写剪贴板,不立即调 IPC(等同 VS Code cut 语义)', () => {
    const api = (globalThis as unknown as { window: { api: MockApi } }).window.api;
    useNotesStore.setState({
      notes: [
        { id: 'a', relPath: 'a.md', filename: 'a.md', mtime: 0, tags: [], title: null },
        { id: 'b', relPath: 'b.md', filename: 'b.md', mtime: 0, tags: [], title: null },
      ],
      selectedIds: new Set(['a', 'b']),
    });
    useNotesStore.getState().cut();
    expect(useNotesStore.getState().clipboard).toEqual({ ids: ['a', 'b'], mode: 'cut' });
    expect(api.notesMove).not.toHaveBeenCalled();
  });

  it('paste(cut) 调 notesMove 每个 id 用目标 relPath,全成功清剪贴板', async () => {
    const api = (globalThis as unknown as { window: { api: MockApi } }).window.api;
    useNotesStore.setState({
      notes: [
        { id: 'a', relPath: 'a.md', filename: 'a.md', mtime: 0, tags: [], title: null },
        { id: 'b', relPath: 'b.md', filename: 'b.md', mtime: 0, tags: [], title: null },
      ],
      selectedIds: new Set(['a', 'b']),
    });
    useNotesStore.getState().cut();
    api.notesMove.mockResolvedValue({ ok: true, data: { id: 'a', relPath: 'a.md' } });
    await useNotesStore.getState().paste('foo');
    expect(api.notesMove).toHaveBeenCalledTimes(2);
    expect(api.notesMove).toHaveBeenNthCalledWith(1, 'a', 'foo');
    expect(api.notesMove).toHaveBeenNthCalledWith(2, 'b', 'foo');
    expect(useNotesStore.getState().clipboard).toBeNull();
  });

  it('paste(cut) targetRelPath=null 视为根(空串) — 与 disk hook 对齐', async () => {
    const api = (globalThis as unknown as { window: { api: MockApi } }).window.api;
    useNotesStore.setState({
      notes: [{ id: 'a', relPath: 'a.md', filename: 'a.md', mtime: 0, tags: [], title: null }],
      selectedIds: new Set(['a']),
    });
    useNotesStore.getState().cut();
    api.notesMove.mockResolvedValue({ ok: true, data: { id: 'a', relPath: 'a.md' } });
    await useNotesStore.getState().paste(null);
    expect(api.notesMove).toHaveBeenCalledWith('a', '');
  });

  it('paste(cut) 部分失败 → errors 累计并 throw,剪贴板保留', async () => {
    const api = (globalThis as unknown as { window: { api: MockApi } }).window.api;
    useNotesStore.setState({
      notes: [
        { id: 'a', relPath: 'a.md', filename: 'a.md', mtime: 0, tags: [], title: null },
        { id: 'b', relPath: 'b.md', filename: 'b.md', mtime: 0, tags: [], title: null },
      ],
      selectedIds: new Set(['a', 'b']),
    });
    useNotesStore.getState().cut();
    api.notesMove.mockImplementation((id: string) => {
      if (id === 'b') {
        return Promise.resolve({ ok: false, code: 'IO_ERROR', message: 'disk fail' });
      }
      return Promise.resolve({ ok: true, data: { id, relPath: `${id}.md` } });
    });
    await expect(useNotesStore.getState().paste('foo')).rejects.toThrowError(/failed 1\/2/);
    // 剪贴板未被消费(用户可重试)
    expect(useNotesStore.getState().clipboard).toEqual({ ids: ['a', 'b'], mode: 'cut' });
    // 两条 IPC 都发了(累计)
    expect(api.notesMove).toHaveBeenCalledTimes(2);
  });

  it('moveToFolder 全成功调 notesMove,成功消费剪贴板(cut)', async () => {
    const api = (globalThis as unknown as { window: { api: MockApi } }).window.api;
    useNotesStore.setState({
      notes: [
        { id: 'a', relPath: 'a.md', filename: 'a.md', mtime: 0, tags: [], title: null },
        { id: 'b', relPath: 'b.md', filename: 'b.md', mtime: 0, tags: [], title: null },
      ],
      selectedIds: new Set(['a', 'b']),
    });
    useNotesStore.getState().cut();
    api.notesMove.mockResolvedValue({ ok: true, data: { id: 'a', relPath: 'a.md' } });
    await useNotesStore.getState().moveToFolder(['a', 'b'], 'sub');
    expect(api.notesMove).toHaveBeenCalledTimes(2);
    expect(api.notesMove).toHaveBeenNthCalledWith(1, 'a', 'sub');
    expect(api.notesMove).toHaveBeenNthCalledWith(2, 'b', 'sub');
    expect(useNotesStore.getState().clipboard).toBeNull();
  });

  it('moveToFolder 0 ids 是 no-op,不调 IPC', async () => {
    const api = (globalThis as unknown as { window: { api: MockApi } }).window.api;
    await useNotesStore.getState().moveToFolder([], 'x');
    expect(api.notesMove).not.toHaveBeenCalled();
  });

  it('moveToFolder 失败 throw,剪贴板不动', async () => {
    const api = (globalThis as unknown as { window: { api: MockApi } }).window.api;
    useNotesStore.setState({
      notes: [{ id: 'a', relPath: 'a.md', filename: 'a.md', mtime: 0, tags: [], title: null }],
      selectedIds: new Set(['a']),
    });
    useNotesStore.getState().cut();
    api.notesMove.mockResolvedValue({ ok: false, code: 'NOT_FOUND', message: 'gone' });
    await expect(useNotesStore.getState().moveToFolder(['a'], 'x')).rejects.toThrowError(/failed/);
    expect(useNotesStore.getState().clipboard).toEqual({ ids: ['a'], mode: 'cut' });
  });

  it('paste(cut) 成功后,被搬移的 selectedId + activeNoteFull 重映射到 IPC 响应给的 (新 id, 新 relPath)', async () => {
    const api = (globalThis as unknown as { window: { api: MockApi } }).window.api;
    // 模拟「编辑中的笔记被搬移」:cut 取的 ids 由 selectedIds 在 notes[] 里
    //   的交集决定,所以 notes 必须含旧 id 'a',否则 cut() 早返。
    const NEW_ID = 'new-a';
    const NEW_REL = 'foo/a.md';
    const oldFull: import('../../../../src/shared/types').StandaloneNote = {
      id: 'a',
      relPath: 'a.md',
      filename: 'a.md',
      body: 'old content',
      mtime: 0,
      tags: null,
      title: null,
    };
    useNotesStore.setState({
      notes: [{ id: 'a', relPath: 'a.md', filename: 'a.md', mtime: 0, tags: [], title: null }],
      selectedId: 'a',
      activeNoteFull: oldFull,
      selectedIds: new Set(['a']),
    });
    useNotesStore.getState().cut();
    api.notesMove.mockResolvedValue({ ok: true, data: { id: NEW_ID, relPath: NEW_REL } });
    await useNotesStore.getState().paste('foo');
    const cur = useNotesStore.getState();
    // 重映射契约:被搬移的笔记被编辑中,selectedId 必须跳到新 id,
    //   activeNoteFull 同步刷 id/relPath/filename(body 不变);
    //   不重映射会让后续 save 撞 NOT_FOUND(这是用户报告的隐性回归)。
    expect(cur.selectedId).toBe(NEW_ID);
    expect(cur.activeNoteFull?.id).toBe(NEW_ID);
    expect(cur.activeNoteFull?.relPath).toBe(NEW_REL);
    expect(cur.activeNoteFull?.filename).toBe('a.md'); // basename('foo/a.md')
    expect(cur.activeNoteFull?.body).toBe('old content'); // body 不变
  });

  it('paste(cut) 成功后,未参与搬移的 selectedId 不动(id 不在 idRemap 内)', async () => {
    const api = (globalThis as unknown as { window: { api: MockApi } }).window.api;
    useNotesStore.setState({
      notes: [{ id: 'b', relPath: 'b.md', filename: 'b.md', mtime: 0, tags: [], title: null }],
      selectedId: 'b', // 不在 clip.ids 里
      activeNoteFull: null,
      selectedIds: new Set(['a']), // 多选 a 但 selectedId 单选 b
    });
    useNotesStore.getState().cut();
    api.notesMove.mockResolvedValue({ ok: true, data: { id: 'new-a', relPath: 'foo/a.md' } });
    await useNotesStore.getState().paste('foo');
    expect(useNotesStore.getState().selectedId).toBe('b');
  });

  it('r168:applyMoveRemap 是 store public action —— drag-into-folder 路径回调用', () => {
    // 守卫 store 公开 surface,防止后续误把 applyMoveRemap 改 private 让
    //   NotesList.tsx 的 handleItemsMoved 断路径(typecheck 会捕,行为级也锁)。
    const oldFull: import('../../../../src/shared/types').StandaloneNote = {
      id: 'a',
      relPath: 'a.md',
      filename: 'a.md',
      body: 'old content',
      mtime: 0,
      tags: null,
      title: null,
    };
    useNotesStore.setState({
      selectedId: 'a',
      activeNoteFull: oldFull,
    });
    const remap = new Map<string, { id: string; relPath?: string; absPath?: string }>();
    remap.set('a', { id: 'new-a', relPath: 'foo/a.md' });
    useNotesStore.getState().applyMoveRemap(remap);
    const cur = useNotesStore.getState();
    expect(cur.selectedId).toBe('new-a');
    expect(cur.activeNoteFull?.id).toBe('new-a');
    expect(cur.activeNoteFull?.relPath).toBe('foo/a.md');
    expect(cur.activeNoteFull?.filename).toBe('a.md');
  });

  it('r168:applyMoveRemap 收到空 map = no-op', () => {
    useNotesStore.setState({ selectedId: 'a' });
    useNotesStore.getState().applyMoveRemap(new Map());
    expect(useNotesStore.getState().selectedId).toBe('a');
  });

  it('r168:applyMoveRemap id 不在 map 内 = no-op(selectedId 不动)', () => {
    useNotesStore.setState({ selectedId: 'a' });
    const remap = new Map<string, { id: string; relPath?: string; absPath?: string }>();
    remap.set('other', { id: 'new-other', relPath: 'foo/other.md' });
    useNotesStore.getState().applyMoveRemap(remap);
    expect(useNotesStore.getState().selectedId).toBe('a');
  });

  it('r168:applyMoveRemap relPath 缺失 → 只刷 selectedId,不刷 activeFull(防御 miswire)', () => {
    const oldFull: import('../../../../src/shared/types').StandaloneNote = {
      id: 'a',
      relPath: 'a.md',
      filename: 'a.md',
      body: 'old',
      mtime: 0,
      tags: null,
      title: null,
    };
    useNotesStore.setState({
      selectedId: 'a',
      activeNoteFull: oldFull,
    });
    const remap = new Map<string, { id: string; relPath?: string; absPath?: string }>();
    remap.set('a', { id: 'new-a' }); // relPath 缺失
    useNotesStore.getState().applyMoveRemap(remap);
    const cur = useNotesStore.getState();
    expect(cur.selectedId).toBe('new-a');
    // activeFull 不动(避免把 undefined 写进去)
    expect(cur.activeNoteFull?.id).toBe('a');
  });
});

// r170:copy 分支重写 —— 副本**直接建在目标目录**(一次 createNote)。
//
// 用户报的「粘贴功能有问题」在复制路径上是**必现**故障:旧实现副本名是
// 「X (copy).md」,圆括号被 filename-validator 拒 → 每一次复制粘贴都抛
// ValidationError,副本一个都建不出来。旧实现另有三处连带缺陷:
//   - base 取 stripExt(src.relPath) 保留目录前缀 → 副本建在源目录(嵌套)
//   - 目标 = 根时整段 notesMove 被跳过 → 副本留在源目录
//   - move 之后 frontmatter id 重算 → newIds 变 stale,选中指向死 id
// 新契约(本块逐条锁):
//   1. createNote 直接收到 '<targetDir>/<base> (copy).md'
//   2. 副本名不含源目录前缀
//   3. 目标 = 根(null/undefined)同样直接建在根
//   4. 撞名避让只看目标目录内既有文件
//   5. 主进程 DUPLICATE_NAME → 自动换下一个候选名重试
//   6. 单条失败隔离:其余副本照常落地 + 选中,聚合错抛出,剪贴板保留
describe('notes store paste(copy) —— 副本直接落在目标目录(r170)', () => {
  beforeEach(() => {
    setupMockApi();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  const summary = (id: string, relPath: string, filename: string) => ({
    id,
    relPath,
    filename,
    mtime: 0,
    tags: [] as string[],
    title: null,
  });

  const full = (id: string, relPath: string, filename: string) => ({
    id,
    relPath,
    filename,
    body: 'BODY',
    mtime: 0,
    tags: null,
    title: 'TITLE',
  });

  it('副本直接建在目标目录:createNote 收到 <target>/<name>.md,不再走 notesMove', async () => {
    const api = (globalThis as unknown as { window: { api: MockApi } }).window.api;
    useNotesStore.setState({
      notes: [summary('a', 'a.md', 'a.md')],
      selectedIds: new Set(['a']),
    });
    useNotesStore.getState().copy();
    api.readNote.mockResolvedValue({ ok: true, data: full('a', 'a.md', 'a.md') });
    api.createNote.mockResolvedValue({
      ok: true,
      data: full('new-a', 'sub/a (copy).md', 'a (copy).md'),
    });
    api.writeNote.mockResolvedValue({
      ok: true,
      data: full('new-a', 'sub/a (copy).md', 'a (copy).md'),
    });
    await useNotesStore.getState().paste('sub');
    // 一次 createNote 落在目标目录 —— 不再 create(根)→ move(目标)两段
    expect(api.createNote).toHaveBeenCalledTimes(1);
    expect(api.createNote).toHaveBeenCalledWith('sub/a (copy).md');
    expect(api.notesMove).not.toHaveBeenCalled();
    // 副本 id 就是最终 id(没搬移 ⇒ frontmatter id 不重算)
    expect([...useNotesStore.getState().selectedIds]).toEqual(['new-a']);
  });

  it('副本名不含源目录前缀(源在 src/ 下,目标 dst/ → dst/a (copy).md)', async () => {
    const api = (globalThis as unknown as { window: { api: MockApi } }).window.api;
    useNotesStore.setState({
      notes: [summary('a', 'src/a.md', 'a.md')],
      selectedIds: new Set(['a']),
    });
    useNotesStore.getState().copy();
    api.readNote.mockResolvedValue({ ok: true, data: full('a', 'src/a.md', 'a.md') });
    api.createNote.mockResolvedValue({
      ok: true,
      data: full('new-a', 'dst/a (copy).md', 'a (copy).md'),
    });
    api.writeNote.mockResolvedValue({
      ok: true,
      data: full('new-a', 'dst/a (copy).md', 'a (copy).md'),
    });
    await useNotesStore.getState().paste('dst');
    expect(api.createNote).toHaveBeenCalledWith('dst/a (copy).md');
  });

  it('目标 = 根(null)时副本也直接建在根(旧实现整段 move 被跳过,副本留在源目录)', async () => {
    const api = (globalThis as unknown as { window: { api: MockApi } }).window.api;
    useNotesStore.setState({
      notes: [summary('a', 'src/a.md', 'a.md')],
      selectedIds: new Set(['a']),
    });
    useNotesStore.getState().copy();
    api.readNote.mockResolvedValue({ ok: true, data: full('a', 'src/a.md', 'a.md') });
    api.createNote.mockResolvedValue({
      ok: true,
      data: full('new-a', 'a (copy).md', 'a (copy).md'),
    });
    api.writeNote.mockResolvedValue({
      ok: true,
      data: full('new-a', 'a (copy).md', 'a (copy).md'),
    });
    await useNotesStore.getState().paste(null);
    expect(api.createNote).toHaveBeenCalledWith('a (copy).md');
    expect(api.notesMove).not.toHaveBeenCalled();
  });

  it('撞名避让只看目标目录:目标已有 a (copy).md → 副本名退到 a (copy 2).md', async () => {
    const api = (globalThis as unknown as { window: { api: MockApi } }).window.api;
    useNotesStore.setState({
      notes: [
        summary('a', 'a.md', 'a.md'),
        // 目标目录里已有一份副本
        summary('x', 'sub/a (copy).md', 'a (copy).md'),
        // 别的目录的同名文件不该干扰
        summary('y', 'other/a (copy).md', 'a (copy).md'),
      ],
      selectedIds: new Set(['a']),
    });
    useNotesStore.getState().copy();
    api.readNote.mockResolvedValue({ ok: true, data: full('a', 'a.md', 'a.md') });
    api.createNote.mockResolvedValue({
      ok: true,
      data: full('new-a', 'sub/a (copy 2).md', 'a (copy 2).md'),
    });
    api.writeNote.mockResolvedValue({
      ok: true,
      data: full('new-a', 'sub/a (copy 2).md', 'a (copy 2).md'),
    });
    await useNotesStore.getState().paste('sub');
    expect(api.createNote).toHaveBeenCalledWith('sub/a (copy 2).md');
  });

  it('主进程 DUPLICATE_NAME → 自动换下一个候选名重试(本地 taken 是 stale 快照)', async () => {
    const api = (globalThis as unknown as { window: { api: MockApi } }).window.api;
    useNotesStore.setState({
      notes: [summary('a', 'a.md', 'a.md')],
      selectedIds: new Set(['a']),
    });
    useNotesStore.getState().copy();
    api.readNote.mockResolvedValue({ ok: true, data: full('a', 'a.md', 'a.md') });
    api.createNote
      .mockResolvedValueOnce({ ok: false, code: 'DUPLICATE_NAME', message: 'exists' })
      .mockResolvedValueOnce({
        ok: true,
        data: full('new-a', 'a (copy 2).md', 'a (copy 2).md'),
      });
    api.writeNote.mockResolvedValue({
      ok: true,
      data: full('new-a', 'a (copy 2).md', 'a (copy 2).md'),
    });
    await useNotesStore.getState().paste('');
    expect(api.createNote).toHaveBeenCalledTimes(2);
    expect(api.createNote).toHaveBeenNthCalledWith(1, 'a (copy).md');
    expect(api.createNote).toHaveBeenNthCalledWith(2, 'a (copy 2).md');
  });

  it('单条失败隔离:一条读失败,另一条照常落地并被选中;聚合错抛出,剪贴板保留', async () => {
    const api = (globalThis as unknown as { window: { api: MockApi } }).window.api;
    useNotesStore.setState({
      notes: [summary('a', 'a.md', 'a.md'), summary('b', 'b.md', 'b.md')],
      selectedIds: new Set(['a', 'b']),
    });
    useNotesStore.getState().copy();
    api.readNote.mockImplementation((id: string) => {
      if (id === 'a') return Promise.reject(new Error('read boom'));
      return Promise.resolve({ ok: true, data: full('b', 'b.md', 'b.md') });
    });
    api.createNote.mockResolvedValue({
      ok: true,
      data: full('new-b', 'b (copy).md', 'b (copy).md'),
    });
    api.writeNote.mockResolvedValue({
      ok: true,
      data: full('new-b', 'b (copy).md', 'b (copy).md'),
    });
    await expect(useNotesStore.getState().paste('')).rejects.toThrowError(/failed 1\/2/);
    // 成功的那条照常落地 + 选中
    expect(api.createNote).toHaveBeenCalledTimes(1);
    expect([...useNotesStore.getState().selectedIds]).toEqual(['new-b']);
    // copy 模式剪贴板保留(可重试)
    expect(useNotesStore.getState().clipboard).toEqual({ ids: ['a', 'b'], mode: 'copy' });
  });

  it('copy 模式不消费剪贴板(可重复粘贴)', async () => {
    const api = (globalThis as unknown as { window: { api: MockApi } }).window.api;
    useNotesStore.setState({
      notes: [summary('a', 'a.md', 'a.md')],
      selectedIds: new Set(['a']),
    });
    useNotesStore.getState().copy();
    api.readNote.mockResolvedValue({ ok: true, data: full('a', 'a.md', 'a.md') });
    api.createNote.mockResolvedValue({
      ok: true,
      data: full('new-a', 'a (copy).md', 'a (copy).md'),
    });
    api.writeNote.mockResolvedValue({
      ok: true,
      data: full('new-a', 'a (copy).md', 'a (copy).md'),
    });
    await useNotesStore.getState().paste('');
    expect(useNotesStore.getState().clipboard).toEqual({ ids: ['a'], mode: 'copy' });
  });
});
