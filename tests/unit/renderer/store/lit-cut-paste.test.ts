// tests/unit/renderer/store/lit-cut-paste.test.ts
//
// 守卫:literature store 的 cut + paste(cut) + moveToFolder 在 r167 必须
//   走 api.litMove IPC,失败累计 + 首个 throw。以及 r167 落地的 selectedId
//   重映射 —— 跨目录搬移改 id 后若编辑器选中该资源,selectedId 必须跳到
//   新 id,否则后续读 absPath / 重开 PDF 会撞 NOT_FOUND。
//
// 与 notes-cut-paste.test.ts 同源,只换 api.litMove / literature store。
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

import { useLiteratureStore } from '../../../../src/renderer/src/store/literature';
import type { LiteratureResource } from '../../../../src/shared/types';

interface MockApi {
  litMove: ReturnType<typeof vi.fn>;
  listLiterature: ReturnType<typeof vi.fn>;
  importLiteratureFromFile: ReturnType<typeof vi.fn>;
  onLiteratureChanged: ReturnType<typeof vi.fn>;
}

function makeItem(id: string, absPath: string): LiteratureResource {
  return {
    id: id as unknown as LiteratureResource['id'],
    kind: 'literature',
    absPath,
    rootId: null,
    extractStatus: 'ok',
    title: '',
    mtime: 0,
    size: 0,
    indexedAt: 0,
  };
}

function setupMockApi(): MockApi {
  const api: MockApi = {
    litMove: vi.fn(),
    listLiterature: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    importLiteratureFromFile: vi.fn(),
    onLiteratureChanged: vi.fn().mockReturnValue(() => {}),
  };
  (globalThis as unknown as { window: { api: MockApi } }).window = { api };
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

describe('literature store cut/paste/moveToFolder', () => {
  beforeEach(() => setupMockApi());
  afterEach(() => vi.clearAllMocks());

  it('cut 写剪贴板,不立即调 IPC', () => {
    const api = (globalThis as unknown as { window: { api: MockApi } }).window.api;
    useLiteratureStore.setState({
      items: [makeItem('l1', 'l1.pdf'), makeItem('l2', 'l2.pdf')],
      selectedIds: new Set(['l1', 'l2']),
    });
    useLiteratureStore.getState().cut();
    expect(useLiteratureStore.getState().clipboard).toEqual({
      ids: ['l1', 'l2'],
      mode: 'cut',
    });
    expect(api.litMove).not.toHaveBeenCalled();
  });

  it('paste(cut) 调 litMove 每个 id 用目标 relPath', async () => {
    const api = (globalThis as unknown as { window: { api: MockApi } }).window.api;
    useLiteratureStore.setState({
      items: [makeItem('l1', 'l1.pdf'), makeItem('l2', 'l2.pdf')],
      selectedIds: new Set(['l1', 'l2']),
    });
    useLiteratureStore.getState().cut();
    api.litMove.mockResolvedValue({ ok: true, data: { id: 'l1', relPath: 'foo/l1.pdf' } });
    await useLiteratureStore.getState().paste('foo');
    expect(api.litMove).toHaveBeenCalledTimes(2);
    expect(api.litMove).toHaveBeenNthCalledWith(1, 'l1', 'foo');
    expect(api.litMove).toHaveBeenNthCalledWith(2, 'l2', 'foo');
  });

  it('paste(cut) 部分失败 throw,剪贴板保留可重试', async () => {
    const api = (globalThis as unknown as { window: { api: MockApi } }).window.api;
    useLiteratureStore.setState({
      items: [makeItem('l1', 'l1.pdf'), makeItem('l2', 'l2.pdf')],
      selectedIds: new Set(['l1', 'l2']),
    });
    useLiteratureStore.getState().cut();
    api.litMove.mockImplementation((id: string) => {
      if (id === 'l2') {
        return Promise.resolve({ ok: false, code: 'IO_ERROR', message: 'disk fail' });
      }
      return Promise.resolve({ ok: true, data: { id, relPath: 'foo/' + id + '.pdf' } });
    });
    await expect(useLiteratureStore.getState().paste('foo')).rejects.toThrowError(/failed 1\/2/);
    expect(useLiteratureStore.getState().clipboard).toEqual({
      ids: ['l1', 'l2'],
      mode: 'cut',
    });
  });

  it('paste(cut) 成功后被搬移的 selectedId 重映射到 IPC 响应的新 id', async () => {
    const api = (globalThis as unknown as { window: { api: MockApi } }).window.api;
    const NEW_ID = 'new-l1';
    const NEW_REL = 'foo/l1.pdf';
    useLiteratureStore.setState({
      items: [makeItem('l1', 'l1.pdf')],
      selectedId: 'l1' as unknown as null,
      selectedIds: new Set(['l1']),
    });
    useLiteratureStore.getState().cut();
    api.litMove.mockResolvedValue({ ok: true, data: { id: NEW_ID, relPath: NEW_REL } });
    await useLiteratureStore.getState().paste('foo');
    expect(useLiteratureStore.getState().selectedId).toBe(NEW_ID);
  });

  it('moveToFolder 0 ids 是 no-op', async () => {
    const api = (globalThis as unknown as { window: { api: MockApi } }).window.api;
    await useLiteratureStore.getState().moveToFolder([], 'x');
    expect(api.litMove).not.toHaveBeenCalled();
  });

  it('moveToFolder 失败 throw,剪贴板不动', async () => {
    const api = (globalThis as unknown as { window: { api: MockApi } }).window.api;
    useLiteratureStore.setState({
      items: [makeItem('l1', 'l1.pdf')],
      selectedIds: new Set(['l1']),
    });
    useLiteratureStore.getState().cut();
    api.litMove.mockResolvedValue({ ok: false, code: 'NOT_FOUND', message: 'gone' });
    await expect(useLiteratureStore.getState().moveToFolder(['l1'], 'x')).rejects.toThrowError(
      /failed/,
    );
    expect(useLiteratureStore.getState().clipboard).toEqual({ ids: ['l1'], mode: 'cut' });
  });

  it('r168:applyMoveRemap 是 store public action —— LiteratureList 回调回写', () => {
    useLiteratureStore.setState({
      selectedId: 'l1' as unknown as null,
    });
    const remap = new Map<string, { id: string; relPath?: string; absPath?: string }>();
    remap.set('l1', { id: 'new-l1', absPath: 'foo/l1.pdf' });
    useLiteratureStore.getState().applyMoveRemap(remap);
    expect(useLiteratureStore.getState().selectedId).toBe('new-l1');
  });

  it('r168:applyMoveRemap 空 map / id 不匹配 都是 no-op', () => {
    useLiteratureStore.setState({ selectedId: 'l1' as unknown as null });
    useLiteratureStore.getState().applyMoveRemap(new Map());
    expect(useLiteratureStore.getState().selectedId).toBe('l1');
    const remap = new Map<string, { id: string; relPath?: string; absPath?: string }>();
    remap.set('other', { id: 'new-other', absPath: 'foo/other.pdf' });
    useLiteratureStore.getState().applyMoveRemap(remap);
    expect(useLiteratureStore.getState().selectedId).toBe('l1');
  });
});

// r170:literature copy 分支两处修正。
//
// 1. **搬移后 id 会变** —— lit id = 'lit:'+toPosix(absPath),搬进子目录
//    absPath 变 → id 变。旧实现只判 `r.ok` 把 r.data.id 丢掉,末尾
//    `set({ selectedIds: new Set(newIds) })` 存的是**搬移前**的 id →
//    选中的行在 UI 里不存在(点不开 / Reader 拿不到)。这是「复制粘贴进
//    文件夹后选不中」的直接原因。
// 2. 失败可见 —— 旧实现在 store 内部调 `api.pushToast` 弹部分失败 toast,
//    但 **preload 的 Api 接口里没有 pushToast**(grep 零命中)→ 生产恒走
//    else 分支只 log.warn,用户零感知。改成累计 errors 后抛聚合错,由
//    LiteratureList.pasteTo 的 catch 统一 toast(literature.pasteFailedToast)。
describe('literature store paste(copy) —— 搬移后的 id 与失败可见(r170)', () => {
  beforeEach(() => setupMockApi());
  afterEach(() => vi.clearAllMocks());

  it('搬进目标目录后 selectedIds 用搬后的 id(不是 import 时的 id)', async () => {
    const api = (globalThis as unknown as { window: { api: MockApi } }).window.api;
    useLiteratureStore.setState({
      items: [makeItem('l1', 'C:/lib/l1.pdf')],
      selectedIds: new Set(['l1']),
    });
    useLiteratureStore.getState().copy();
    // import 落在 literature 根,id = 'lit:'+根下绝对路径
    api.importLiteratureFromFile.mockResolvedValue({
      ok: true,
      data: { id: 'lit:root/l1.pdf', absPath: 'C:/lib/l1.pdf' },
    });
    // 搬进子目录后 absPath 变 → id 变
    api.litMove.mockResolvedValue({
      ok: true,
      data: { id: 'lit:root/foo/l1.pdf', absPath: 'C:/lib/foo/l1.pdf' },
    });
    await useLiteratureStore.getState().paste('foo');
    expect(api.litMove).toHaveBeenCalledWith('lit:root/l1.pdf', 'foo');
    expect([...useLiteratureStore.getState().selectedIds]).toEqual(['lit:root/foo/l1.pdf']);
  });

  it('目标 = 根(null)时不调 litMove(import 本来就落根),选中 import id', async () => {
    const api = (globalThis as unknown as { window: { api: MockApi } }).window.api;
    useLiteratureStore.setState({
      items: [makeItem('l1', 'C:/lib/l1.pdf')],
      selectedIds: new Set(['l1']),
    });
    useLiteratureStore.getState().copy();
    api.importLiteratureFromFile.mockResolvedValue({
      ok: true,
      data: { id: 'lit:root/l1.pdf', absPath: 'C:/lib/l1.pdf' },
    });
    await useLiteratureStore.getState().paste(null);
    expect(api.litMove).not.toHaveBeenCalled();
    expect([...useLiteratureStore.getState().selectedIds]).toEqual(['lit:root/l1.pdf']);
  });

  it('import 失败 → 聚合错抛出,不调 litMove,剪贴板保留可重试', async () => {
    const api = (globalThis as unknown as { window: { api: MockApi } }).window.api;
    useLiteratureStore.setState({
      items: [makeItem('l1', 'C:/lib/l1.pdf')],
      selectedIds: new Set(['l1']),
    });
    useLiteratureStore.getState().copy();
    api.importLiteratureFromFile.mockRejectedValue(new Error('io boom'));
    await expect(useLiteratureStore.getState().paste('foo')).rejects.toThrowError(/failed 1\/1/);
    expect(api.litMove).not.toHaveBeenCalled();
    expect(useLiteratureStore.getState().clipboard).toEqual({ ids: ['l1'], mode: 'copy' });
  });

  it('搬移失败 → 聚合错抛出,副本仍留在选中集(它还在根,id 未变)', async () => {
    const api = (globalThis as unknown as { window: { api: MockApi } }).window.api;
    useLiteratureStore.setState({
      items: [makeItem('l1', 'C:/lib/l1.pdf')],
      selectedIds: new Set(['l1']),
    });
    useLiteratureStore.getState().copy();
    api.importLiteratureFromFile.mockResolvedValue({
      ok: true,
      data: { id: 'lit:root/l1.pdf', absPath: 'C:/lib/l1.pdf' },
    });
    api.litMove.mockResolvedValue({ ok: false, code: 'VALIDATION', message: 'target exists' });
    await expect(useLiteratureStore.getState().paste('foo')).rejects.toThrowError(/failed 1\/1/);
    expect([...useLiteratureStore.getState().selectedIds]).toEqual(['lit:root/l1.pdf']);
  });
});
