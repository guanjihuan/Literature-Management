// tests/unit/main/ipc/paths-no-path-leak.test.ts
//
// 守 audit-r244「白名单拒绝消息不回显绝对路径」契约。
//
// 问题:ipc/wrap.ts 只对 **INTERNAL** 走 scrubInternal(把 rootPath **之内**
// 的路径替成占位符);已知 code(EPERM 等)是**原样透传**的。而
// `assertInsideAllowedRoot` 的 EPERM 消息里带着 `abs` —— 恰恰是
// rootPath **之外**的路径(scrubInternal 恰恰脱敏不到它)⇒ 家目录 /
// OneDrive 目录名随 IPC 错误回包进 renderer 与 telemetry。
//
//   口径已由 ipc/shell.ts(r229)、ipc/library.ts(r191)确立:消息不含路径,
//   完整路径只留 main 侧日志。paths.ts 是**源头**,之前靠三个调用点各自
//   改写文案才没漏 —— 属「运气」而非「设计」,新调用点一接就漏。
//
// 本测锁:白名单拒绝抛出的 AppError.message 里既没有越界路径,也没有
//        工作区根路径。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { setRootPath } from '../../../../src/main/utils/safe-write';
import { assertInsideAllowedRoot } from '../../../../src/main/ipc/paths';
import { AppError } from '../../../../src/main/utils/error';

describe('audit-r244:白名单拒绝消息不含绝对路径', () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'rkms-pathleak-root-'));
    outside = await fs.mkdtemp(join(tmpdir(), 'rkms-pathleak-out-'));
    setRootPath(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('工作区外的绝对路径 → EPERM,消息里既无越界路径也无根路径', () => {
    const secret = join(outside, 'id_rsa');
    let err: unknown;
    try {
      assertInsideAllowedRoot(secret);
    } catch (e: unknown) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppError);
    const appErr = err as AppError;
    expect(appErr.code).toBe('EPERM');
    expect(appErr.message).not.toContain(secret);
    expect(appErr.message).not.toContain(outside);
    expect(appErr.message).not.toContain(root);
  });

  it('工作区外的相对路径(基于 root 解析后越界)→ 同样不含路径', () => {
    let err: unknown;
    try {
      assertInsideAllowedRoot('../escape-outside');
    } catch (e: unknown) {
      err = e;
    }
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('EPERM');
    expect((err as AppError).message).not.toContain(root);
  });
});
