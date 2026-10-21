// tests/unit/renderer/hooks/disk-folder-dnd.test.ts
//
// 守卫:useDiskFolderSidebar 的 startItemsDrag + handleTargetDrop 端到端
//   跑通。dragstart 写 RKMS_MOVE_MIME(payload.ids + kind),drop 端读
//   payload、调 moveItems、走 api.notesMove(id, targetRelPath)。这是
//   用户反馈「文件拖入文件夹不工作」的最高风险路径,必须在 jsdom 里
//   完整实跑(r166 之前这些 handler 是 stub 形态,丢 mime / 读 mime 错位
//   是隐性回归点)。
//
// 与 notes-cut-paste.test.ts 互补 —— 后者守 store 路径(store paste
//   自动走 api.notesMove),本测守 drag-into-folder 路径(走 disk hook
//   的 handleTargetDrop),两条 pipeline 都要自洽。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useDiskFolderSidebar,
  ROOT_DROP_ID,
} from '../../../../src/renderer/src/hooks/useDiskFolderSidebar';
import { readMovePayload } from '../../../../src/renderer/src/lib/folder-dnd';
import type { Api } from '../../../../src/shared/api-types';

// Api 类型 90+ 方法,这里直接 `as unknown as Api` 假装接口形状;被测 hook 只
//   用 notesListDirs / litListDirs / notesMove / notesMoveDir。
function makeApi(): Api & { notesMove: ReturnType<typeof vi.fn>; notesListDirs: ReturnType<typeof vi.fn>; litListDirs: ReturnType<typeof vi.fn>; notesMoveDir: ReturnType<typeof vi.fn> } {
  return {
    notesMove: vi.fn(),
    notesMoveDir: vi.fn(),
    notesListDirs: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    litListDirs: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  } as unknown as Api & {
    notesMove: ReturnType<typeof vi.fn>;
    notesListDirs: ReturnType<typeof vi.fn>;
    litListDirs: ReturnType<typeof vi.fn>;
    notesMoveDir: ReturnType<typeof vi.fn>;
  };
}

function makeDataTransfer(): DataTransfer {
  const types: string[] = [];
  const store = new Map<string, string>();
  return {
    types,
    store,
    setData(mime: string, val: string) {
      if (!store.has(mime)) types.push(mime);
      store.set(mime, val);
    },
    getData(mime: string) {
      return store.get(mime) ?? '';
    },
    effectAllowed: 'move' as 'move' | 'copy' | 'none' | 'link',
    dropEffect: 'move' as 'move' | 'copy' | 'none' | 'link',
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    clearData() {
      store.clear();
      types.length = 0;
    },
  } as unknown as DataTransfer;
}

describe('useDiskFolderSidebar drag-into-folder 链路', () => {
  let api: ReturnType<typeof makeApi>;

  beforeEach(() => {
    api = makeApi();
  });

  it('startItemsDrag 写 RKMS_MOVE_MIME 含 ids + kind', () => {
    const { result } = renderHook(() =>
      useDiskFolderSidebar({ kind: 'note', searchActive: false, api }),
    );
    const dt = makeDataTransfer();
    act(() => {
      result.current.startItemsDrag(['n1', 'n2'], {
        dataTransfer: dt,
      } as unknown as Parameters<typeof result.current.startItemsDrag>[1]);
    });
    const raw = dt.getData('application/x-rkms-move');
    const payload = JSON.parse(raw);
    expect(payload.type).toBe('items');
    expect(payload.kind).toBe('note');
    expect(payload.ids).toEqual(['n1', 'n2']);
  });

  it('handleTargetDrop 读 MIME + 调 api.notesMove 用 targetRelPath', async () => {
    const { result } = renderHook(() =>
      useDiskFolderSidebar({ kind: 'note', searchActive: false, api }),
    );
    // drag 段:用 startItemsDrag 写
    const dt = makeDataTransfer();
    act(() => {
      result.current.startItemsDrag(['n1', 'n2'], {
        dataTransfer: dt,
      } as unknown as Parameters<typeof result.current.startItemsDrag>[1]);
    });
    api.notesMove.mockResolvedValue({ ok: true, data: { id: 'n1', relPath: 'target/n1.md' } });

    // drop 段:落地到 'archive' 文件夹
    await act(async () => {
      await result.current.handleTargetDrop({
        dataTransfer: dt,
        preventDefault: () => {},
        stopPropagation: () => {},
      } as unknown as React.DragEvent, 'archive');
    });

    expect(api.notesMove).toHaveBeenCalledTimes(2);
    expect(api.notesMove).toHaveBeenNthCalledWith(1, 'n1', 'archive');
    expect(api.notesMove).toHaveBeenNthCalledWith(2, 'n2', 'archive');
  });

  it('handleTargetDrop 落到 ROOT_DROP_ID 等价 null / 空串(根语义)', async () => {
    const { result } = renderHook(() =>
      useDiskFolderSidebar({ kind: 'note', searchActive: false, api }),
    );
    const dt = makeDataTransfer();
    act(() => {
      result.current.startItemsDrag(['n1'], {
        dataTransfer: dt,
      } as unknown as Parameters<typeof result.current.startItemsDrag>[1]);
    });
    api.notesMove.mockResolvedValue({ ok: true, data: { id: 'n1', relPath: 'n1.md' } });

    await act(async () => {
      await result.current.handleTargetDrop({
        dataTransfer: dt,
        preventDefault: () => {},
        stopPropagation: () => {},
      } as unknown as React.DragEvent, ROOT_DROP_ID);
    });

    // 落根:moveItems 把 null 转 '' 走 IPC,与 store paste(null) 同语义
    expect(api.notesMove).toHaveBeenCalledWith('n1', '');
  });

  it('handleTargetDrop 跨 kind 直接忽略(notes MIME 投到 literature 树上)', async () => {
    const { result } = renderHook(() =>
      useDiskFolderSidebar({ kind: 'literature', searchActive: false, api }),
    );
    const dt = makeDataTransfer();
    act(() => {
      // 手工写一份 note kind 的 payload,模拟「跨 kind 越界」
      dt.setData(
        'application/x-rkms-move',
        JSON.stringify({ type: 'items', kind: 'note', ids: ['n1'], relPaths: [] }),
      );
    });
    await act(async () => {
      await result.current.handleTargetDrop({
        dataTransfer: dt,
        preventDefault: () => {},
        stopPropagation: () => {},
      } as unknown as React.DragEvent, 'archive');
    });
    expect(api.notesMove).not.toHaveBeenCalled();
  });

  it('handleTargetDrop 部分失败累积 → 首个 throw(errors 含 ok=false 项)', async () => {
    const { result } = renderHook(() =>
      useDiskFolderSidebar({ kind: 'note', searchActive: false, api }),
    );
    const dt = makeDataTransfer();
    act(() => {
      result.current.startItemsDrag(['n1', 'n2'], {
        dataTransfer: dt,
      } as unknown as Parameters<typeof result.current.startItemsDrag>[1]);
    });
    api.notesMove.mockImplementation((id: string) => {
      if (id === 'n2') {
        return Promise.resolve({ ok: false, code: 'IO_ERROR', message: 'disk fail' });
      }
      return Promise.resolve({ ok: true, data: { id, relPath: 'archive/' + id + '.md' } });
    });

    let caught: unknown = null;
    await act(async () => {
      try {
        await result.current.handleTargetDrop({
          dataTransfer: dt,
          preventDefault: () => {},
          stopPropagation: () => {},
        } as unknown as React.DragEvent, 'archive');
      } catch (err: unknown) {
        caught = err;
      }
    });

    expect(caught).not.toBeNull();
    expect((caught as Error).message).toMatch(/moveItems failed 1\/2/);
    expect((caught as { errors: Array<{ id: string; code: string }> }).errors).toEqual([
      { id: 'n2', code: 'IO_ERROR', message: 'disk fail' },
    ]);
    // 两条 IPC 都发了(累计),不是首条 throw 后停
    expect(api.notesMove).toHaveBeenCalledTimes(2);
  });

  it('r168:handleTargetDrop 全成功后调 onItemsMoved,带 (oldId → {id, relPath})', async () => {
    const onItemsMoved = vi.fn();
    const { result } = renderHook(() =>
      useDiskFolderSidebar({ kind: 'note', searchActive: false, api, onItemsMoved }),
    );
    const dt = makeDataTransfer();
    act(() => {
      result.current.startItemsDrag(['n1', 'n2'], {
        dataTransfer: dt,
      } as unknown as Parameters<typeof result.current.startItemsDrag>[1]);
    });
    api.notesMove.mockImplementation((id: string) => {
      return Promise.resolve({ ok: true, data: { id: 'new-' + id, relPath: 'archive/' + id + '.md' } });
    });

    await act(async () => {
      await result.current.handleTargetDrop({
        dataTransfer: dt,
        preventDefault: () => {},
        stopPropagation: () => {},
      } as unknown as React.DragEvent, 'archive');
    });

    expect(onItemsMoved).toHaveBeenCalledTimes(1);
    const remap = onItemsMoved.mock.calls[0]![0] as Map<
      string,
      { id: string; relPath?: string }
    >;
    expect(remap.size).toBe(2);
    expect(remap.get('n1')?.id).toBe('new-n1');
    expect(remap.get('n1')?.relPath).toBe('archive/n1.md');
    expect(remap.get('n2')?.id).toBe('new-n2');
  });

  it('r168:handleTargetDrop 部分失败 → 不调 onItemsMoved(避免半截 state)', async () => {
    const onItemsMoved = vi.fn();
    const { result } = renderHook(() =>
      useDiskFolderSidebar({ kind: 'note', searchActive: false, api, onItemsMoved }),
    );
    const dt = makeDataTransfer();
    act(() => {
      result.current.startItemsDrag(['n1', 'n2'], {
        dataTransfer: dt,
      } as unknown as Parameters<typeof result.current.startItemsDrag>[1]);
    });
    api.notesMove.mockImplementation((id: string) => {
      if (id === 'n2') {
        return Promise.resolve({ ok: false, code: 'IO_ERROR', message: 'disk fail' });
      }
      return Promise.resolve({ ok: true, data: { id, relPath: 'archive/' + id + '.md' } });
    });

    await act(async () => {
      try {
        await result.current.handleTargetDrop({
          dataTransfer: dt,
          preventDefault: () => {},
          stopPropagation: () => {},
        } as unknown as React.DragEvent, 'archive');
      } catch {
        // swallow
      }
    });
    expect(onItemsMoved).not.toHaveBeenCalled();
  });

  it('r168:onItemsMoved 不传 = 不抛(兼容既有调用)', async () => {
    const { result } = renderHook(() =>
      useDiskFolderSidebar({ kind: 'note', searchActive: false, api }),
    );
    const dt = makeDataTransfer();
    act(() => {
      result.current.startItemsDrag(['n1'], {
        dataTransfer: dt,
      } as unknown as Parameters<typeof result.current.startItemsDrag>[1]);
    });
    api.notesMove.mockResolvedValue({ ok: true, data: { id: 'new-n1', relPath: 'a/n1.md' } });

    await act(async () => {
      await result.current.handleTargetDrop({
        dataTransfer: dt,
        preventDefault: () => {},
        stopPropagation: () => {},
      } as unknown as React.DragEvent, 'a');
    });
    // 不抛 + IPC 一次
    expect(api.notesMove).toHaveBeenCalledTimes(1);
  });

  it('r168:moveItems 直接调用也返回 idRemap(caller 拿到后可手动回调 store)', async () => {
    const { result } = renderHook(() =>
      useDiskFolderSidebar({ kind: 'note', searchActive: false, api }),
    );
    api.notesMove.mockResolvedValue({ ok: true, data: { id: 'new-n1', relPath: 'a/n1.md' } });
    let remap: Map<string, { id: string; relPath?: string }> = new Map();
    await act(async () => {
      remap = await result.current.moveItems('a', ['n1']);
    });
    expect(remap.size).toBe(1);
    expect(remap.get('n1')?.id).toBe('new-n1');
    expect(remap.get('n1')?.relPath).toBe('a/n1.md');
  });

  // === r173:文件夹(子树)搬移 —— 拖 / 切 / 粘三条入口 ===
  //
  // 旧实现的两个死点:
  //   1) startFolderDrag 写 ids: [] → readMovePayload 拒收(ids 必须非空
  //      且每项非空串)→ 载荷在读端被丢掉,drop 端永远收不到;
  //   2) pasteFolderInto / moveFolderNow 是 throw「not yet supported」的占位。
  it('r173:startFolderDrag 写的载荷能被 readMovePayload 接受(ids 非空且 = relPath)', () => {
    const { result } = renderHook(() =>
      useDiskFolderSidebar({ kind: 'note', searchActive: false, api }),
    );
    const dt = makeDataTransfer();
    act(() => {
      result.current.startFolderDrag(
        { relPath: 'sub', name: 'sub', parentRelPath: null },
        { dataTransfer: dt } as unknown as Parameters<typeof result.current.startFolderDrag>[1],
      );
    });
    const payload = readMovePayload(dt);
    expect(payload).not.toBeNull();
    expect(payload!.type).toBe('folder');
    expect(payload!.relPaths).toEqual(['sub']);
    expect(payload!.ids).toEqual(['sub']);
  });

  it('r173:文件夹拖到目标目录 → 调 api.notesMoveDir(oldRelPath, targetRelPath)', async () => {
    const { result } = renderHook(() =>
      useDiskFolderSidebar({ kind: 'note', searchActive: false, api }),
    );
    const dt = makeDataTransfer();
    act(() => {
      result.current.startFolderDrag(
        { relPath: 'sub', name: 'sub', parentRelPath: null },
        { dataTransfer: dt } as unknown as Parameters<typeof result.current.startFolderDrag>[1],
      );
    });
    api.notesMoveDir.mockResolvedValue({
      ok: true,
      data: { relPath: 'archive/sub', idRemap: [] },
    });

    await act(async () => {
      await result.current.handleTargetDrop({
        dataTransfer: dt,
        preventDefault: () => {},
        stopPropagation: () => {},
      } as unknown as React.DragEvent, 'archive');
    });

    expect(api.notesMoveDir).toHaveBeenCalledTimes(1);
    expect(api.notesMoveDir).toHaveBeenCalledWith('sub', 'archive');
  });

  it('r173:文件夹拖到根(ROOT_DROP_ID)→ 目标父目录 = null', async () => {
    const { result } = renderHook(() =>
      useDiskFolderSidebar({ kind: 'note', searchActive: false, api }),
    );
    const dt = makeDataTransfer();
    act(() => {
      result.current.startFolderDrag(
        { relPath: 'sub', name: 'sub', parentRelPath: null },
        { dataTransfer: dt } as unknown as Parameters<typeof result.current.startFolderDrag>[1],
      );
    });
    api.notesMoveDir.mockResolvedValue({
      ok: true,
      data: { relPath: 'sub', idRemap: [] },
    });

    await act(async () => {
      await result.current.handleTargetDrop({
        dataTransfer: dt,
        preventDefault: () => {},
        stopPropagation: () => {},
      } as unknown as React.DragEvent, ROOT_DROP_ID);
    });

    expect(api.notesMoveDir).toHaveBeenCalledWith('sub', null);
  });

  it('r173:文件夹搬移成功 → onItemsMoved 收到 idRemap(选中态跟到新 id)', async () => {
    const onItemsMoved = vi.fn();
    const { result } = renderHook(() =>
      useDiskFolderSidebar({ kind: 'note', searchActive: false, api, onItemsMoved }),
    );
    const dt = makeDataTransfer();
    act(() => {
      result.current.startFolderDrag(
        { relPath: 'sub', name: 'sub', parentRelPath: null },
        { dataTransfer: dt } as unknown as Parameters<typeof result.current.startFolderDrag>[1],
      );
    });
    api.notesMoveDir.mockResolvedValue({
      ok: true,
      data: {
        relPath: 'archive/sub',
        idRemap: [{ oldId: 'n1', newId: 'n2', relPath: 'archive/sub/n1.md' }],
      },
    });

    await act(async () => {
      await result.current.handleTargetDrop({
        dataTransfer: dt,
        preventDefault: () => {},
        stopPropagation: () => {},
      } as unknown as React.DragEvent, 'archive');
    });

    expect(onItemsMoved).toHaveBeenCalledTimes(1);
    const remap = onItemsMoved.mock.calls[0]![0] as Map<string, { id: string; relPath?: string }>;
    expect(remap.get('n1')?.id).toBe('n2');
    expect(remap.get('n1')?.relPath).toBe('archive/sub/n1.md');
  });

  it('r173:剪切文件夹 → 粘贴到目标目录 → 走 moveDir 且剪贴板清空', async () => {
    const { result } = renderHook(() =>
      useDiskFolderSidebar({ kind: 'note', searchActive: false, api }),
    );
    act(() => {
      result.current.cutFolder('sub');
    });
    expect(result.current.folderClipboard).toBe('sub');

    api.notesMoveDir.mockResolvedValue({
      ok: true,
      data: { relPath: 'archive/sub', idRemap: [] },
    });
    await act(async () => {
      await result.current.pasteFolderInto('archive');
    });

    expect(api.notesMoveDir).toHaveBeenCalledWith('sub', 'archive');
    // 粘贴成功 → 剪贴板清空(再切一次是重新剪切)
    expect(result.current.folderClipboard).toBeNull();
  });

  it('r173:粘贴失败 → 抛错且剪贴板保留(可重试)', async () => {
    const { result } = renderHook(() =>
      useDiskFolderSidebar({ kind: 'note', searchActive: false, api }),
    );
    act(() => {
      result.current.cutFolder('sub');
    });
    api.notesMoveDir.mockResolvedValue({
      ok: false,
      code: 'IO_ERROR',
      message: 'disk fail',
    });

    let caught: unknown = null;
    await act(async () => {
      try {
        await result.current.pasteFolderInto('archive');
      } catch (err: unknown) {
        caught = err;
      }
    });
    expect(caught).not.toBeNull();
    expect((caught as Error).message).toMatch(/disk fail/);
    expect(result.current.folderClipboard).toBe('sub');
  });

  it('r173:moveFolderNow 显式搬移(「移到根目录」入口)→ 目标父目录 null', async () => {
    const { result } = renderHook(() =>
      useDiskFolderSidebar({ kind: 'note', searchActive: false, api }),
    );
    api.notesMoveDir.mockResolvedValue({
      ok: true,
      data: { relPath: 'sub', idRemap: [] },
    });
    let newRel = '';
    await act(async () => {
      newRel = await result.current.moveFolderNow('sub', null);
    });
    expect(api.notesMoveDir).toHaveBeenCalledWith('sub', null);
    expect(newRel).toBe('sub');
  });
});
