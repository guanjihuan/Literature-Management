// tests/unit/main/notes-scan-parse-cache.test.ts
//
// 守 perf r239「scanNotes 的 stat 门控解析缓存」契约。
//
// 背景(用户诉求「使用流畅,不要有卡顿」):scanNotes 每次都把每个 .md
//   open+read+gray-matter 解析一遍。实测(本机,8KB/篇):
//     500 篇 → 124ms;2000 篇 → 410ms。
//   成本拆解(read-only 373ms vs matter 解析 20.7ms @ N=500)证明瓶颈是
//   **每文件的 open/read syscall** ⇒ 解法是「先 stat,没变就复用上次解析
//   结果」:500 篇 readdir+stat 全量 ≈ 15ms;2000 篇 ≈ 60ms。
//
// 命中判据 = mtime + size + ino 三因子(与 utils/fs-cache 的 readNote
//   缓存、DB 同步 r220 的双因子口径同源)。
//
// 本测锁三件事:
//   1. 文件没变 ⇒ 第二次扫描**复用同一批解析结果**(不重读磁盘);
//   2. 文件变了 ⇒ 重新解析(拿到新正文)—— 正确性方向,比性能更重要;
//   3. 文件被删 ⇒ 结果里没有它,且缓存条目被剪掉(不留悬挂引用)。
//
// 已知取舍(不锁,锁了就是把 bug 写成契约):「内容变但 mtime 保留且长度
//   相同」判成「没变」。这是全项目一致的双因子盲区(备份还原 / cp -p /
//   同步盘按内容去重),要兜只能全文 hash,代价是每次全量读回 —— 正是
//   本轮要消掉的成本。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  scanNotes,
  clearNoteParseCache,
  noteParseCacheSize,
} from '../../../src/main/notes/standalone';

const fm = (title: string, body: string) => `---\ntitle: "${title}"\n---\n\n${body}\n`;

describe('scanNotes 的 stat 门控解析缓存(r239)', () => {
  let root: string;
  let notesDir: string;

  beforeEach(async () => {
    clearNoteParseCache();
    root = await fs.mkdtemp(join(tmpdir(), 'rkms-notecache-'));
    notesDir = join(root, 'notes');
    await fs.mkdir(notesDir, { recursive: true });
  });

  afterEach(async () => {
    clearNoteParseCache();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('文件没变 ⇒ 第二次扫描复用同一批解析结果(不重读磁盘)', async () => {
    await fs.writeFile(join(notesDir, 'a.md'), fm('A', 'body A'), 'utf8');
    await fs.writeFile(join(notesDir, 'b.md'), fm('B', 'body B'), 'utf8');

    const first = await scanNotes(root);
    expect(first).toHaveLength(2);
    expect(noteParseCacheSize()).toBe(2);

    const second = await scanNotes(root);
    expect(second).toHaveLength(2);
    // 同一批**对象**(命中缓存 ⇒ 没有重新读盘 + 重新解析)
    const byRel = new Map(first.map((n) => [n.relPath, n]));
    for (const n of second) {
      expect(n).toBe(byRel.get(n.relPath));
    }
  });

  it('文件变了 ⇒ 重新解析(拿到新正文,不能拿缓存里的旧值)', async () => {
    const p = join(notesDir, 'a.md');
    await fs.writeFile(p, fm('A', 'body A'), 'utf8');
    const first = await scanNotes(root);
    expect(first[0]!.body).toContain('body A');

    // 长度也变(size 是命中判据之一)⇒ 必然 cache miss
    await fs.writeFile(p, fm('A edited', 'body A edited and longer'), 'utf8');
    const second = await scanNotes(root);
    expect(second).toHaveLength(1);
    expect(second[0]).not.toBe(first[0]);
    expect(second[0]!.body).toContain('body A edited and longer');
    expect(second[0]!.title).toBe('A edited');
  });

  it('文件被删 ⇒ 结果里没有它,缓存条目被剪掉(不留悬挂引用)', async () => {
    const a = join(notesDir, 'a.md');
    const b = join(notesDir, 'b.md');
    await fs.writeFile(a, fm('A', 'body A'), 'utf8');
    await fs.writeFile(b, fm('B', 'body B'), 'utf8');
    await scanNotes(root);
    expect(noteParseCacheSize()).toBe(2);

    await fs.rm(a);
    const second = await scanNotes(root);
    expect(second.map((n) => n.relPath)).toEqual(['b.md']);
    // 剪枝:被删文件的条目不再占位
    expect(noteParseCacheSize()).toBe(1);
  });
});
