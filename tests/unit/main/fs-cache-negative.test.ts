// tests/unit/main/fs-cache-negative.test.ts
//
// 守 fs-cache 的缓存契约(2026-10-20,r197):
//
//   1. 文件不存在(ENOENT)→ 返 null,且**不进缓存** —— 文件随后被创建时
//      必须能立刻读到。
//   2. 同一文件重复读 → parser 只跑一次(mtime/size/ino 三者一致才算命中)。
//   3. invalidateFile 后 → 下次读重新 parse。
//   4. win32/darwin 下大小写不同的路径 → 同一个缓存条目。
//
// 第 1 条锁的是 r197 删掉的「负缓存」:旧实现把 ENOENT 写进缓存
// (mtimeMs/size/ino 全 -1 + missing=true),但读路径**先 open 成功**才查
// 缓存 ⇒ 负缓存条目永远命中不了,`cached.missing` 分支恒 false —— 它只是
// 白占一个 FIFO 槽位(把真热条目挤出去),还让注释吹嘘的「避免重复 stat」
// 根本不成立。本测同时锁住「负缓存不得复活」这条线:文件先不存在、
// 后创建,第二次读必须拿到内容(若有人再把 missing 缓存回来且不带 TTL,
// 这条会红)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { cachedReadParse, invalidateFile } from '../../../src/main/utils/fs-cache';

describe('fs-cache 缓存契约(r197)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'rkms-fscache-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('文件不存在 → 返 null,不抛', async () => {
    const res = await cachedReadParse(join(root, 'nope.md'), (raw) => raw);
    expect(res).toBeNull();
  });

  it('文件先不存在、后创建 → 第二次读必须拿到内容(负缓存不得吞掉新文件)', async () => {
    const p = join(root, 'late.md');
    expect(await cachedReadParse(p, (raw) => raw)).toBeNull();
    await fs.writeFile(p, '# hello', 'utf-8');
    const res = await cachedReadParse(p, (raw) => raw);
    expect(res).not.toBeNull();
    expect(res?.value).toBe('# hello');
  });

  it('同一文件重复读 → parser 只跑一次', async () => {
    const p = join(root, 'a.md');
    await fs.writeFile(p, 'v1', 'utf-8');
    const parser = vi.fn((raw: string) => raw);
    const first = await cachedReadParse(p, parser);
    const second = await cachedReadParse(p, parser);
    expect(first?.value).toBe('v1');
    expect(second?.value).toBe('v1');
    expect(parser).toHaveBeenCalledTimes(1);
  });

  it('invalidateFile 后 → 重新 parse', async () => {
    const p = join(root, 'b.md');
    await fs.writeFile(p, 'v1', 'utf-8');
    const parser = vi.fn((raw: string) => raw);
    await cachedReadParse(p, parser);
    invalidateFile(p);
    await cachedReadParse(p, parser);
    expect(parser).toHaveBeenCalledTimes(2);
  });

  it('内容改了(大小变化)→ 重新 parse,不会返回 stale', async () => {
    const p = join(root, 'c.md');
    await fs.writeFile(p, 'v1', 'utf-8');
    const parser = vi.fn((raw: string) => raw);
    const first = await cachedReadParse(p, parser);
    await fs.writeFile(p, 'v2-longer', 'utf-8');
    const second = await cachedReadParse(p, parser);
    expect(first?.value).toBe('v1');
    expect(second?.value).toBe('v2-longer');
    expect(parser).toHaveBeenCalledTimes(2);
  });

  it('parser 主动返回 null(业务值)→ 缓存命中后仍是 null,不是「文件不存在」', async () => {
    const p = join(root, 'd.md');
    await fs.writeFile(p, 'x', 'utf-8');
    const parser = vi.fn(() => null as string | null);
    const first = await cachedReadParse(p, parser);
    const second = await cachedReadParse(p, parser);
    expect(first?.value).toBeNull();
    expect(second?.value).toBeNull();
    expect(parser).toHaveBeenCalledTimes(1);
  });
});
