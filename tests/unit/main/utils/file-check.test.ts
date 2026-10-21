// tests/unit/main/utils/file-check.test.ts
//
// 守 assertFileExists 的**错误分类**契约(2026-10-20,r201):
//
//   fs.open('r') 失败时的错误码必须区分:
//     ENOENT / 无 code  → FILE_MISSING("文件不存在")
//     其它( EACCES / EPERM / EISDIR / EBUSY …)→ IO_ERROR
//
// 为什么这条分类是行为面(不是风格):调用方(notes 的"在文件夹中显示"、文献
// 的 open 路径)据此决定 UI 文案与是否可重试。旧实现一律 FILE_MISSING,
// 权限问题被错报成"文件不存在",用户不停 retry,真实根因被埋没 —— r33 修过
// 一次(r33 只分了 ENOENT / 其它两支),r96 又把"拿不到 code"这一支从
// IO_ERROR 改回 FILE_MISSING(保守:不认识 → 当成不存在)。
//
// 本文件锁住 r96 之后的三支语义 —— 源码注释里明确写着"摘 !code 分支必红":
//   1. ENOENT → FILE_MISSING
//   2. 错误对象**没有** code → FILE_MISSING(保守兜底)
//   3. EACCES 等其它 code → IO_ERROR
//   4. 空路径 → FILE_MISSING
//   5. 打开成功 → 句柄一定被 close(不泄漏 fd)
import { promises as fsPromises } from 'fs';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { assertFileExists } from '../../../../src/main/utils/file-check';
import { createLogger } from '../../../../src/main/utils/logger';

const log = createLogger('file-check-test');

/** 造一个带 errno code 的错误(模拟 EACCES / EPERM / EISDIR / EBUSY) */
function fsError(code: string, msg: string): NodeJS.ErrnoException {
  const e = new Error(msg) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

/** 取 LibraryError 的 code */
function codeOf(e: unknown): string | undefined {
  return (e as { code?: string }).code;
}

describe('assertFileExists — 错误分类(r201)', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'rkms-filecheck-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('空路径 → FILE_MISSING(不发起 syscall)', async () => {
    const spy = vi.spyOn(fsPromises, 'open');
    const err = await assertFileExists('', '文件不存在', log).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(codeOf(err)).toBe('FILE_MISSING');
    expect(spy).not.toHaveBeenCalled();
  });

  it('文件存在 → 正常 resolve', async () => {
    const p = join(tmpRoot, 'there.md');
    await writeFile(p, '# hi', 'utf-8');
    await expect(assertFileExists(p, '文件不存在', log)).resolves.toBeUndefined();
  });

  it('文件不存在(ENOENT)→ FILE_MISSING,且消息带上 errno 文本便于排查', async () => {
    const p = join(tmpRoot, 'missing.md');
    const err = await assertFileExists(p, '文件不存在', log).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(codeOf(err)).toBe('FILE_MISSING');
    expect((err as Error).message).toContain('文件不存在');
    expect((err as Error).message).toMatch(/ENOENT|no such file/i);
  });

  it('无 code 的错误 → FILE_MISSING(r96 保守兜底:不认识就当不存在)', async () => {
    const spy = vi
      .spyOn(fsPromises, 'open')
      .mockImplementationOnce(() => Promise.reject(new Error('weird failure')) as never);
    const err = await assertFileExists(join(tmpRoot, 'x.md'), '文件不存在', log).then(
      () => null,
      (e: unknown) => e,
    );
    expect(codeOf(err)).toBe('FILE_MISSING');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('EACCES → IO_ERROR(不是 FILE_MISSING)', async () => {
    vi.spyOn(fsPromises, 'open').mockImplementationOnce(
      () => Promise.reject(fsError('EACCES', 'permission denied')) as never,
    );
    const err = await assertFileExists(join(tmpRoot, 'x.md'), '文件不存在', log).then(
      () => null,
      (e: unknown) => e,
    );
    expect(codeOf(err)).toBe('IO_ERROR');
  });

  it('EISDIR(路径其实是目录)→ IO_ERROR', async () => {
    vi.spyOn(fsPromises, 'open').mockImplementationOnce(
      () => Promise.reject(fsError('EISDIR', 'illegal operation on a directory')) as never,
    );
    const err = await assertFileExists(join(tmpRoot, 'dir.md'), '文件不存在', log).then(
      () => null,
      (e: unknown) => e,
    );
    expect(codeOf(err)).toBe('IO_ERROR');
  });

  it('打开成功 → 句柄一定被 close(不泄漏 fd)', async () => {
    const close = vi.fn(async () => undefined);
    const fakeFh = { close } as unknown as Awaited<ReturnType<typeof fsPromises.open>>;
    vi.spyOn(fsPromises, 'open').mockImplementationOnce((() =>
      Promise.resolve(fakeFh)) as unknown as typeof fsPromises.open);
    await expect(
      assertFileExists(join(tmpRoot, 'ok.md'), '文件不存在', log),
    ).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
