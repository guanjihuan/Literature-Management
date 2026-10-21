// tests/unit/main/ipc/library-reader-not-initialized.test.ts
//
// 守 audit-r244「工作区未初始化 ≠ 路径越界」契约。
//
// 问题:ipc/library.ts 的 handler 把 assertInsideAllowedRoot 抛出的
// **所有**错误一律翻成 `AppError('EPERM', 'file is outside the workspace')`。
// 但 assertInsideAllowedRoot 会因为两种完全不同的原因抛错:
//   ① 路径真的在工作区外 / 是 symlink ⇒ EPERM(该拒);
//   ② 工作区还没初始化(getRootPath() 未 setRootPath)⇒ INTERNAL
//      「Root path not initialized. Call setRootPath() first.」
// 旧实现把 ② 也报成 ① ⇒ renderer 显示「文件在工作区外」,而真实原因是
// 启动期工作区还没就绪 —— 排查方向完全跑偏(而且这个提示对用户是**假的**:
// 文件其实可能就在工作区里)。
//
// 本测锁:工作区未初始化时,reader 通道回的是 INTERNAL(不是 EPERM)。
//
// 注意:本测要拿到「未初始化」的模块态,所以用 vi.resetModules() +
// 动态 import 拿一份**全新的** safe-write 模块(它的 currentDataPath 初值
// 为 null);同文件里不调 setRootPath。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  return {
    handlers,
    ipcMain: {
      handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
        handlers.set(channel, fn);
      },
    },
  };
});

vi.mock('electron', () => ({
  ipcMain: electronMock.ipcMain,
  shell: { trashItem: vi.fn() },
}));

import { IPC } from '../../../../src/shared/types';

interface IpcRes {
  ok: boolean;
  code?: string;
  message?: string;
}

describe('audit-r244:reader 通道在「工作区未初始化」时报 INTERNAL', () => {
  beforeEach(() => {
    vi.resetModules();
    electronMock.handlers.clear();
  });

  it('未 setRootPath 时 → code=INTERNAL(不是 EPERM)', async () => {
    const { registerLibraryIPC } = await import('../../../../src/main/ipc/library');
    registerLibraryIPC();
    const h = electronMock.handlers.get(IPC.LIBRARY_READER_FOR_FILE);
    expect(h).toBeTruthy();

    const res = (await h!({}, 'C:/whatever/inside-workspace.txt')) as IpcRes;
    expect(res.ok).toBe(false);
    expect(res.code).toBe('INTERNAL');
    expect(res.code).not.toBe('EPERM');
  });
});
