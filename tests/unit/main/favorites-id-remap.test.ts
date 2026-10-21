// tests/unit/main/favorites-id-remap.test.ts
//
// 守 r182「资源 id 变更后,收藏(★)必须跟着走」契约。
//
// 用户的收藏条目存在 favorites.md 里,主键是**资源 id**:
//   - literature id = 'lit:' + toPosix(absPath)  → 路径一变 id 就变;
//   - note       id = SHA-256(relPath) 前 16 位 → 路径一变 id 就变。
// 而 renderer 侧 ★ 的显示/过滤只看 id(favoritedFileIds Set)。
//
// 旧实现:改名 / 搬移 / 文件夹改名改完 id,**没人管 favorites.md** ——
// 收藏条目里留着旧 id,旧 id 再也不会命中任何一行 ⇒ 用户的 ★ 在操作成功的
// 瞬间静默消失(favorites.md 里那条记录变成永远点不亮的孤儿)。
//
// 本测锁:
//   1. 文献搬进文件夹(LITERATURE_MOVE)→ 收藏条目 fileId 跟着变;
//   2. 笔记改名(NOTES_RENAME_FILE)→ 收藏条目跟着变(notes 域 id 是裸 id);
//   3. 没有收藏指向该 id → 不动 favorites.md(不写盘、不空转);
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
  listStaleIndexIds: vi.fn(() => [] as string[]),
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

// electron 整体 mock:ipcMain.handle 捕获 handler(验「通道真的把 remap
// 串到 favorites 上」),shell.trashItem 让 safeTrash 在 node 环境可调
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

describe('id 变更后收藏(★)跟着走(r182)', () => {
  let root: string;
  let lit: LiteratureService;
  let notes: NotesService;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'rkms-favremap-'));
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
    await fs.rm(root, { recursive: true, force: true });
  });

  it('文献搬进文件夹 → 收藏条目的 fileId 跟着变(★ 不丢)', async () => {
    const fav = getFavoritesService();
    const src = join(root, 'paper.pdf');
    await fs.writeFile(src, 'PDF-BYTES', 'utf-8');
    const imported = await lit.importFile(src);
    // renderer 的 ★ toggle:fileId = 文献 id,relPath 存的是绝对路径
    await fav.toggle(imported.id, { title: 'paper.pdf', relPath: imported.absPath });

    registerLiteratureIPC(lit);
    const handler = electronMock.handlers.get(IPC.LITERATURE_MOVE);
    expect(handler).toBeTruthy();
    const res = (await handler!({}, imported.id, 'sub')) as {
      ok: boolean;
      data?: { absPath: string; id: string };
    };
    expect(res.ok).toBe(true);
    const newId = res.data!.id;
    expect(newId).not.toBe(imported.id);

    // 收藏条目:fileId 已经是新 id,展示路径也是新路径
    const entries = fav.listEntries().filter((e) => e.kind === 'file');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.fileId).toBe(newId);
    expect(entries[0]?.relPath).toContain('sub');
  });

  it('笔记改名 → 收藏条目跟着变(notes 域 id 是裸 id)', async () => {
    const fav = getFavoritesService();
    const created = await notes.create('n.md');
    await fav.toggle(created.id, { title: 'n.md', relPath: created.relPath });

    registerNotesIPC(notes);
    const handler = electronMock.handlers.get(IPC.NOTES_RENAME_FILE);
    expect(handler).toBeTruthy();
    const res = (await handler!({}, created.id, 'renamed.md')) as {
      ok: boolean;
      data?: { id: string; relPath: string };
    };
    expect(res.ok).toBe(true);
    const newId = res.data!.id;
    expect(newId).not.toBe(created.id);

    const entries = fav.listEntries().filter((e) => e.kind === 'file');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.fileId).toBe(newId);
    expect(entries[0]?.relPath).toBe('renamed.md');
  });

  it('没有收藏指向该 id → 不动 favorites.md(不空写盘)', async () => {
    const fav = getFavoritesService();
    const src = join(root, 'paper.pdf');
    await fs.writeFile(src, 'PDF-BYTES', 'utf-8');
    const imported = await lit.importFile(src);
    // 不 toggle —— 没有任何收藏指向这个 id
    const before = fav.listEntries().length;

    registerLiteratureIPC(lit);
    const handler = electronMock.handlers.get(IPC.LITERATURE_MOVE);
    const res = (await handler!({}, imported.id, 'sub')) as { ok: boolean };
    expect(res.ok).toBe(true);

    expect(fav.listEntries().length).toBe(before);
    expect(fav.listEntries().filter((e) => e.kind === 'file')).toHaveLength(0);
  });
});
