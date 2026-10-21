// tests/unit/renderer/hooks/disk-folder-reload-guard.test.ts
//
// 守卫(r175 → r176 树形态):useDiskFolderSidebar 的两处时序/状态防御
//
// 1. 懒加载的**按目录序号守卫** —— 此前裸 await 后无条件 setSubdirs:
//    快速连点文件夹 A → B(间隔小于一次 IPC roundtrip)时,A 的响应若后到,
//    会把 A 的子项写进 state —— 面包屑显示 B,列表里却是 A 的子目录。
//    守卫:每次请求领 seq,响应回来时 seq 不是最新就丢弃。
//
//    r176 树形态下守卫改成**按目录**计数:同一个目录并发两次拉取
//    (展开 → 立刻再展开)时,先发的响应后到会覆盖新快照。不同目录
//    各算各的 —— 「A 目录的响应」不会污染「B 目录的缓存」。
//
// 2. 搜索态下 startCreate / startCreateSubfolder **必须 no-op** ——
//    搜索态的 inline input 行被 rows 组装侧 gate 掉(!searchActive 才
//    挂 input 行),旧实现「进搜索态点 ✚ 按钮」会置 editing='create'
//    但没有 input 行渲染:用户看到什么都不发生,且 editing 卡住,清空
//    搜索后 input 行突然冒出来。键盘入口早已 gate,这里把守卫收到
//    hook 内部,让工具栏 / 右键 / 快捷键三条入口行为一致。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
  useDiskFolderSidebar,
  resetFolderTreeRegistry,
} from '../../../../src/renderer/src/hooks/useDiskFolderSidebar';
import type { Api } from '../../../../src/shared/api-types';

function makeApi(): Api {
  return {
    notesListDirs: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    litListDirs: vi.fn().mockResolvedValue({ ok: true, data: [] }),
  } as unknown as Api;
}

function dir(relPath: string) {
  return { relPath, name: relPath.split('/').pop() ?? relPath, parentRelPath: null };
}

describe('useDiskFolderSidebar 懒加载序号守卫 + 搜索态 gate', () => {
  let api: ReturnType<typeof makeApi>;

  beforeEach(() => {
    api = makeApi();
    // registry 是模块级(跨 tab 切换要保住展开态)—— 每个用例重来一份。
    resetFolderTreeRegistry('note');
  });

  it('同一目录并发两次拉取:慢的旧响应后到时不能覆盖新快照', async () => {
    // 第一次拉 A(慢),第二次拉 A(快)—— 模拟「展开 → 立刻再展开」
    let resolveSlow: (v: unknown) => void = () => {};
    const slow = new Promise((res) => {
      resolveSlow = res;
    });
    let call = 0;
    (api.notesListDirs as ReturnType<typeof vi.fn>).mockImplementation(
      (kind: string, rel: string | null) => {
        if (rel !== 'A') return Promise.resolve({ ok: true, data: [] });
        call += 1;
        if (call === 1) return slow;
        return Promise.resolve({ ok: true, data: [dir('A/fresh')] });
      },
    );

    const { result } = renderHook(() =>
      useDiskFolderSidebar({ kind: 'note', searchActive: false, api }),
    );

    // 先展开 A(慢),再立刻展开 A(快)
    await act(async () => {
      result.current.expandFolder('A');
    });
    await act(async () => {
      result.current.expandFolder('A');
    });
    await waitFor(() => {
      expect(result.current.childrenByDir.get('A')?.map((d) => d.relPath)).toEqual(['A/fresh']);
    });

    // 旧响应此刻才到 —— 应当被序号守卫丢弃
    await act(async () => {
      resolveSlow({ ok: true, data: [dir('A/stale')] });
      await slow;
    });

    expect(result.current.childrenByDir.get('A')?.map((d) => d.relPath)).toEqual(['A/fresh']);
  });

  it('不同目录各算各的 —— B 目录的响应不会被 A 目录的请求挤掉', async () => {
    let resolveA: (v: unknown) => void = () => {};
    const aPromise = new Promise((res) => {
      resolveA = res;
    });
    (api.notesListDirs as ReturnType<typeof vi.fn>).mockImplementation(
      (kind: string, rel: string | null) => {
        if (rel === 'A') return aPromise;
        if (rel === 'B') return Promise.resolve({ ok: true, data: [dir('B/child')] });
        return Promise.resolve({ ok: true, data: [] });
      },
    );

    const { result } = renderHook(() =>
      useDiskFolderSidebar({ kind: 'note', searchActive: false, api }),
    );

    await act(async () => {
      result.current.expandFolder('A');
    });
    await act(async () => {
      result.current.expandFolder('B');
    });
    await waitFor(() => {
      expect(result.current.childrenByDir.get('B')?.map((d) => d.relPath)).toEqual(['B/child']);
    });

    await act(async () => {
      resolveA({ ok: true, data: [dir('A/stale')] });
      await aPromise;
    });

    // A 的缓存拿到自己的数据,B 不受影响
    expect(result.current.childrenByDir.get('A')?.map((d) => d.relPath)).toEqual(['A/stale']);
    expect(result.current.childrenByDir.get('B')?.map((d) => d.relPath)).toEqual(['B/child']);
  });

  it('搜索态 startCreate 是 no-op(不置 editing 态)', () => {
    const { result } = renderHook(() =>
      useDiskFolderSidebar({ kind: 'note', searchActive: true, api }),
    );
    act(() => {
      result.current.startCreate();
    });
    expect(result.current.editing).toBeNull();
  });

  it('非搜索态 startCreate 正常进入编辑态', () => {
    const { result } = renderHook(() =>
      useDiskFolderSidebar({ kind: 'note', searchActive: false, api }),
    );
    act(() => {
      result.current.startCreate();
    });
    expect(result.current.editing).toEqual({ mode: 'create', parentRelPath: null, name: '' });
  });

  // === r176:落点语义 ===
  it('activateFolder = 设为落点 + 展开(一次手势两件事)', async () => {
    const { result } = renderHook(() =>
      useDiskFolderSidebar({ kind: 'note', searchActive: false, api }),
    );
    act(() => {
      result.current.activateFolder('A');
    });
    expect(result.current.targetRelPath).toBe('A');
    expect(result.current.expanded.has('A')).toBe(true);

    // 再点一次 = 折叠(落点保持)
    act(() => {
      result.current.activateFolder('A');
    });
    expect(result.current.targetRelPath).toBe('A');
    expect(result.current.expanded.has('A')).toBe(false);
  });

});
