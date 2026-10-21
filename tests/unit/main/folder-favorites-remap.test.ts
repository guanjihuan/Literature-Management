// tests/unit/main/folder-favorites-remap.test.ts
//
// 守 r189「文件夹(子树)改名 / 跨目录搬移后,收藏(★)必须跟着走」契约。
//
// r182 只接了**单文件**的改名 / 搬移(ipc/notes.ts、ipc/literature.ts),
// 文件夹层的接线被 r182 的提交说明显式推迟,一直没补 ⇒ 用户可复现的 bug:
//
//   1. ★ 一个文件夹里的文献;
//   2. 右键该文件夹 → 重命名(或剪切 → 粘贴到别的目录);
//   3. 文件夹在树上改名/搬走了,但**★ 静默消失** —— favorites.md 里还留着
//      旧 fileId,而 id 是按路径算出来的
//      (notes: fm.id = SHA-256(relPath) 前 16 位;
//       literature: 'lit:' + POSIX 绝对路径)
//      ⇒ 旧 id 再也不会命中任何一行,那条收藏变成永远点不亮的孤儿。
//
// 本测锁:
//   1. 文献文件夹改名 → 子树里被 ★ 的文献,收藏条目 fileId + 路径跟着走;
//   2. 文献文件夹跨目录搬移 → 同上;
//   3. 笔记文件夹改名 → 同上,且**路径形态按域**:
//      notes 存相对 notes 根的 relPath,literature 存绝对路径 —— 写错形态
//      ⇒ ★ 还在,但收藏面板里的路径指向不存在的文件;
//   4. 嵌套子树(夹里的夹里的文件)也一起跟着走;
//   5. 子树外/未收藏的文件 → 不动 favorites.md(不空写盘、不误改)。
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
import { registerFoldersIPC } from '../../../src/main/ipc/folders';
import { getFavoritesService } from '../../../src/main/workspace/favorites';
import { IPC } from '../../../src/shared/types';

interface IpcOk<T> {
  ok: boolean;
  data?: T;
}

interface FolderResult {
  relPath: string;
  idRemap: Array<{ oldId: string; newId: string; relPath?: string; absPath?: string }>;
}

describe('文件夹(子树)改名 / 搬移后收藏(★)跟着走(r189)', () => {
  let root: string;
  let lit: LiteratureService;
  let notes: NotesService;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'rkms-favfolder-'));
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

  /** 导入一个 pdf 到 literature 根,再搬进 <dir> —— 返回搬完后的 {id, absPath}。 */
  async function importPdfInto(dir: string, name: string): Promise<{ id: string; absPath: string }> {
    const src = join(root, name);
    await fs.writeFile(src, 'PDF-BYTES', 'utf-8');
    const imported = await lit.importFile(src);
    await fs.mkdir(join(root, 'literature', dir), { recursive: true });
    const moved = await lit.moveFile(imported.id, dir);
    return { id: moved.id, absPath: moved.absPath };
  }

  /** 建一个笔记并搬进 <dir> —— 返回搬完后的 {id, relPath}。 */
  async function createNoteIn(dir: string, name: string): Promise<{ id: string; relPath: string }> {
    const created = await notes.create(name);
    await fs.mkdir(join(root, 'notes', dir), { recursive: true });
    const moved = await notes.moveFile(created.id, dir);
    return { id: moved.id, relPath: moved.relPath };
  }

  function favFiles(): { fileId: string; relPath: string }[] {
    return getFavoritesService()
      .listEntries()
      .filter((e) => e.kind === 'file')
      .map((e) => ({ fileId: (e as { fileId: string }).fileId, relPath: e.relPath }));
  }

  it('文献文件夹改名 → 子树里被 ★ 的文献,收藏条目的 id 与路径都跟着走', async () => {
    const fav = getFavoritesService();
    const file = await importPdfInto('sub', 'paper.pdf');
    // renderer 的 ★ toggle:fileId = 文献 id,relPath 存的是**绝对路径**
    await fav.toggle(file.id, { title: 'paper.pdf', relPath: file.absPath });

    registerFoldersIPC(notes, lit);
    const handler = electronMock.handlers.get(IPC.LITERATURE_FOLDERS_RENAME_DIR);
    expect(handler).toBeTruthy();
    const res = (await handler!({}, 'sub', 'renamed')) as IpcOk<FolderResult>;
    expect(res.ok).toBe(true);
    expect(res.data!.relPath).toBe('renamed');
    expect(res.data!.idRemap).toHaveLength(1);
    const newId = res.data!.idRemap[0]!.newId;
    expect(newId).not.toBe(file.id);

    // 收藏条目:fileId 已是新 id,展示路径也是新路径(文献域 = 绝对路径)
    const entries = favFiles();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.fileId).toBe(newId);
    expect(entries[0]!.relPath).toContain('renamed');
    expect(entries[0]!.relPath).toBe(res.data!.idRemap[0]!.absPath);
  });

  it('文献文件夹跨目录搬移 → 收藏条目跟着走', async () => {
    const fav = getFavoritesService();
    const file = await importPdfInto('sub', 'paper.pdf');
    await fav.toggle(file.id, { title: 'paper.pdf', relPath: file.absPath });
    await fs.mkdir(join(root, 'literature', 'arch'), { recursive: true });

    registerFoldersIPC(notes, lit);
    const handler = electronMock.handlers.get(IPC.LITERATURE_FOLDERS_MOVE_DIR);
    expect(handler).toBeTruthy();
    const res = (await handler!({}, 'sub', 'arch')) as IpcOk<FolderResult>;
    expect(res.ok).toBe(true);
    expect(res.data!.relPath).toBe('arch/sub');
    const newId = res.data!.idRemap[0]!.newId;
    expect(newId).not.toBe(file.id);

    const entries = favFiles();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.fileId).toBe(newId);
    expect(entries[0]!.relPath).toContain('arch');
  });

  it('笔记文件夹改名 → 收藏条目跟着走,且路径形态是 relPath(不是绝对路径)', async () => {
    const fav = getFavoritesService();
    const note = await createNoteIn('sub', 'n.md');
    expect(note.relPath).toBe('sub/n.md');
    // notes 域 toggle 存的是相对 notes 根的 relPath
    await fav.toggle(note.id, { title: 'n.md', relPath: note.relPath });

    registerFoldersIPC(notes, lit);
    const handler = electronMock.handlers.get(IPC.NOTES_FOLDERS_RENAME_DIR);
    expect(handler).toBeTruthy();
    const res = (await handler!({}, 'sub', 'renamed')) as IpcOk<FolderResult>;
    expect(res.ok).toBe(true);
    expect(res.data!.relPath).toBe('renamed');
    const newId = res.data!.idRemap[0]!.newId;
    expect(newId).not.toBe(note.id);

    const entries = favFiles();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.fileId).toBe(newId);
    // 关键:notes 域的展示路径必须是 relPath —— 写绝对路径会让收藏面板
    // 指向一个与用户心智(相对 notes 根)不一致的字符串
    expect(entries[0]!.relPath).toBe('renamed/n.md');
  });

  it('笔记文件夹跨目录搬移 → 收藏条目跟着走', async () => {
    const fav = getFavoritesService();
    const note = await createNoteIn('sub', 'n.md');
    await fav.toggle(note.id, { title: 'n.md', relPath: note.relPath });
    await fs.mkdir(join(root, 'notes', 'arch'), { recursive: true });

    registerFoldersIPC(notes, lit);
    const handler = electronMock.handlers.get(IPC.NOTES_FOLDERS_MOVE_DIR);
    expect(handler).toBeTruthy();
    const res = (await handler!({}, 'sub', 'arch')) as IpcOk<FolderResult>;
    expect(res.ok).toBe(true);
    expect(res.data!.relPath).toBe('arch/sub');
    const newId = res.data!.idRemap[0]!.newId;

    const entries = favFiles();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.fileId).toBe(newId);
    expect(entries[0]!.relPath).toBe('arch/sub/n.md');
  });

  it('嵌套子树(夹里的夹里的文件)也一起跟着走', async () => {
    const fav = getFavoritesService();
    const file = await importPdfInto('sub/deep', 'paper.pdf');
    await fav.toggle(file.id, { title: 'paper.pdf', relPath: file.absPath });

    registerFoldersIPC(notes, lit);
    const handler = electronMock.handlers.get(IPC.LITERATURE_FOLDERS_RENAME_DIR);
    const res = (await handler!({}, 'sub', 'renamed')) as IpcOk<FolderResult>;
    expect(res.ok).toBe(true);
    expect(res.data!.idRemap).toHaveLength(1);

    const entries = favFiles();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.fileId).toBe(res.data!.idRemap[0]!.newId);
    expect(entries[0]!.relPath).toContain('renamed');
  });

  it('子树里没有收藏 → 不动 favorites.md(不空写盘、不误改别的收藏)', async () => {
    const fav = getFavoritesService();
    // 一个**在子树外**的文献被收藏
    const outside = await importPdfInto('other', 'outside.pdf');
    await fav.toggle(outside.id, { title: 'outside.pdf', relPath: outside.absPath });
    // 子树里的文献**不**收藏
    await importPdfInto('sub', 'paper.pdf');

    const before = favFiles();
    expect(before).toHaveLength(1);

    registerFoldersIPC(notes, lit);
    const handler = electronMock.handlers.get(IPC.LITERATURE_FOLDERS_RENAME_DIR);
    const res = (await handler!({}, 'sub', 'renamed')) as IpcOk<FolderResult>;
    expect(res.ok).toBe(true);

    // 子树外的收藏条目:id 与路径都**不能**被改
    const after = favFiles();
    expect(after).toHaveLength(1);
    expect(after[0]!.fileId).toBe(outside.id);
    expect(after[0]!.relPath).toBe(outside.absPath);
  });
});
