// tests/unit/main/folder-dir-move.test.ts
//
// 守 r173「目录(子树)跨父目录搬移」契约 —— 侧栏「剪切文件夹 → 粘贴到
// 别的目录」「把文件夹拖到别的目录」「移到根目录」三条入口的落点。
//
// 用户报的「粘贴功能有问题」第 4 轮:文件夹维度全是死的 ——
//   - renderer 的 pasteFolderInto / moveFolderNow 是 throw「not yet
//     supported」的占位(UI 菜单项可见,点了必报错);
//   - 文件夹拖拽的 dataTransfer 载荷写 ids: [],而 readMovePayload 要求
//     ids 非空 → 载荷在读端被整条拒收,drop 端永远收不到。
//
// 本测在 service 层锁三件事:
//   1. 物理搬移真的发生(子树整体挪位,非 .md 文件也带走);
//   2. 子树里每个资源的 id 都重算(notes id 随 relPath、lit id 随
//      absPath)且 byId 换键 —— 否则「刚搬过去的笔记」打不开;
//   3. 返回 idRemap(oldId → newId + 新路径),renderer 靠它把选中态跟过去。
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

import { setRootPath } from '../../../src/main/utils/safe-write';
import { NotesService } from '../../../src/main/notes/service';
import { LiteratureService } from '../../../src/main/literature/literature-service';
import { computeFileId } from '../../../src/main/notes/path-mapping';

describe('目录(子树)跨父目录搬移(r173)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'rkms-dirmove-'));
    setRootPath(root);
    await fs.mkdir(join(root, 'notes'), { recursive: true });
    await fs.mkdir(join(root, 'literature'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  // === notes 域 ===
  describe('NotesService.moveDir', () => {
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
      // 先把笔记放进子目录 'sub'
      const inSub = await svc.moveFile(n.id, 'sub');
      expect(inSub.relPath).toBe('sub/a.md');
      const oldId = inSub.id;

      const moved = await svc.moveDir('sub', 'target');

      // 1) 物理搬移:整棵子树挪到 target/sub,原位置不留残影
      expect(moved.relPath).toBe('target/sub');
      await expect(fs.stat(join(root, 'notes', 'target', 'sub', 'a.md'))).resolves.toBeTruthy();
      await expect(fs.stat(join(root, 'notes', 'sub'))).rejects.toThrow();

      // 2) id 重钉:笔记 id = SHA-256(relPath) 前 16 位 → 路径变 id 必变
      expect(moved.idRemap.length).toBe(1);
      const remap = moved.idRemap[0]!;
      expect(remap.oldId).toBe(oldId);
      expect(remap.newId).not.toBe(oldId);
      expect(remap.newId).toBe(computeFileId('target/sub/a.md'));
      expect(remap.relPath).toBe('target/sub/a.md');

      // 3) byId 换键:旧 id 查不到,新 id 查得到
      expect(svc.findById(oldId)).toBeNull();
      expect(svc.findById(remap.newId)).not.toBeNull();
      expect(svc.findById(remap.newId)?.relPath).toBe('target/sub/a.md');

      // 4) 文件里的 frontmatter id 也跟着重钉(否则重开应用索引对不上)
      const raw = await fs.readFile(join(root, 'notes', 'target', 'sub', 'a.md'), 'utf-8');
      expect(raw).toContain(remap.newId);
    });

    it('搬到根(目标父目录 = 空串)', async () => {
      const n = await svc.create('a.md');
      await svc.moveFile(n.id, 'sub');

      const moved = await svc.moveDir('sub', '');

      expect(moved.relPath).toBe('sub');
      await expect(fs.stat(join(root, 'notes', 'sub', 'a.md'))).resolves.toBeTruthy();
    });

    it('搬进自己的子树被拒(自我嵌套)', async () => {
      const n = await svc.create('a.md');
      await svc.moveFile(n.id, 'sub');

      await expect(svc.moveDir('sub', 'sub')).rejects.toThrow();
      // 目录还在原处(未发生半截搬移)
      await expect(fs.stat(join(root, 'notes', 'sub', 'a.md'))).resolves.toBeTruthy();
    });
  });

  // === literature 域 ===
  describe('LiteratureService.moveDir', () => {
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

      const moved = await svc.moveDir('sub', 'target');

      expect(moved.relPath).toBe('target/sub');
      await expect(fs.stat(join(root, 'literature', 'target', 'sub', 'paper.pdf'))).resolves.toBeTruthy();
      await expect(fs.stat(join(root, 'literature', 'sub'))).rejects.toThrow();

      expect(moved.idRemap.length).toBe(1);
      const remap = moved.idRemap[0]!;
      expect(remap.oldId).toBe(oldId);
      expect(remap.newId).not.toBe(oldId);
      expect(remap.absPath).toContain('target/sub/paper.pdf');
      expect(remap.relPath).toBe('target/sub/paper.pdf');

      expect(svc.findById(oldId)).toBeNull();
      expect(svc.findById(remap.newId)).not.toBeNull();
    });

    it('搬进自己的子树被拒', async () => {
      const src = join(root, 'paper.pdf');
      await fs.writeFile(src, 'PDF-BYTES', 'utf-8');
      const imported = await svc.importFile(src);
      await svc.moveFile(imported.id, 'sub');

      await expect(svc.moveDir('sub', 'sub')).rejects.toThrow();
      await expect(fs.stat(join(root, 'literature', 'sub', 'paper.pdf'))).resolves.toBeTruthy();
    });
  });
});
