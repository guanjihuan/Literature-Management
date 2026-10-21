// tests/unit/main/utils/atomic-file.test.ts
//
// 守卫:AtomicFile 是「用户亲手维护的单文件状态」的通用抽象 —— 本项目里
//   唯一的生产实例就是用户的收藏夹 <root>/workspace/favorites/favorites.md。
//   它是**唯一**的数据保护层(parse 失败 → quarantine;写 → 原子写),
//   之前**没有任何直接测试**(tests/unit/main/utils/ 只有 safe-write)。
//
// audit r199 (2026-10-20) 修的 bug:start() 里 fs.readFile 和 this.parse
//   共用一个 try/catch ⇒ **任何读错误**都被当成「文件损坏」:
//     1. 把用户的 favorites.md rename 成 .corrupt-<ts>(内容可能完好!);
//     2. 内存态回落**空列表**且不抛错 ⇒ 界面上 ★ 全部消失,零错误提示;
//     3. 用户下一次点 ★ → persist 写出一个**新的** favorites.md ⇒
//        原来的 200 条收藏只剩 .corrupt-* 那一份。
//   即:一次瞬时读失败(权限 / 被占用 / 路径其实是目录)= 收藏全丢。
//
// 本文件的 6 例锁住新契约:
//   1. 读失败(EISDIR:路径其实是目录)→ start() 抛错,目录原样保留,
//      **不产生 .corrupt-***,后续写入被拒(写锁);
//   2. 读失败(EACCES:权限不足)→ 原文件内容**一字不动**,不 quarantine,
//      写入被拒 —— 这是「用户的 200 条收藏还在盘上」那条最关键的断言;
//   3. **parse 失败仍然 quarantine**(r196 契约不能被 r199 改坏):
//      坏文件被改名保留,内存态回落默认值,之后仍可正常写;
//   4. ENOENT → 写一份 defaultValue 落地(首次运行路径);
//   5. 正常加载 → 内存态 = 解析结果,无 .corrupt-*;
//   6. 读阶段的瞬时 EBUSY 会被退避重试(而不是被当成「损坏」)。
import { mkdtemp, rm, readFile, readdir, stat, writeFile, mkdir } from 'fs/promises';
import { promises as fsPromises } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AtomicFile } from '../../../../src/main/utils/atomic-file';

interface Shape {
  entries: string[];
}

const DEFAULT_VALUE: Shape = { entries: [] };

function makeFile(filePath: string): AtomicFile<Shape> {
  return new AtomicFile<Shape>({
    filePath,
    defaultValue: DEFAULT_VALUE,
    serialize: (v) => JSON.stringify(v),
    parse: (raw) => {
      const p = JSON.parse(raw) as { entries?: unknown };
      if (!Array.isArray(p.entries)) throw new Error('entries must be an array');
      return { entries: p.entries as string[] };
    },
    logScope: 'atomic-file-test',
  });
}

/** 造一个带 errno code 的错误(模拟 EACCES / EBUSY / EISDIR) */
function fsError(code: string, msg: string): NodeJS.ErrnoException {
  const e = new Error(msg) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

describe('atomic-file', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'atomic-file-test-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('读失败(EISDIR:路径其实是目录)→ 抛错 + 目录原样保留 + 不 quarantine + 写入被拒', async () => {
    const filePath = join(tmpRoot, 'favorites.md');
    await mkdir(filePath); // 目录占位 → readFile 必然失败
    const file = makeFile(filePath);

    await expect(file.start()).rejects.toThrow();

    // 文件还在原地(没被 rename 走),类型也没变
    expect((await stat(filePath)).isDirectory()).toBe(true);
    // 没有产生任何 .corrupt-* 兄弟文件
    expect((await readdir(tmpRoot)).filter((n) => n.includes('.corrupt-'))).toHaveLength(0);
    // 写锁生效:★ toggle 不能把用户数据覆盖成空态
    await expect(file.write({ entries: ['x'] })).rejects.toThrow(/Refusing to overwrite/);
  });

  it('读失败(EACCES:权限不足)→ 原文件内容一字不动,写入被拒', async () => {
    const filePath = join(tmpRoot, 'favorites.md');
    const original = JSON.stringify({ entries: ['a', 'b', 'c'] });
    await writeFile(filePath, original, 'utf8');
    const file = makeFile(filePath);

    const spy = vi
      .spyOn(fsPromises, 'readFile')
      .mockImplementationOnce(() => Promise.reject(fsError('EACCES', 'permission denied')));

    await expect(file.start()).rejects.toThrow();
    spy.mockRestore();

    // 用户的收藏内容**原封不动**留在盘上
    expect(await readFile(filePath, 'utf8')).toBe(original);
    // 没有被当成「损坏文件」改名走
    expect((await readdir(tmpRoot)).filter((n) => n.includes('.corrupt-'))).toHaveLength(0);
    // 写锁生效:后续 toggle 不会把这份完好数据覆盖掉
    await expect(file.write({ entries: ['x'] })).rejects.toThrow(/Refusing to overwrite/);
    expect(await readFile(filePath, 'utf8')).toBe(original);
  });

  it('parse 失败仍然 quarantine(r196 契约):坏文件改名保留,内存态回落默认值,之后可正常写', async () => {
    const filePath = join(tmpRoot, 'favorites.md');
    const garbage = 'this is not json at all';
    await writeFile(filePath, garbage, 'utf8');
    const file = makeFile(filePath);

    // parse 失败**不抛错**(启动继续),而是 quarantine + 回落默认值
    await expect(file.start()).resolves.toBeUndefined();
    expect(file.get()).toEqual(DEFAULT_VALUE);

    const siblings = await readdir(tmpRoot);
    const quarantined = siblings.filter((n) => n.startsWith('favorites.md.corrupt-'));
    expect(quarantined).toHaveLength(1);
    // 原件已被改名走,内容完整保留在 .corrupt-* 里
    expect(await readFile(join(tmpRoot, quarantined[0]), 'utf8')).toBe(garbage);
    await expect(stat(filePath)).rejects.toThrow();

    // quarantine 成功 ⇒ 没有锁写(数据已经安全留存)
    await file.write({ entries: ['fresh'] });
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({ entries: ['fresh'] });
  });

  it('ENOENT(首次运行)→ 写一份 defaultValue 落地,内存态 = 默认值', async () => {
    const filePath = join(tmpRoot, 'favorites.md');
    const file = makeFile(filePath);

    await file.start();

    expect(file.get()).toEqual(DEFAULT_VALUE);
    expect((await stat(filePath)).isFile()).toBe(true);
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual(DEFAULT_VALUE);
  });

  it('正常加载 → 内存态 = 解析结果,无 .corrupt-*', async () => {
    const filePath = join(tmpRoot, 'favorites.md');
    await writeFile(filePath, JSON.stringify({ entries: ['x', 'y'] }), 'utf8');
    const file = makeFile(filePath);

    await file.start();

    expect(file.get()).toEqual({ entries: ['x', 'y'] });
    expect((await readdir(tmpRoot)).filter((n) => n.includes('.corrupt-'))).toHaveLength(0);
  });

  it('读阶段的瞬时 EBUSY 被退避重试(而不是被当成「文件损坏」)', async () => {
    const filePath = join(tmpRoot, 'favorites.md');
    await writeFile(filePath, JSON.stringify({ entries: ['x'] }), 'utf8');
    const file = makeFile(filePath);

    const spy = vi
      .spyOn(fsPromises, 'readFile')
      .mockImplementationOnce(() => Promise.reject(fsError('EBUSY', 'file is busy')));

    await expect(file.start()).resolves.toBeUndefined();
    spy.mockRestore();

    expect(file.get()).toEqual({ entries: ['x'] });
    expect((await readdir(tmpRoot)).filter((n) => n.includes('.corrupt-'))).toHaveLength(0);
  });
});
