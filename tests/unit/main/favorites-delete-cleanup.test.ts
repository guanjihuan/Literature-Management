// tests/unit/main/favorites-delete-cleanup.test.ts
//
// 守 r198「文件被删除后,收藏(★)必须跟着走」契约 —— remapFavoriteIds 的
//   **另一半**。
//
// 背景(用户诉求「文件操作也是对应的」的元数据一半):
//   r182 补上了「id 变了 → ★ 跟着改」(改名 / 搬移 / 目录改名)。
//   但**删除**路径一直只动文件 + DB 行,没人管 favorites.md ⇒ 收藏条目
//   变成永远命中不了的孤儿,三个后果:
//
//   1. favorites.md 无限增长(每个删掉的 ★ 文献留一条死条目);
//   2. **★ 状态错位(用户可见)**:文献 id = 'lit:'+toPosix(absPath) ——
//      把同一个 PDF 从原路径再导入一次 ⇒ id 完全相同 ⇒ 新行**继承**旧 ★
//      (用户从没点过,却显示已收藏);再点一下是「取消收藏」(toggle 语义),
//      用户更困惑;
//   3. notes 域同样会留孤儿(现在还没笔记 ★ 的 UI,但 favorites.md 设计上
//      可手工编辑,老版本 / 手改都可能留下笔记条目)。
//
// 本测锁(行为级,对着 favorites.md 的真实内容说话):
//   1. 文献删除 → 该 id 的收藏条目消失;
//   2. 笔记移入回收站 → 该 id 的收藏条目消失;
//   3. 删除**没收藏**的文件 → favorites.md 条目数不变(不空写盘),
//      别的收藏也不受影响;
//   4. 同路径再导入 → **不继承**旧 ★(toggle 返回 true = 加入收藏,
//      而不是 false = 取消收藏)。
//
// 真库(electron app.getPath)在测试环境不可用 → resources-repo 整体 mock;
// favorites 走真 AtomicFile(临时 root 下的 workspace/favorites/favorites.md)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const repo = vi.hoisted(() => ({
  upsertResource: vi.fn(),
  deleteResource: vi.fn(),
  listResources: vi.fn(() => [] as unknown[]),
  listResourceRelPaths: vi.fn(() => [] as string[]),
  listStaleIndexIds: vi.fn(() => [] as unknown[]),
  renameResource: vi.fn(),
}));

vi.mock('../../../src/main/db/resources-repo', () => ({
  upsertResource: repo.upsertResource,
  deleteResource: repo.deleteResource,
  listResources: repo.listResources,
  listResourceRelPaths: repo.listResourceRelPaths,
  listStaleIndexIds: repo.listStaleIndexIds,
  renameResource: repo.renameResource,
}));

// electron 整体 mock:ipcMain.handle 捕获 handler(验「通道真的把清理
// 串到 favorites 上」),shell.trashItem 让 safeTrash 在 node 环境可调
// (把文件搬进 .trash 目录 —— 证明「文件还在、只是换了位置」= 可恢复)
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
      trashItem: async (target: string) => {
        const { rename } = await import('fs/promises');
        const { basename, join: j } = await import('path');
        const trashDir = j(target, '..', '..', '.trash');
        await fs.mkdir(trashDir, { recursive: true });
        await rename(target, j(trashDir, basename(target)));
      },
    },
  };
});

vi.mock('electron', () => ({
  ipcMain: electronMock.ipcMain,
  shell: electronMock.shell,
}));

import { setRootPath } from '../../../src/main/utils/safe-write';
import { LiteratureService } from '../../../src/main/literature/literature-service';
import { NotesService } from '../../../src/main/notes/service';
import { registerLiteratureIPC } from '../../../src/main/ipc/literature';
import { registerNotesIPC } from '../../../src/main/ipc/notes';
import { getFavoritesService } from '../../../src/main/workspace/favorites';
import { IPC } from '../../../src/shared/types';

describe('文件被删除后收藏(★)跟着清理(r198)', () => {
  let root: string;
  let lit: LiteratureService;
  let notes: NotesService;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'rkms-favdel-'));
    setRootPath(root);
    await fs.mkdir(join(root, 'notes'), { recursive: true });
    await fs.mkdir(join(root, 'literature'), { recursive: true });
    electronMock.handlers.clear();
    const fav = getFavoritesService();
    await fav.start();
    lit = new LiteratureService();
    notes = new NotesService();
    await lit.start({ skipInitialLoad: true });
    await notes.start({ skipInitialLoad: true });
  });

  afterEach(async () => {
    await notes.stop();
    await lit.stop();
    await getFavoritesService().stop();
    // maxRetries/retryDelay:Windows 上 rm 递归删目录偶发 ENOTEMPTY
    //   (删除期间目录内容还在变 —— 本测的 shell.trashItem mock 会往 .trash
    //   里 rename 文件)。Node 的 rm 对 EBUSY/EMFILE/ENFILE/ENOTEMPTY/EPERM
    //   会线性退避重试 ⇒ 加重试把「全量套件并行时偶发红」变成稳定绿。
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('文献删除 → 该 id 的收藏条目消失(favorites.md 不留死条目)', async () => {
    const fav = getFavoritesService();
    const src = join(root, 'paper.pdf');
    await fs.writeFile(src, 'PDF-BYTES', 'utf-8');
    const imported = await lit.importFile(src);
    await fav.toggle(imported.id, { title: 'paper.pdf', relPath: imported.absPath });
    expect(fav.listEntries().filter((e) => e.kind === 'file')).toHaveLength(1);

    registerLiteratureIPC(lit);
    const handler = electronMock.handlers.get(IPC.LITERATURE_DELETE);
    expect(handler).toBeTruthy();
    const res = (await handler!({}, imported.id)) as { ok: boolean };
    expect(res.ok).toBe(true);

    expect(fav.listEntries().filter((e) => e.kind === 'file')).toHaveLength(0);
  });

  it('笔记移入回收站 → 该 id 的收藏条目消失', async () => {
    const fav = getFavoritesService();
    const created = await notes.create('n.md');
    await fav.toggle(created.id, { title: 'n.md', relPath: created.relPath });
    expect(fav.listEntries().filter((e) => e.kind === 'file')).toHaveLength(1);

    registerNotesIPC(notes);
    const handler = electronMock.handlers.get(IPC.NOTES_TRASH);
    expect(handler).toBeTruthy();
    const res = (await handler!({}, created.id)) as { ok: boolean };
    expect(res.ok).toBe(true);

    expect(fav.listEntries().filter((e) => e.kind === 'file')).toHaveLength(0);
  });

  it('删除没收藏的文件 → favorites.md 不动(别的收藏也不受影响)', async () => {
    const fav = getFavoritesService();
    // 另一条**别的**收藏
    const other = join(root, 'other.pdf');
    await fs.writeFile(other, 'PDF-BYTES', 'utf-8');
    const otherImp = await lit.importFile(other);
    await fav.toggle(otherImp.id, { title: 'other.pdf', relPath: otherImp.absPath });

    const src = join(root, 'paper.pdf');
    await fs.writeFile(src, 'PDF-BYTES', 'utf-8');
    const imported = await lit.importFile(src);
    // imported 没有被收藏
    const before = fav.listEntries().length;

    registerLiteratureIPC(lit);
    const handler = electronMock.handlers.get(IPC.LITERATURE_DELETE);
    const res = (await handler!({}, imported.id)) as { ok: boolean };
    expect(res.ok).toBe(true);

    expect(fav.listEntries().length).toBe(before);
    const files = fav.listEntries().filter((e) => e.kind === 'file');
    expect(files).toHaveLength(1);
    expect(files[0]?.fileId).toBe(otherImp.id);
  });

  it('同路径再导入 → 不继承旧 ★(toggle 是「加入收藏」而不是「取消收藏」)', async () => {
    const fav = getFavoritesService();
    const src = join(root, 'paper.pdf');
    await fs.writeFile(src, 'PDF-BYTES', 'utf-8');
    const first = await lit.importFile(src);
    await fav.toggle(first.id, { title: 'paper.pdf', relPath: first.absPath });

    registerLiteratureIPC(lit);
    const del = electronMock.handlers.get(IPC.LITERATURE_DELETE);
    expect((await del!({}, first.id)) as { ok: boolean }).toMatchObject({ ok: true });

    // 同一路径再导入 ⇒ id 相同(lit id = 'lit:'+posix absPath)
    const src2 = join(root, 'src2');
    await fs.mkdir(src2, { recursive: true });
    const src2File = join(src2, 'paper.pdf');
    await fs.writeFile(src2File, 'PDF-BYTES-2', 'utf-8');
    const second = await lit.importFile(src2File);
    expect(second.id).toBe(first.id);

    // 收藏条目已被清掉 ⇒ 再点 ★ 是「加入收藏」(true),不是「取消收藏」(false)
    const nowFavorited = await fav.toggle(second.id, {
      title: 'paper.pdf',
      relPath: second.absPath,
    });
    expect(nowFavorited).toBe(true);
  });
});
