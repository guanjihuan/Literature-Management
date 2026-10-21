// tests/unit/main/notes-reload-body-bytes.test.ts
//
// 守 perf r255「笔记正文的 UTF-8 字节数不许每轮 reload 重算」的契约。
//
// ── 被守卫的优化 ───────────────────────────────────────────────────
//   notes reload 的两处判定都要「这篇笔记的 body 有多少字节」:
//     ① emit 幂等指纹(r223):`${id}|${mtime}|${byteLength(body)}`
//     ② DB 同步(r220):`row.size === byteLength(body)` 判「变了没」
//   旧实现两处都现场 `Buffer.byteLength(body,'utf8')` —— 而 byteLength
//   是**一次全量 UTF-8 扫描**:实测 2000 篇 × 8KB = 12.7ms/遍,两处
//   = 25.4ms 的**主线程纯 CPU**(不是 I/O 等待 ⇒ 直接推迟同期的其它
//   IPC 响应 ⇒ 用户侧「卡一下」)。稳态(文件没变)下这 25ms 是纯白烧。
//
//   修法:字节数跟着解析结果一起缓存(stat 门控解析缓存,r239),
//   命中即复用 ⇒ 稳态零计算。
//
// ── 本测锁四件事 ───────────────────────────────────────────────────
//   A. **字节数维度必须被看见**:正文变长 + **mtime 保留**(备份还原 /
//      cp -p / 同步盘按内容去重的真实形态)⇒ 必须 emit('changed') 且
//      DB 行的 size 跟着更新。
//      —— 这是唯一能把「字节数」与「mtime」两个维度分开的构造:若实现
//      复用了**陈旧**的字节数,指纹不变 ⇒ 不 emit;DB 判定相等 ⇒ 不
//      upsert ⇒ 两处都红。
//   B. **稳态不白写 DB**:文件没变 ⇒ 二次 reload **零 upsert**
//      (字节数口径与写库口径若不一致 ⇒ 每轮都重写 ⇒ 红)。
//   C. **字节数是 UTF-8 字节数,不是字符数**:中文正文的字节数必须
//      > 字符串长度,且 DB 行的 size == Buffer.byteLength(body)。
//   D. **缓存不得陈旧**:文件改了 ⇒ 下一轮拿到的是**新**字节数
//      (解析缓存的 stat 门控命中判据变了 ⇒ 必须重算)。
//
// 真库(electron app.getPath)在测试环境不可用 → resources-repo 整体
// mock 成内存 Map(与 notes-reload-emit-fingerprint.test.ts 同款 harness)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

interface FakeRow {
  id: string;
  kind: string;
  title: string;
  relPath: string;
  mtime: number;
  size: number;
  indexedAt: number;
  body: string;
  absPath: string;
}

const db = vi.hoisted(() => {
  const rows = new Map<string, FakeRow>();
  const calls = { upsert: 0 };
  return { rows, calls };
});

vi.mock('../../../src/main/db/resources-repo', () => ({
  upsertResource: vi.fn((r: FakeRow, body: string, absPath: string) => {
    db.calls.upsert++;
    db.rows.set(r.id, { ...r, body, absPath });
  }),
  deleteResource: vi.fn((id: string) => {
    db.rows.delete(id);
  }),
  listResources: vi.fn((kind?: string) =>
    [...db.rows.values()].filter((r) => !kind || r.kind === kind),
  ),
  listResourceRelPaths: vi.fn((kind: string) =>
    [...db.rows.values()].filter((r) => r.kind === kind).map((r) => r.relPath),
  ),
  listStaleIndexIds: vi.fn((kind: string) =>
    [...db.rows.values()].filter((r) => r.kind === kind && r.indexedAt === 0).map((r) => r.id),
  ),
  renameResource: vi.fn((prevId: string, r: FakeRow, body: string, absPath: string) => {
    db.rows.delete(prevId);
    db.rows.set(r.id, { ...r, body, absPath });
  }),
}));

// electron 需整体 mock:safe-write 用 shell.trashItem(节点环境没有真回收站)
vi.mock('electron', () => ({
  shell: {
    trashItem: async (target: string) => {
      const { rename } = await import('fs/promises');
      const { basename, join: j } = await import('path');
      const trashDir = j(target, '..', '..', '.trash');
      await fs.mkdir(trashDir, { recursive: true });
      await rename(target, j(trashDir, basename(target)));
    },
  },
}));

import { setRootPath } from '../../../src/main/utils/safe-write';
import { NotesService } from '../../../src/main/notes/service';
import { scanNotes, clearNoteParseCache } from '../../../src/main/notes/standalone';
import { noteResourceId } from '../../../src/shared/resource-id';

/** 固定 mtime(整秒 ⇒ mtimeMs 无小数,断言可以严格相等)。 */
const FIXED_MTIME = new Date(1_700_000_000_000);

describe('笔记正文字节数的复用(r255)', () => {
  let root: string;
  let notesDir: string;
  let svc: NotesService;

  /**
   * 落盘后的 body 期望字节数。
   * 文件形态 = `---
title: "T"
---

<text>
` ⇒ gray-matter 的
   * content = `
<text>
` ⇒ cleanBody 只收尾的换行 ⇒ body = `
<text>`
   * (前导那个空行是 frontmatter 之后的换行,属于正文)。
   */
  function expectedBytes(text: string): number {
    return Buffer.byteLength(`
${text}`, 'utf8');
  }

  /** 落一个 .md 并把 mtime 钉到 FIXED_MTIME。 */
  async function writeNote(name: string, title: string, body: string): Promise<string> {
    const p = join(notesDir, name);
    await fs.writeFile(p, `---\ntitle: "${title}"\n---\n\n${body}\n`, 'utf-8');
    await fs.utimes(p, FIXED_MTIME, FIXED_MTIME);
    return p;
  }

  beforeEach(async () => {
    clearNoteParseCache();
    root = await fs.mkdtemp(join(tmpdir(), 'rkms-notebytes-'));
    setRootPath(root);
    notesDir = join(root, 'notes');
    await fs.mkdir(notesDir, { recursive: true });
    db.rows.clear();
    db.calls.upsert = 0;
    svc = new NotesService();
    await svc.start({ skipInitialLoad: true });
  });

  afterEach(async () => {
    await svc.stop();
    clearNoteParseCache();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('A 正文变长 + mtime 保留 ⇒ 必须 emit 且 DB 行的 size 更新(字节数维度要能看见)', async () => {
    await writeNote('a.md', 'A', '短正文');
    await svc.load();

    const rowId = noteResourceId(svc.findById(svc.list()[0]!.id)!.id);
    const before = db.rows.get(rowId)!;
    expect(before.size).toBe(expectedBytes('短正文'));

    // 外部改写:正文变长,mtime **保留**(cp -p / 备份还原的形态)
    const p = join(notesDir, 'a.md');
    await fs.writeFile(p, `---\ntitle: "A"\n---\n\n短正文而且更长了\n`, 'utf-8');
    await fs.utimes(p, FIXED_MTIME, FIXED_MTIME);

    const changed = vi.fn();
    svc.on('changed', changed);
    await svc.load();

    expect(changed, 'mtime 保留但正文变长 ⇒ 指纹必须变(否则 renderer 看不到更新)').toHaveBeenCalledTimes(1);
    const after = db.rows.get(rowId)!;
    expect(after.size, 'DB 行的 size 必须跟着正文长度更新').toBe(
      expectedBytes('短正文而且更长了'),
    );
    expect(after.size).not.toBe(before.size);
  });

  it('B 文件没变 ⇒ 二次 reload 零 upsert(不白写 DB)', async () => {
    await writeNote('b.md', 'B', '正文 B');
    await svc.load();
    const upsertsAfterFirst = db.calls.upsert;
    expect(upsertsAfterFirst).toBeGreaterThan(0);

    const changed = vi.fn();
    svc.on('changed', changed);
    await svc.load();
    await svc.load();

    expect(db.calls.upsert, '内容没变却每轮重写 DB ⇒ FTS 被反复重建').toBe(upsertsAfterFirst);
    expect(changed).not.toHaveBeenCalled();
  });

  it('C 中文正文的 size 是 UTF-8 字节数(不是字符数)', async () => {
    await writeNote('c.md', 'C', '注意力机制');
    await svc.load();

    const note = svc.list()[0]!;
    const row = db.rows.get(noteResourceId(note.id))!;
    const body = svc.findById(note.id)!.body;

    expect(Buffer.byteLength(body, 'utf8'), '本用例必须真的含多字节字符(否则测不出维度)').toBeGreaterThan(
      body.length,
    );
    expect(row.size).toBe(Buffer.byteLength(body, 'utf8'));
  });

  it('D 文件改了 ⇒ 下一轮拿到的是新字节数(缓存不许陈旧)', async () => {
    await writeNote('d.md', 'D', '第一版');
    const first = new Map<string, number>();
    await scanNotes(root, { bodyBytesOut: first });
    expect(first.get('d.md')).toBe(expectedBytes('第一版'));

    const p = join(notesDir, 'd.md');
    await fs.writeFile(p, `---\ntitle: "D"\n---\n\n第二版更长了\n`, 'utf-8');

    const second = new Map<string, number>();
    await scanNotes(root, { bodyBytesOut: second });
    expect(second.get('d.md'), '文件变了 ⇒ 字节数必须重算,不能拿缓存里的旧值').toBe(
      expectedBytes('第二版更长了'),
    );
  });

  it('E 稳态 reload 不再算字节数(零 byteLength 调用 —— 这就是本轮的性能契约)', async () => {
    await writeNote('e.md', 'E', '正文 E');
    // 首轮:解析期算一次(缓存回填)
    await svc.load();

    const spy = vi.spyOn(Buffer, 'byteLength');
    try {
      await svc.load();
      expect(
        spy.mock.calls.length,
        '文件没变 ⇒ 字节数应直接取解析缓存,不该再全量扫一遍正文',
      ).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});
