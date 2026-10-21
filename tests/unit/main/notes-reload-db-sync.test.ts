// tests/unit/main/notes-reload-db-sync.test.ts
//
// 守 r180「笔记域 reload 必须把 DB 拉齐到磁盘」契约。
//
// 旧实现:src/main/notes/service.ts 的 reload() 只重建内存 byId ——
//   const notes = await scanNotes(...); this.byId = next; this.emit('changed');
//   —— **从不碰 DB**。磁盘差集逻辑只存在于 resyncIfNeeded(),而它只在
//   启动期跑一次(r156 起的调用点)。
//
// 于是会话运行期间出现三个「列表与文件夹对不上」的洞:
//   1. 用户从 OS 拖进 <rootPath>/notes/ 的 .md:侧栏能看见(byId 重建了),
//      但 resources 表里**没有这一行** ⇒ 全局搜索 / FTS 永远搜不到它
//      (literature 域 r136 起每次 reload 都做差集,两个域行为相反);
//   2. 用户用外部编辑器改过的 .md:侧栏标题是新的,DB 里的 body 还是旧的
//      ⇒ 搜索命中旧正文,正文与文件内容不一致;
//   3. 用户在 OS 删掉的 .md:DB 留下 ghost 行 ⇒ 搜索还能搜到一篇磁盘上
//      已经不存在的东西(点进去 NOT_FOUND)。
//
// 本测锁四件事:
//   1. OS 拖入的 .md → reload 后进 DB(带 body ⇒ FTS 可搜);
//   2. 外部改写过的 .md → reload 后 DB 正文跟着更新(mtime 变 ⇒ 重写);
//   3. OS 删掉的 .md → reload 后 ghost 行被清理;
//   4. 磁盘没变 → reload **不重复写 DB**(否则每次防抖都全量重写,
//      indexed_at 被刷掉,「indexed_at=0 = body 未填」这个标记就失真了)。
//
// 真库(electron app.getPath)在测试环境不可用 → resources-repo 整体 mock
// 成一个内存 Map;被测行为(差集判定 + upsert/删除时机)全在 service 内。
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
  indexedAt: number;
  body: string;
  absPath: string;
}

const db = vi.hoisted(() => {
  const rows = new Map<string, FakeRow>();
  const calls = { upsert: 0, del: 0 };
  return { rows, calls };
});

vi.mock('../../../src/main/db/resources-repo', () => ({
  upsertResource: vi.fn((r: FakeRow, body: string, absPath: string) => {
    db.calls.upsert++;
    db.rows.set(r.id, { ...r, body, absPath });
  }),
  deleteResource: vi.fn((id: string) => {
    db.calls.del++;
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
import { noteResourceId } from '../../../src/shared/resource-id';

describe('笔记 reload ↔ DB 差集(r180)', () => {
  let root: string;
  let notesDir: string;
  let svc: NotesService;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'rkms-notereload-'));
    setRootPath(root);
    notesDir = join(root, 'notes');
    await fs.mkdir(notesDir, { recursive: true });
    db.rows.clear();
    db.calls.upsert = 0;
    db.calls.del = 0;
    svc = new NotesService();
    await svc.start({ skipInitialLoad: true });
  });

  afterEach(async () => {
    await svc.stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('OS 拖入的 .md → reload 后进 DB(带正文 ⇒ FTS 能搜到)', async () => {
    // 模拟用户在资源管理器里把 a.md 丢进 <root>/notes/
    await fs.writeFile(join(notesDir, 'external.md'), '# 外部笔记\n\n正文内容\n', 'utf-8');

    await svc.load();

    expect(svc.list().map((n) => n.relPath)).toEqual(['external.md']);
    const rows = [...db.rows.values()];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.relPath).toBe('external.md');
    expect(rows[0]?.kind).toBe('note');
    // 正文进了 DB(否则 FTS 索引里没有它,全局搜索搜不到)
    expect(rows[0]?.body).toContain('外部笔记');
  });

  it('外部编辑器改过的 .md → reload 后 DB 正文跟着更新', async () => {
    const created = await svc.create('edited.md');
    const file = join(notesDir, 'edited.md');
    const rowId = noteResourceId(created.id);
    const before = db.rows.get(rowId);
    expect(before?.body ?? '').not.toContain('外部新增的一行');

    // 外部改写正文(保留 frontmatter,只动 body)+ 显式推 mtime ——
    // 不推的话同毫秒内两次写会拿到相同 mtimeMs,断言会随机红。
    await fs.appendFile(file, '\n外部新增的一行\n', 'utf-8');
    const future = new Date(Date.now() + 5000);
    await fs.utimes(file, future, future);

    await svc.load();

    const after = db.rows.get(rowId);
    expect(after?.body).toContain('外部新增的一行');
  });

  it('OS 删掉的 .md → reload 后 ghost 行被清理(文件没了,索引也不能留)', async () => {
    const created = await svc.create('gone.md');
    const rowId = noteResourceId(created.id);
    expect(db.rows.has(rowId)).toBe(true);

    await fs.rm(join(notesDir, 'gone.md'), { force: true });

    await svc.load();

    expect(db.rows.has(rowId)).toBe(false);
    expect(db.rows.size).toBe(0);
  });

  it('内容变但 mtime 被保留(备份还原 / cp -p / 同步盘)⇒ DB 正文仍跟着更新(r220 size 双因子)', async () => {
    const created = await svc.create('restored.md');
    const file = join(notesDir, 'restored.md');
    const rowId = noteResourceId(created.id);
    await svc.load(); // 先收敛(建文件那刻与落盘后的 mtime 差补写一次)
    const upsertsBefore = db.calls.upsert;

    // 外部改写正文(字节数变),然后把 DB 行的 mtime 拨成**当前磁盘
    //   mtime** —— 等价于「备份还原 / cp -p 保留了 mtime ⇒ DB 行的 mtime
    //   与磁盘一致,但内容早就不一样了」。直接拨行而不是 fs.utimes:
    //   utimes 的 sub-ms 精度在 float64 秒往返里会丢,断言会随机红;
    //   这里要钉的语义是「row.mtime === disk mtime 且内容不同」,
    //   与 mtime 的绝对值无关。
    await fs.appendFile(file, '\n还原回来的新内容\n', 'utf-8');
    const diskMtime = (await fs.stat(file)).mtimeMs;
    const row = db.rows.get(rowId);
    expect(row).toBeDefined();
    row!.mtime = diskMtime;

    await svc.load();

    const after = db.rows.get(rowId);
    expect(
      after?.body,
      '只看 mtime 的旧判定把这次变更当成「没变」跳过 ⇒ FTS 永久停在旧正文',
    ).toContain('还原回来的新内容');
    expect(db.calls.upsert).toBeGreaterThan(upsertsBefore);
  });

  it('磁盘没变 → reload 不重复写 DB(不无脑刷新 indexed_at)', async () => {
    await svc.create('stable.md');
    // 第一次 load 可能因「建文件那一刻的 mtime 与落盘后的 mtime 不同」而补写
    // 一次 —— 先让它收敛,再量「稳态下不写」
    await svc.load();
    const before = db.calls.upsert;

    await svc.load();
    await svc.load();

    expect(db.calls.upsert).toBe(before);
  });
});
