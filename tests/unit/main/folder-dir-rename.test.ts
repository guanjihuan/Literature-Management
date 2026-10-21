// tests/unit/main/folder-dir-rename.test.ts
//
// 守 r175「应用内重命名文件夹」契约 —— 重命名后子树里每个资源的 id
// 必须跟着变,否则用户会丢数据。
//
// 旧实现(src/main/ipc/folders.ts 的 rename-dir handler)只有
// 「同级重名检测 + await fs.rename(oldAbs, newAbs)」:
//   - **不重钉** 子树里每个笔记的 frontmatter id;
//   - **不更新** DB 的 rel_path / absPath;
//   - **不换** byId 的键;
//   - **不返回** idRemap(旧契约只返 { relPath })。
//
// 笔记 id 与路径强绑定(fm.id = SHA-256(relPath) 前 16 位)⇒ 重命名目录
// 后 id 全变。旧实现下:文件里的 fm.id 还是旧路径的哈希,下一次 writeNote
// 无条件重烧 `id: computeFileId(relPath)` ⇒ id 突变 ⇒ renderer 手里的
// id 变**死 id** ⇒ 之后每次保存都 NOT_FOUND,用户新敲的字困在死 id
// 草稿里(重启即丢)—— 真实数据丢失路径。
//
// 本测锁四件事:
//   1. 物理搬移真的发生(子树整体挪位);
//   2. 子树里每个资源的 id 都重算(notes id 随 relPath、lit id 随
//      absPath),文件里的 frontmatter id 也被重钉;
//   3. byId 换键 + DB 行跟着改(old id 查不到 / new id 查得到);
//   4. 返回 idRemap(oldId → newId + 新路径),renderer 靠它把选中态跟过去;
//      且 IPC 通道真的把 idRemap 交出去(旧契约只返 { relPath })。
//
// 真库(electron app.getPath)在测试环境不可用 → resources-repo 整体 mock;
// 被测行为(fs.rename + frontmatter 重钉 + byId 维护)全在 service 内。
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

// electron 需整体 mock:ipcMain.handle 用来捕获 IPC handler(验「通道真的
// 把 idRemap 交出去」),shell.trashItem 让 safeTrash 在 node 环境可调。
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
import { NotesService } from '../../../src/main/notes/service';
import { LiteratureService } from '../../../src/main/literature/literature-service';
import { registerFoldersIPC } from '../../../src/main/ipc/folders';
import { computeFileId } from '../../../src/main/notes/path-mapping';
import { IPC } from '../../../src/shared/types';

describe('应用内重命名文件夹(r175)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'rkms-dirrename-'));
    setRootPath(root);
    await fs.mkdir(join(root, 'notes'), { recursive: true });
    await fs.mkdir(join(root, 'literature'), { recursive: true });
    electronMock.handlers.clear();
    repo.renameResource.mockClear();
    repo.upsertResource.mockClear();
    repo.deleteResource.mockClear();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  // === notes 域 ===
  describe('NotesService.renameDir', () => {
    let svc: NotesService;

    beforeEach(async () => {
      svc = new NotesService();
      await svc.start({ skipInitialLoad: true });
    });

    afterEach(async () => {
      await svc.stop();
    });

    it('子树整体挪位 + 每个笔记 id 重钉 + byId 换键 + 返回 idRemap', async () => {
      const n = await svc.create('a.md');
      const inSub = await svc.moveFile(n.id, 'sub');
      expect(inSub.relPath).toBe('sub/a.md');
      const oldId = inSub.id;

      const renamed = await svc.renameDir('sub', 'renamed');

      // 1) 物理搬移
      expect(renamed.relPath).toBe('renamed');
      await expect(fs.stat(join(root, 'notes', 'renamed', 'a.md'))).resolves.toBeTruthy();
      await expect(fs.stat(join(root, 'notes', 'sub'))).rejects.toThrow();

      // 2) id 重钉:笔记 id = SHA-256(relPath) 前 16 位 → 路径变 id 必变
      expect(renamed.idRemap.length).toBe(1);
      const remap = renamed.idRemap[0]!;
      expect(remap.oldId).toBe(oldId);
      expect(remap.newId).not.toBe(oldId);
      expect(remap.newId).toBe(computeFileId('renamed/a.md'));
      expect(remap.relPath).toBe('renamed/a.md');

      // 3) byId 换键:旧 id 查不到,新 id 查得到
      expect(svc.findById(oldId)).toBeNull();
      expect(svc.findById(remap.newId)).not.toBeNull();
      expect(svc.findById(remap.newId)?.relPath).toBe('renamed/a.md');

      // 4) 文件里的 frontmatter id 也被重钉 —— 否则下次写盘 id 突变,
      //    renderer 手里的 id 变死 id,之后每次保存都 NOT_FOUND
      const raw = await fs.readFile(join(root, 'notes', 'renamed', 'a.md'), 'utf-8');
      expect(raw).toContain(remap.newId);
      expect(raw).not.toContain(oldId);

      // 5) DB 的 rel_path 跟着改(最后一次 renameResource = 改名后的行)
      expect(repo.renameResource).toHaveBeenCalled();
      const lastCall = repo.renameResource.mock.calls.at(-1)!;
      expect(lastCall[1].relPath).toBe('renamed/a.md');
      expect(lastCall[3]).toContain('renamed');
    });

    it('嵌套目录改名保留目录内层级(a/b/n.md → c/n.md)', async () => {
      const n = await svc.create('n.md');
      const deep = await svc.moveFile(n.id, 'a/b');
      expect(deep.relPath).toBe('a/b/n.md');

      const renamed = await svc.renameDir('a/b', 'c');

      expect(renamed.relPath).toBe('c');
      await expect(fs.stat(join(root, 'notes', 'c', 'n.md'))).resolves.toBeTruthy();
      expect(renamed.idRemap[0]?.relPath).toBe('c/n.md');
      expect(renamed.idRemap[0]?.newId).toBe(computeFileId('c/n.md'));
    });

    it('目标已存在 → 拒绝,源目录内容完好(不丢数据)', async () => {
      const a = await svc.create('a.md');
      await svc.moveFile(a.id, 'x');
      const b = await svc.create('b.md');
      await svc.moveFile(b.id, 'y');

      await expect(svc.renameDir('x', 'y')).rejects.toThrow();

      // 源目录与它的笔记都还在(没发生半截搬移)
      await expect(fs.stat(join(root, 'notes', 'x', 'a.md'))).resolves.toBeTruthy();
      await expect(fs.stat(join(root, 'notes', 'y', 'b.md'))).resolves.toBeTruthy();
    });

    it('同名 → no-op,idRemap 为空', async () => {
      const n = await svc.create('a.md');
      await svc.moveFile(n.id, 'sub');

      const renamed = await svc.renameDir('sub', 'sub');

      expect(renamed.relPath).toBe('sub');
      expect(renamed.idRemap).toEqual([]);
      await expect(fs.stat(join(root, 'notes', 'sub', 'a.md'))).resolves.toBeTruthy();
    });
  });

  // === literature 域 ===
  describe('LiteratureService.renameDir', () => {
    let svc: LiteratureService;

    beforeEach(async () => {
      svc = new LiteratureService();
      await svc.start({ skipInitialLoad: true });
    });

    afterEach(async () => {
      await svc.stop();
    });

    it('子树整体挪位 + 文献 id 随 absPath 变 + byId 换键 + 返回 idRemap', async () => {
      const src = join(root, 'paper.pdf');
      await fs.writeFile(src, 'PDF-BYTES', 'utf-8');
      const imported = await svc.importFile(src);
      const inSub = await svc.moveFile(imported.id, 'sub');
      const oldId = inSub.id;

      const renamed = await svc.renameDir('sub', 'renamed');

      expect(renamed.relPath).toBe('renamed');
      await expect(
        fs.stat(join(root, 'literature', 'renamed', 'paper.pdf')),
      ).resolves.toBeTruthy();
      await expect(fs.stat(join(root, 'literature', 'sub'))).rejects.toThrow();

      expect(renamed.idRemap.length).toBe(1);
      const remap = renamed.idRemap[0]!;
      expect(remap.oldId).toBe(oldId);
      expect(remap.newId).not.toBe(oldId);
      expect(remap.absPath).toContain('renamed/paper.pdf');
      expect(remap.relPath).toBe('renamed/paper.pdf');

      expect(svc.findById(oldId)).toBeNull();
      expect(svc.findById(remap.newId)).not.toBeNull();
    });

    it('目标已存在 → 拒绝,源文件完好', async () => {
      const src = join(root, 'paper.pdf');
      await fs.writeFile(src, 'PDF-BYTES', 'utf-8');
      const imported = await svc.importFile(src);
      await svc.moveFile(imported.id, 'x');
      await fs.mkdir(join(root, 'literature', 'y'), { recursive: true });

      await expect(svc.renameDir('x', 'y')).rejects.toThrow();
      await expect(
        fs.stat(join(root, 'literature', 'x', 'paper.pdf')),
      ).resolves.toBeTruthy();
    });
  });

  // === IPC 通道契约 ===
  // 旧契约只返 { relPath } —— id 变化对 renderer 完全不可见 ⇒ 选中态
  // 永远钉在死 id 上。这里锁「通道必须把 idRemap 交出去」。
  describe('rename-dir IPC', () => {
    it('NOTES_FOLDERS_RENAME_DIR 返回 idRemap', async () => {
      const notes = new NotesService();
      const lit = new LiteratureService();
      await notes.start({ skipInitialLoad: true });
      await lit.start({ skipInitialLoad: true });
      try {
        registerFoldersIPC(notes, lit);
        const n = await notes.create('a.md');
        const inSub = await notes.moveFile(n.id, 'sub');
        const oldId = inSub.id;

        const handler = electronMock.handlers.get(IPC.NOTES_FOLDERS_RENAME_DIR);
        expect(handler).toBeTruthy();
        const res = (await handler!({}, 'sub', 'renamed')) as {
          ok: boolean;
          data?: { relPath: string; idRemap: Array<{ oldId: string; newId: string }> };
        };

        expect(res.ok).toBe(true);
        expect(res.data?.relPath).toBe('renamed');
        expect(res.data?.idRemap.length).toBe(1);
        expect(res.data?.idRemap[0]?.oldId).toBe(oldId);
        expect(res.data?.idRemap[0]?.newId).toBe(computeFileId('renamed/a.md'));
      } finally {
        await notes.stop();
        await lit.stop();
      }
    });

    it('LITERATURE_FOLDERS_RENAME_DIR 返回 idRemap', async () => {
      const notes = new NotesService();
      const lit = new LiteratureService();
      await notes.start({ skipInitialLoad: true });
      await lit.start({ skipInitialLoad: true });
      try {
        registerFoldersIPC(notes, lit);
        const src = join(root, 'paper.pdf');
        await fs.writeFile(src, 'PDF-BYTES', 'utf-8');
        const imported = await lit.importFile(src);
        const inSub = await lit.moveFile(imported.id, 'sub');
        const oldId = inSub.id;

        const handler = electronMock.handlers.get(IPC.LITERATURE_FOLDERS_RENAME_DIR);
        expect(handler).toBeTruthy();
        const res = (await handler!({}, 'sub', 'renamed')) as {
          ok: boolean;
          data?: { relPath: string; idRemap: Array<{ oldId: string; newId: string }> };
        };

        expect(res.ok).toBe(true);
        expect(res.data?.relPath).toBe('renamed');
        expect(res.data?.idRemap.length).toBe(1);
        expect(res.data?.idRemap[0]?.oldId).toBe(oldId);
      } finally {
        await notes.stop();
        await lit.stop();
      }
    });
  });
});
