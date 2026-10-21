// tests/unit/main/notes-resync-ghost-guard.test.ts
//
// 守 r209「启动期 resync 把**还在磁盘上**的笔记整片删掉」契约。
//
// 现象:应用启动时(NotesService.resyncIfNeeded)会做 disk ↔ DB 差集,
//   把「DB 有、磁盘上扫不到」的笔记行当 ghost 删掉。这个判定**只信
//   collectNotePaths 的扫描结果**,而扫描结果**可能是残缺的**:
//   collectNotePaths 对单个子目录的 readdir 失败是「log warn 后只丢这一支」
//   的(standalone.ts 的 per-branch try/catch,注释里点名了 Defender 锁目录 /
//   OneDrive placeholder / 权限翻转这些真实场景)⇒ 失败时缺的是**一整棵
//   子树**,不是「这些文件真被删了」。
//
// ⇒ 旧实现把那一整棵子树里的笔记**全部**判成 ghost 删掉:文件还在磁盘上,
//   索引行(DB + FTS)却没了 ⇒ 侧栏列表与全文搜索里这些笔记消失,而且
//   **本轮不会补回**(插入阶段先于删除阶段跑,且它也看不见这些文件)⇒ 要等
//   下次启动才可能回来。
//
// 旧注释写的「走到这里 collectNotePaths 已完整成功(扫描 throw 会让整个
// resync reject,不会带着残缺 diskRelSet 进删除分支)」**不成立** ——
// collectNotePaths 从不 throw。
//
// 修法:与同文件**运行期**路径 syncDbWithDisk(r180)的双重守卫对齐 ——
//   diskRelSet 之外再用「文件是不是**真的**没了」兜一次;且判据只在
//   **ENOENT** 时算「没了」,其余错误(EACCES / EBUSY …)fail-safe 当作
//   「还在」(把「读不到」当成「没了」,代价是删掉用户的笔记)。
//
// 本测锁四件事:
//   1. 扫描盲点(子目录 readdir 失败)⇒ 那棵子树里的笔记行**必须留下**;
//   2. 扫描盲点(深度 > 16 的深层笔记)⇒ 同样必须留下;
//   3. 真的被外部删掉的文件 ⇒ ghost 行**仍然**被清理(守卫不许把真 ghost 留下);
//   4. 文件「读不到」(stat 报 EACCES)⇒ 行留下(fail-safe,不许误删)。
//
// 真库(electron app.getPath)在测试环境不可用 → resources-repo 整体 mock
// 成一个内存 Map;被测行为(差集判定 + 删/留时机)全在 service 内。
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

// 模拟「某个子目录读不出来」(Defender 锁目录 / OneDrive placeholder / 权限翻转):
//   fs.promises.readdir 对路径含 'locked' 的目录直接 reject(EPERM)。
//   collectNotePaths 对这种失败是「log warn 后只丢这一支」⇒ 扫描结果缺一整棵子树。
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const realReaddir = actual.promises.readdir;
  const realStat = actual.promises.stat;
  return {
    ...actual,
    default: actual,
    promises: {
      ...actual.promises,
      readdir: (path: unknown, opts: unknown) => {
        if (typeof path === 'string' && path.includes('locked')) {
          const err = Object.assign(new Error(`EPERM: operation not permitted, scandir '${path}'`), {
            code: 'EPERM',
          });
          return Promise.reject(err);
        }
        return realReaddir(path as never, opts as never);
      },
      stat: (path: unknown, opts: unknown) => {
        if (typeof path === 'string' && path.includes('unreadable')) {
          const err = Object.assign(new Error(`EACCES: permission denied, stat '${path}'`), {
            code: 'EACCES',
          });
          return Promise.reject(err);
        }
        return realStat(path as never, opts as never);
      },
    },
  };
});

import { setRootPath } from '../../../src/main/utils/safe-write';
import { NotesService } from '../../../src/main/notes/service';
import { noteResourceId } from '../../../src/shared/resource-id';

describe('启动期 resync 的 ghost 清理守卫(r209)', () => {
  let root: string;
  let notesDir: string;
  let svc: NotesService;

  /** 造一条「DB 里有、磁盘上也有」的笔记行(模拟上一次会话留下的索引行)。 */
  function seedRow(relPath: string, id: string): string {
    const rowId = noteResourceId(id);
    db.rows.set(rowId, {
      id: rowId,
      kind: 'note',
      title: id,
      relPath,
      mtime: 1,
      indexedAt: 1,
      body: `# ${id}`,
      absPath: join(root, 'notes', relPath),
    });
    return rowId;
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'rkms-resyncguard-'));
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

  it('子目录读不出来 ⇒ 那棵子树里的笔记行必须留下(文件还在磁盘上)', async () => {
    const sub = join(notesDir, 'locked');
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(join(sub, 'a.md'), '# A\n\n正文\n', 'utf-8');
    const rowId = seedRow('locked/a.md', 'locked-a');

    await svc.resyncIfNeeded();

    expect(db.rows.has(rowId)).toBe(true);
  });

  it('深度 > 16 的深层笔记 ⇒ 行必须留下(collectNotePaths 的深度上限盲点)', async () => {
    // collectNotePaths 的 MAX_COLLECT_DEPTH = 16:第 17 层目录**不读**
    //   ⇒ 里面的 .md 扫不到。运行期路径 syncDbWithDisk(r180)早就用
    //   existsSync 兜住了这一类,启动期路径以前没有。
    const deepRel = Array.from({ length: 17 }, (_, i) => `L${i + 1}`).join('/');
    const dir = join(notesDir, ...deepRel.split('/'));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'deep.md'), '# Deep\n\n正文\n', 'utf-8');
    const rowId = seedRow(`${deepRel}/deep.md`, 'deep-note');

    await svc.resyncIfNeeded();

    expect(db.rows.has(rowId)).toBe(true);
  });

  it('运行期路径与启动期路径口径一致(同一份文件,两条路都留下)', async () => {
    const sub = join(notesDir, 'locked');
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(join(sub, 'a.md'), '# A\n\n正文\n', 'utf-8');
    const rowId = seedRow('locked/a.md', 'locked-a');

    await svc.load(); // 运行期路径(r180)
    expect(db.rows.has(rowId)).toBe(true);

    await svc.resyncIfNeeded(); // 启动期路径(r209)
    expect(db.rows.has(rowId)).toBe(true);
  });

  it('真被外部删掉的文件 ⇒ ghost 行仍然被清理(守卫不许把真 ghost 留下)', async () => {
    const rel = 'gone.md';
    await fs.writeFile(join(notesDir, rel), '# Gone\n\n正文\n', 'utf-8');
    const rowId = seedRow(rel, 'gone-note');
    // 文件真的没了
    await fs.rm(join(notesDir, rel), { force: true });

    await svc.resyncIfNeeded();

    expect(db.rows.has(rowId)).toBe(false);
  });

  it('文件「读不到」(stat 报 EACCES)⇒ 行留下(fail-safe:不许把读不到当成没了)', async () => {
    // 两个故障叠在一起才算真正走到 fail-safe 分支:
    //   ① 文件在 'locked' 子树里 ⇒ 扫描看不见它(否则它压根不进 dbOnly 分支);
    //   ② stat 报 EACCES ⇒ existsSync 会返回 false(把「读不到」压成
    //      「没了」)—— 判据必须是「只有 ENOENT 才算没了」。
    const sub = join(notesDir, 'locked');
    await fs.mkdir(sub, { recursive: true });
    const rel = 'locked/unreadable.md';
    await fs.writeFile(join(notesDir, ...rel.split('/')), '# Unreadable\n\n正文\n', 'utf-8');
    const rowId = seedRow(rel, 'unreadable-note');

    await svc.resyncIfNeeded();

    expect(db.rows.has(rowId)).toBe(true);
  });
});
