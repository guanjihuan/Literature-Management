// tests/unit/main/utils/safe-write.test.ts
//
// 守卫:safe-write 是主进程所有写操作的唯一入口(rootPath 边界检查)。
//   写的对错决定用户数据安全 —— UNSAFE_WRITE 误抛会让笔记无法保存;
//   反之漏抛会写到 rootPath 外,污染用户家目录。
// 4 例守最关键契约:
//   1. setRootPath + getRootPath round-trip,未初始化抛 INTERNAL。
//   2. safeWriteFileAtomic 写进 rootPath 内的子目录 OK(注意是相对路径,
//      函数内部 resolve(dp, target))。
//   3. 试图写绝对路径到 rootPath 外抛 UnsafeWriteError(code='UNSAFE_WRITE')。
//   4. ENAMETOOLONG-style 超长单段名显式 reject(而非让 fs 抛)。当前
//      safeRecursiveTrash 等走 resolveInsideDataPath 链,parent UNSAFE
//      入口撞 ENAMETOOLONG 应被显式 catch 转为 UNSAFE_WRITE;此处简化
//      验证「safeWriteFileAtomic 接受短名成功、文件名超长被拒」的形状。
//
// 历史:audit-r164 N4 (2026-10-15) 把 filesystem ENAMETOOLONG 兜底换成
//   main 显式 reject;memory r165 锁定 setI18nLangProvider 槽;本测
//   复跑同一组约束,断不再回退。
import { mkdtemp, rm, stat, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('safe-write', () => {
  let tmpRoot: string;
  // 关键:每次 beforeEach 重置模块 —— safe-write 的 currentDataPath / langProvider
  // 都是 module-level 单例,vi.resetModules + 重新 import 让测试彼此隔离
  // (memory r165 第五个避坑)。
  beforeEach(async () => {
    vi.resetModules();
    tmpRoot = await mkdtemp(join(tmpdir(), 'sw-test-'));
  });
  afterEach(async () => {
    vi.resetModules();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('getRootPath 未初始化抛 INTERNAL', async () => {
    const { getRootPath } = await import('../../../../src/main/utils/safe-write');
    try {
      getRootPath();
      expect.fail('应抛错');
    } catch (e: unknown) {
      expect((e as { code?: string }).code).toBe('INTERNAL');
    }
  });

  it('setRootPath + getRootPath round-trip,然后 in-root 写入成功', async () => {
    const { setRootPath, getRootPath, safeWriteFileAtomic } = await import(
      '../../../../src/main/utils/safe-write'
    );
    setRootPath(tmpRoot);
    expect(getRootPath()).toBe(tmpRoot);
    const target = 'notes/hello.md';
    await safeWriteFileAtomic(target, '# Hello\n');
    const onDisk = await stat(join(tmpRoot, 'notes', 'hello.md'));
    expect(onDisk.isFile()).toBe(true);
  });

  it('写 rootPath 外抛 UnsafeWriteError(code UNSAFE_WRITE)', async () => {
    const { setRootPath, safeWriteFileAtomic, UnsafeWriteError } = await import(
      '../../../../src/main/utils/safe-write'
    );
    setRootPath(tmpRoot);
    // 拿到一个 parent 目录的绝对路径作为 attack
    const outsideDir = await mkdtemp(join(tmpdir(), 'sw-out-'));
    try {
      const attack = join(outsideDir, 'evil.md');
      let caught: unknown;
      try {
        await safeWriteFileAtomic(attack, 'x');
      } catch (e: unknown) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(UnsafeWriteError);
      expect((caught as { code?: string }).code).toBe('UNSAFE_WRITE');
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('单段文件名长度超 255 显式 reject(不合 ENAMETOOLONG 透传)', async () => {
    const { setRootPath, safeWriteFileAtomic } = await import(
      '../../../../src/main/utils/safe-write'
    );
    setRootPath(tmpRoot);
    await mkdir(join(tmpRoot, 'notes'), { recursive: true });
    const huge = 'a'.repeat(300) + '.md';
    let code: string | undefined;
    let rejected = false;
    try {
      await safeWriteFileAtomic(`notes/${huge}`, 'x');
    } catch (e: unknown) {
      rejected = true;
      code = (e as { code?: string }).code;
    }
    expect(rejected).toBe(true);
    // 不限具体是 UNSAFE_WRITE 还是 VALIDATION,只要不在文件系统层抛 ENAMETOOLONG 即可
    expect(code).not.toBe('ENAMETOOLONG');
    expect(typeof code).toBe('string');
  });
});
