// tests/unit/main/folder-scoped-file-ops.test.ts
//
// 守 r175「文件操作必须作用在对应的那一项、且不丢数据」契约。
//
// 背景:用户诉求 =「左侧的文献和笔记列表应该和对应的文件夹中完全一致,
//   相关的文件操作也是对应的,不要有错误,或者造成数据丢失」。
//   本测锁 5 条会在「子目录里操作」时破掉的规则:
//
//   1. 重命名笔记**保留所在目录** —— 旧实现把整条 relPath 换成新文件名,
//      'sub/a.md' 重命名成 'b.md' 会把文件搬到 notes 根(当前文件夹视图
//      里那条笔记凭空消失 = 列表与文件夹不一致)。
//   2. 文献删除走**系统回收站** —— 旧实现是 fs.unlink 硬删(不可恢复),
//      与笔记域(回收站)语义相反;文献往往就是用户手里唯一一份 PDF。
//   3. 搬移**不覆盖**目标目录里已有的同名文件 —— 旧实现靠「fs.rename 会
//      抛 EEXIST」拦,但文件级 rename 在 Windows/POSIX 上都**静默替换**
//      (MoveFileExW + MOVEFILE_REPLACE_EXISTING / rename(2)),
//      后果是目标文件被静默销毁 = 数据丢失。
//   4. 导入路径用正斜杠也能过 —— 旧 realpath 守卫在 Windows 上恒误判
//      (realpathSync 返反斜杠),导致「被搬动过的文献再也复制粘贴不了」。
//   5. 搬移不改文件 mtime —— 旧实现写 Date.now(),把「2 小时前」改成
//      「刚刚」,并让列表顺序突变。
//
// 真库(electron app.getPath)在测试环境不可用 → resources-repo 整体 mock;
// electron shell 单独 mock:trashItem 把文件**移进一个临时回收站目录**
// (这样测试能证明「文件还在、只是换了位置」= 可恢复,而硬删会丢)。
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

// electron shell.trashItem:真实现是把文件挪进回收站 —— 测试里挪进一个
// 临时目录,便于断言「文件内容仍在 = 可恢复」。
const electronMock = vi.hoisted(() => {
  const state = { trashDir: '' };
  return {
    state,
    shell: {
      trashItem: async (target: string): Promise<void> => {
        const { rename } = await import('fs/promises');
        const { basename, join: j } = await import('path');
        await rename(target, j(state.trashDir, basename(target)));
      },
    },
  };
});

vi.mock('electron', () => ({ shell: electronMock.shell }));

import { setRootPath } from '../../../src/main/utils/safe-write';
import { NotesService } from '../../../src/main/notes/service';
import { LiteratureService } from '../../../src/main/literature/literature-service';
import {
  importLiteratureFile,
  removeLiteratureFile,
} from '../../../src/main/literature/import';

describe('文件操作的作用域与不丢数据(r175)', () => {
  let root: string;
  let trashDir: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'rkms-folderscope-'));
    trashDir = await fs.mkdtemp(join(tmpdir(), 'rkms-trash-'));
    electronMock.state.trashDir = trashDir;
    setRootPath(root);
    await fs.mkdir(join(root, 'notes'), { recursive: true });
    await fs.mkdir(join(root, 'literature'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(trashDir, { recursive: true, force: true });
  });

  // === 1. 重命名保留目录 ===
  describe('NotesService.renameFile —— 重命名不搬家', () => {
    let svc: NotesService;

    beforeEach(async () => {
      svc = new NotesService();
      await svc.start({ skipInitialLoad: true });
    });

    afterEach(async () => {
      await svc.stop();
    });

    it('子目录里的笔记重命名后仍在该子目录(旧实现把它搬到 notes 根)', async () => {
      const n = await svc.create('a.md');
      const inSub = await svc.moveFile(n.id, 'sub');
      expect(inSub.relPath).toBe('sub/a.md');

      const renamed = await svc.renameFile(inSub.id, 'b.md');

      // 目录不变,只换文件名
      expect(renamed.relPath).toBe('sub/b.md');
      await expect(fs.stat(join(root, 'notes', 'sub', 'b.md'))).resolves.toBeTruthy();
      // 旧文件没了
      await expect(fs.stat(join(root, 'notes', 'sub', 'a.md'))).rejects.toThrow();
      // ★ 关键:没有偷偷搬到 notes 根
      await expect(fs.stat(join(root, 'notes', 'b.md'))).rejects.toThrow();
    });

    it('子目录里的仅大小写重命名可用(旧实现在根目录才走 case-only 分支)', async () => {
      const n = await svc.create('a.md');
      const inSub = await svc.moveFile(n.id, 'sub');

      const renamed = await svc.renameFile(inSub.id, 'A.md');

      expect(renamed.relPath).toBe('sub/A.md');
      await expect(fs.stat(join(root, 'notes', 'sub', 'A.md'))).resolves.toBeTruthy();
    });

    it('重命名到与同目录既有笔记同名 → 报错且两个文件都在(不覆盖)', async () => {
      const a = await svc.create('a.md');
      const b = await svc.create('b.md');
      await svc.moveFile(a.id, 'sub');
      const bInSub = await svc.moveFile(b.id, 'sub');

      await expect(svc.renameFile(bInSub.id, 'a.md')).rejects.toMatchObject({
        code: 'DUPLICATE_NAME',
      });
      // 两个文件都还在,内容没被动过
      await expect(fs.stat(join(root, 'notes', 'sub', 'a.md'))).resolves.toBeTruthy();
      await expect(fs.stat(join(root, 'notes', 'sub', 'b.md'))).resolves.toBeTruthy();
    });
  });

  // === 3. 搬移不覆盖(notes) ===
  it('把笔记搬进已有同名文件的目录 → 报错,目标文件内容与源文件都不丢', async () => {
    const svc = new NotesService();
    await svc.start({ skipInitialLoad: true });
    try {
      const a = await svc.create('a.md');
      await fs.mkdir(join(root, 'notes', 'sub'), { recursive: true });
      await fs.writeFile(join(root, 'notes', 'sub', 'a.md'), 'PRECIOUS', 'utf-8');

      await expect(svc.moveFile(a.id, 'sub')).rejects.toMatchObject({
        code: 'DUPLICATE_NAME',
      });

      // 目标文件内容没被覆盖
      expect(await fs.readFile(join(root, 'notes', 'sub', 'a.md'), 'utf-8')).toBe('PRECIOUS');
      // 源文件也还在(没被 rename 走)
      await expect(fs.stat(join(root, 'notes', 'a.md'))).resolves.toBeTruthy();
    } finally {
      await svc.stop();
    }
  });

  // === 2 + 3 + 5(literature) ===
  describe('LiteratureService', () => {
    let svc: LiteratureService;

    beforeEach(async () => {
      svc = new LiteratureService();
      await svc.start({ skipInitialLoad: true });
    });

    afterEach(async () => {
      await svc.stop();
    });

    it('删除文献走回收站(文件可恢复),不是硬删', async () => {
      const target = join(root, 'literature', 'paper.pdf');
      await fs.writeFile(target, 'PDF-BYTES', 'utf-8');

      const removed = await removeLiteratureFile(target, root);
      expect(removed).toBe(true);

      // 原位置没了
      await expect(fs.stat(target)).rejects.toThrow();
      // ★ 但内容还在回收站里 —— 硬删会在这里丢
      const trashed = await fs.readFile(join(trashDir, 'paper.pdf'), 'utf-8');
      expect(trashed).toBe('PDF-BYTES');
    });

    it('删除文献(走 service.remove)同样可恢复', async () => {
      const src = join(root, 'paper.pdf');
      await fs.writeFile(src, 'PDF-BYTES', 'utf-8');
      const imported = await svc.importFile(src);

      await svc.remove(imported.id);

      await expect(fs.stat(join(root, 'literature', 'paper.pdf'))).rejects.toThrow();
      const trashed = await fs.readFile(join(trashDir, 'paper.pdf'), 'utf-8');
      expect(trashed).toBe('PDF-BYTES');
    });

    it('搬移不覆盖目标目录里已有的同名文件(旧实现静默销毁目标)', async () => {
      const src = join(root, 'x.pdf');
      await fs.writeFile(src, 'SOURCE', 'utf-8');
      const imported = await svc.importFile(src);
      await fs.mkdir(join(root, 'literature', 'A'), { recursive: true });
      await fs.writeFile(join(root, 'literature', 'A', 'x.pdf'), 'PRECIOUS', 'utf-8');

      await expect(svc.moveFile(imported.id, 'A')).rejects.toMatchObject({
        code: 'VALIDATION',
      });

      // 目标文件没被覆盖
      expect(await fs.readFile(join(root, 'literature', 'A', 'x.pdf'), 'utf-8')).toBe('PRECIOUS');
      // 源文件也还在
      await expect(fs.stat(join(root, 'literature', 'x.pdf'))).resolves.toBeTruthy();
    });

    it('搬移不改 mtime(旧实现写 Date.now(),把「2 小时前」改成「刚刚」)', async () => {
      const src = join(root, 'y.pdf');
      await fs.writeFile(src, 'BYTES', 'utf-8');
      const imported = await svc.importFile(src);
      const before = svc.findById(imported.id)!.mtime;

      const moved = await svc.moveFile(imported.id, 'sub');

      expect(svc.findById(moved.id)!.mtime).toBe(before);
    });
  });

  // === 4. 导入路径形态(正斜杠)不再被误杀 ===
  it('导入路径用正斜杠也能过(realpath 守卫旧实现恒误判 → 搬移过的文献复制粘贴全废)', async () => {
    const src = join(root, 'native.txt');
    await fs.writeFile(src, 'X', 'utf-8');
    const posixPath = src.split('\\').join('/');

    const imported = await importLiteratureFile(posixPath, root);

    expect(imported.absPath).toContain('native.txt');
    // 内容真的拷进来了
    expect(await fs.readFile(imported.absPath, 'utf-8')).toBe('X');
  });
});
