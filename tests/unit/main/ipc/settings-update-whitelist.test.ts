// tests/unit/main/ipc/settings-update-whitelist.test.ts
//
// 守 audit-r244「SETTINGS_UPDATE 只能改 UI 偏好字段」契约。
//
// 漏洞(本轮实证):`src/main/ipc/settings.ts` 的 handler 把 renderer 传来的
// patch 直接交给 `sanitizeSettingsPatch` —— 而它只是 `sanitizeAppSettings`
// (settings/validate.ts,同一个**加载侧**净化器)的别名,接受任何
// 「绝对 + ≤4096 字符」的 rootPath / dataPath。
//
//   而主进程 `settings/store.ts` 的 updateSettings 是
//   `const next = { ...base, ...patch }; await saveSettings(next);`
//   ⇒ 被劫持 / XSS 的 renderer 调
//     api.updateSettings({ rootPath: 'C:\\Windows' })
//   就能把伪造的 rootPath **落盘到 settings.json**。
//
// 后果(不是数据丢失 —— 没有文件 IO 跟着伪造值走,但 UI 全错):
//   - 设置页渲染错的根;renderer 侧 deriveNotesPath(settings.rootPath)
//     指向工作区**之外**的目录;
//   - 「打开数据目录」走 SHELL_OPEN_PATH → assertInsideAllowedRoot 对
//     **真实**根校验 → EPERM ⇒ 按钮变死;
//   - 脏值要等到下次启动 reconcileRootPath 才自愈。
//
// 本测锁:
//   1. rootPath / dataPath 被剥掉(**不落盘**);
//   2. theme / language / workspaceLayout 等 UI 偏好字段照常更新;
//   3. 未知字段(未来新增的、还没进白名单的)也被剥掉(默认拒绝,而不是
//      默认放行)—— 白名单语义。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() },
}));

const storeMock = vi.hoisted(() => ({
  getSettings: vi.fn(() => ({})),
  updateSettings: vi.fn(async (patch: unknown) => patch),
}));

vi.mock('../../../../src/main/settings/store', () => storeMock);
vi.mock('../../../../src/main/settings/migration', () => ({
  switchDataPath: vi.fn(),
  restoreDefaultDataPath: vi.fn(),
}));

import { registerSettingsIPC } from '../../../../src/main/ipc/settings';
import { IPC } from '../../../../src/shared/types';

describe('audit-r244:SETTINGS_UPDATE 只允许 UI 偏好字段', () => {
  beforeEach(() => {
    electronMock.handlers.clear();
    storeMock.updateSettings.mockClear();
    registerSettingsIPC();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function handler(): (event: unknown, ...args: unknown[]) => unknown {
    const h = electronMock.handlers.get(IPC.SETTINGS_UPDATE);
    expect(h).toBeTruthy();
    return h!;
  }

  it('rootPath / dataPath 被剥掉,不进 updateSettings', async () => {
    await handler()({}, {
      rootPath: 'C:\\Windows',
      dataPath: 'C:\\Windows',
      theme: 'dark',
    });

    expect(storeMock.updateSettings).toHaveBeenCalledTimes(1);
    const patch = storeMock.updateSettings.mock.calls[0]![0] as Record<string, unknown>;
    expect(patch.rootPath).toBeUndefined();
    expect(patch.dataPath).toBeUndefined();
    expect(patch.theme).toBe('dark');
  });

  it('非法 theme 的 patch 被净化层剥掉后仍是空 patch(不写盘)', async () => {
    await handler()({}, { theme: 'not-a-theme', rootPath: 'C:\\Windows' });

    const patch = storeMock.updateSettings.mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(patch)).toEqual([]);
  });

  it('UI 偏好字段照常更新(theme / language / workspaceLayout)', async () => {
    await handler()({}, {
      theme: 'system',
      language: 'en-US',
      workspaceLayout: { fontFamily: 'serif' },
    });

    const patch = storeMock.updateSettings.mock.calls[0]![0] as Record<string, unknown>;
    expect(patch.theme).toBe('system');
    expect(patch.language).toBe('en-US');
    expect(patch.workspaceLayout).toEqual({ fontFamily: 'serif' });
  });

  it('未知字段被剥掉(白名单语义 = 默认拒绝)', async () => {
    await handler()({}, { enabledExtensions: { evil: true } });

    const patch = storeMock.updateSettings.mock.calls[0]![0] as Record<string, unknown>;
    expect(patch.enabledExtensions).toBeUndefined();
  });
});
