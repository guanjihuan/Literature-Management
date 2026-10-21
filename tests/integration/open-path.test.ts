// tests/integration/open-path.test.ts
// 守「系统打开路径(shell:open-path)」这条 IPC 的端到端白名单契约(r229 补齐 🔒 守卫缺失)。
//
// ── 被守卫的契约(退化后的用户可见后果)─────────────────────────────
//   这条通道是渲染层「在文件管理器里打开工作区目录 / 笔记所在目录」的唯一入口,
//   走 src/main/ipc/shell.ts:白名单校验 → 存在性校验 → shell.openPath。
//   退化后的用户可见后果:
//
//   C1 白名单失守(去掉 assertInsideAllowedRoot / 把白名单换成前缀比较)
//      ⇒ 渲染层可让系统文件管理器打开工作区**外**的任何目录
//      (用户电脑上的隐私目录被一键暴露),且 rkms:// iframe 侧同源同漏洞。
//   C2 相对路径的解析基准漂移(改成按 cwd 解析)
//      ⇒ 应用从不同目录启动时,「打开目录」要么报「路径不允许」,要么
//      打开了错误的位置(用户点「打开笔记所在目录」看到的是陌生目录)。
//   C3 平台语义漂移(按 process.platform 在 posix/win32 之间切 path 实现)
//      ⇒ 在 Windows 上把 process.platform 伪装成 posix 时,合法路径被误判成
//      越界 ⇒ 用户看到「路径不允许」,而磁盘上什么都没变。
//      这条正是 src/main/ipc/paths.ts 头注里点名要守的行为:
//      「不要改成按 process.platform 切 —— 测试里会覆写 process.platform
//      来模拟跨平台(见 tests/integration/open-path.test.ts 的 ORIGINAL_PLATFORM)」。
//
// ── 变异思路(哪几处改动会红)─────────────────────────────────────
//   M1 shell.ts 去掉 assertInsideAllowedRoot          → I2 / I4 / I6 红。
//   M2 shell.ts 的相对路径改成按 cwd 解析              → I5 红。
//   M3 paths.ts 按 process.platform 切 path 实现        → I7 / I8 红
//      (在 Windows 宿主上把 platform 伪装成 linux/darwin ⇒ 合法路径被判越界)。
//   M4 shell.ts 去掉存在性校验                          → I3 红。
//   M5 shell.ts 忽略 shell.openPath 的返回错误串         → I9 红。
//   M6 shell.ts 去掉 requireString 的长度上限            → I10 红。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  return {
    handlers,
    ipcMain: {
      handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
        handlers.set(channel, fn);
      },
    },
    shell: {
      // 默认成功(空串 = 无错误)
      openPath: vi.fn(async (_path: string) => ''),
      trashItem: vi.fn(async () => undefined),
    },
  };
});

vi.mock('electron', () => ({
  ipcMain: electronMock.ipcMain,
  shell: electronMock.shell,
}));

import { setRootPath } from '../../src/main/utils/safe-write';
import { registerShellIPC } from '../../src/main/ipc/shell';
import { MAX_IPC_PATH_CHARS } from '../../src/main/ipc/path-limits';
import { IPC } from '../../src/shared/types';

interface IpcOk<T> {
  ok: boolean;
  data?: T;
  code?: string;
  message?: string;
}

/** 宿主平台 —— 平台伪装用例跑完必须还原回它 */
const ORIGINAL_PLATFORM = process.platform;
const ORIGINAL_PLATFORM_DESCRIPTOR = Object.getOwnPropertyDescriptor(process, 'platform');

function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', {
    value,
    writable: false,
    enumerable: true,
    configurable: true,
  });
}

let root: string;
let outside: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'rkms-openpath-root-')));
  outside = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'rkms-openpath-out-')));
  setRootPath(root);
  electronMock.handlers.clear();
  electronMock.shell.openPath.mockReset();
  electronMock.shell.openPath.mockResolvedValue('');
  registerShellIPC();
});

afterEach(async () => {
  // 平台伪装必须还原(否则后续用例拿到的是被改过的 platform)
  if (ORIGINAL_PLATFORM_DESCRIPTOR) {
    Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM_DESCRIPTOR);
  } else {
    setPlatform(ORIGINAL_PLATFORM);
  }
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

function handler(): (event: unknown, ...args: unknown[]) => unknown {
  const h = electronMock.handlers.get(IPC.SHELL_OPEN_PATH);
  expect(h, `IPC.${IPC.SHELL_OPEN_PATH} 没有注册 handler`).toBeTruthy();
  return h as (event: unknown, ...args: unknown[]) => unknown;
}

async function call(path: unknown): Promise<IpcOk<{ opened: string }>> {
  return (await handler()({}, path)) as IpcOk<{ opened: string }>;
}

describe('shell:open-path 的工作区白名单(集成)', () => {
  it('I1 工作区内、已存在的目录 → 放行并交给系统打开', async () => {
    const dir = join(root, 'notes');
    await fs.mkdir(dir, { recursive: true });

    const res = await call(dir);

    expect(res.ok).toBe(true);
    expect(res.data?.opened).toBe(dir);
    expect(electronMock.shell.openPath).toHaveBeenCalledTimes(1);
    expect(electronMock.shell.openPath).toHaveBeenCalledWith(dir);
  });

  it('I2 工作区外的目录 → EPERM,且**不**调 shell.openPath', async () => {
    const res = await call(outside);

    expect(res.ok).toBe(false);
    expect(res.code).toBe('EPERM');
    expect(electronMock.shell.openPath).not.toHaveBeenCalled();
  });

  it('I3 工作区内但不存在 → ENOENT(不是 EPERM),且不调 shell.openPath', async () => {
    const missing = join(root, 'notes', 'not-here');
    const res = await call(missing);

    expect(res.ok).toBe(false);
    expect(res.code).toBe('ENOENT');
    expect(electronMock.shell.openPath).not.toHaveBeenCalled();
  });

  it('I4 工作区内的 symlink → EPERM(路径在白名单内≠文件在白名单内)', async () => {
    const target = join(root, 'real-target');
    await fs.mkdir(target, { recursive: true });
    const link = join(root, 'link');
    // junction:Windows 上不需要管理员权限
    await fs.symlink(target, link, 'junction');

    const res = await call(link);

    expect(res.ok).toBe(false);
    expect(res.code).toBe('EPERM');
    expect(electronMock.shell.openPath).not.toHaveBeenCalled();
  });

  it('I5 相对路径以 rootPath 为基准解析(不是 cwd)', async () => {
    const dir = join(root, 'notes');
    await fs.mkdir(dir, { recursive: true });

    // cwd 是仓库根目录;若实现按 cwd 解析,这个相对路径会落到工作区外 ⇒ EPERM
    const res = await call('notes');

    expect(res.ok).toBe(true);
    expect(res.data?.opened).toBe(join(resolve(root), 'notes'));
  });

  it('I6 相对路径逃逸("..")→ EPERM', async () => {
    const res = await call('../escape');
    expect(res.ok).toBe(false);
    expect(res.code).toBe('EPERM');
    expect(electronMock.shell.openPath).not.toHaveBeenCalled();
  });

  it('I7 平台被伪装成 linux 时:区内路径仍放行、区外路径仍拒绝', async () => {
    const dir = join(root, 'notes');
    await fs.mkdir(dir, { recursive: true });

    setPlatform('linux');
    try {
      const inside = await call(dir);
      expect(inside.ok, '合法路径不该因为 process.platform 被伪装就判成越界').toBe(true);
      expect(inside.data?.opened).toBe(dir);

      const outsideRes = await call(outside);
      expect(outsideRes.ok).toBe(false);
      expect(outsideRes.code).toBe('EPERM');
    } finally {
      setPlatform(ORIGINAL_PLATFORM);
    }
  });

  it('I8 平台被伪装成 darwin 时:判定与宿主平台完全一致', async () => {
    const dir = join(root, 'notes');
    await fs.mkdir(dir, { recursive: true });

    setPlatform('darwin');
    try {
      const inside = await call(dir);
      expect(inside.ok).toBe(true);
      expect(inside.data?.opened).toBe(dir);

      const outsideRes = await call(outside);
      expect(outsideRes.ok).toBe(false);
      expect(outsideRes.code).toBe('EPERM');
    } finally {
      setPlatform(ORIGINAL_PLATFORM);
    }
  });

  it('I9 shell.openPath 返回错误串 → EOPEN', async () => {
    const dir = join(root, 'notes');
    await fs.mkdir(dir, { recursive: true });
    electronMock.shell.openPath.mockResolvedValue('Failed to open path');

    const res = await call(dir);

    expect(res.ok).toBe(false);
    expect(res.code).toBe('EOPEN');
  });

  it('I10 非字符串参数 → VALIDATION(不进入白名单逻辑)', async () => {
    const res = await call(123);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('VALIDATION');
    expect(electronMock.shell.openPath).not.toHaveBeenCalled();
  });

  it('I11 超过长度上限的路径 → VALIDATION(防止 renderer 注入超大字符串)', async () => {
    const huge = join(root, 'x'.repeat(MAX_IPC_PATH_CHARS + 1));
    const res = await call(huge);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('VALIDATION');
    expect(electronMock.shell.openPath).not.toHaveBeenCalled();
  });
});

/**
 * I12 / I13(audit-r229):错误消息**不回显绝对路径**。
 *
 * 背景:ipc/wrap.ts 的 mapErrorToEnvelope 只对 **INTERNAL** 分支做
 *   scrubInternal(路径 → <rootPath> 占位符),其余 code 原样透传 ⇒ 消息里
 *   带绝对路径就等于把家目录 / OneDrive 目录名送进 renderer 与 telemetry。
 * 同域的 ipc/library.ts 早就按这个口径处理(重抛 'file is outside the
 * workspace'),只有本文件漏了。
 *
 * 退化形态(消息里塞回 `${abs}` / `${errMsg(err)}`)⇒ 这两条红。
 * 完整错误只留在 main 侧日志。
 */
describe('shell:open-path 的错误消息不回显绝对路径', () => {
  it('I12 越界(EPERM)消息里不含工作区路径', async () => {
    const res = await call(outside);

    expect(res.ok).toBe(false);
    expect(res.code).toBe('EPERM');
    expect(res.message ?? '').not.toContain(outside);
    expect(res.message ?? '').not.toContain(root);
  });

  it('I13 不存在(ENOENT)消息里不含工作区路径', async () => {
    const missing = join(root, 'notes', 'not-here');
    const res = await call(missing);

    expect(res.ok).toBe(false);
    expect(res.code).toBe('ENOENT');
    expect(res.message ?? '').not.toContain(missing);
    expect(res.message ?? '').not.toContain(root);
  });
});
