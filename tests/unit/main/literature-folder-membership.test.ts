// tests/unit/main/literature-folder-membership.test.ts
//
// 守 literature 域的「文件夹归属」(r172)。
//
// 用户报「粘贴功能有问题」的文献侧第三层根因:文献行**没有 relPath**。
// renderer 的 visibleItemRows 按 dirname(relPath) 分组(根 = ''),没有 relPath
// ⇒ dirname 恒为 '' ⇒ 文献行永远只在根视图可见,子目录视图恒空。
// 于是「复制/粘贴进文件夹」「OS 拖进文件夹」文件确实搬到子目录了,列表却
// 还显示在根 —— 用户视角就是「粘贴没生效」。
//
// 旧代码的注释写着「Phase 1 临时把 absPath 当 relPath 走」,但**只做了
// type cast,没有任何映射** —— 注释是假的,行为是坏的。本用例锁住真实行为:
//   1. 导入到根 → relPath = 文件名
//   2. 搬进子目录 → relPath = 'sub/x.pdf'(且 id 随 absPath 变)
//   3. 直接丢在磁盘子目录里的文件(不经 UI)→ reload 后也能被发现并带上
//      正确的 relPath(递归扫描,旧实现只看顶层)
//   4. 越界文件(不在 literature 子树内)→ relPath = '' 归到根视图
//
// 真库(electron app.getPath)在测试环境不可用 → resources-repo 整体 mock;
// 被测行为(relPath 计算 + 递归扫描 + byId 维护)全在 service 内。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const repo = vi.hoisted(() => ({
  upsertResource: vi.fn(),
  deleteResource: vi.fn(),
  // r196:文献 id 换行走**单事务** renameResource(upsert 新行 + 删旧行),
  //   不再是 delete + upsert 两个独立事务 —— 见 literature-rename.test.ts。
  renameResource: vi.fn(),
  listResources: vi.fn(() => [] as unknown[]),
}));

vi.mock('../../../src/main/db/resources-repo', () => ({
  upsertResource: repo.upsertResource,
  deleteResource: repo.deleteResource,
  renameResource: repo.renameResource,
  listResources: repo.listResources,
}));

import { setRootPath } from '../../../src/main/utils/safe-write';
import { LiteratureService, litRelPathOf } from '../../../src/main/literature/literature-service';

describe('LiteratureService 文件夹归属(relPath,r172)', () => {
  let root: string;
  let litDir: string;
  let svc: LiteratureService;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'rkms-lit-rel-'));
    setRootPath(root);
    litDir = join(root, 'literature');
    await fs.mkdir(litDir, { recursive: true });
    svc = new LiteratureService();
    await svc.start({ skipInitialLoad: true });
  });

  afterEach(async () => {
    await svc.stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('导入到根 → relPath = 文件名(根视图)', async () => {
    const src = join(root, 'paper.pdf');
    await fs.writeFile(src, 'PDF-BYTES', 'utf-8');
    const imported = await svc.importFile(src);
    const row = svc.findById(imported.id);
    expect(row?.relPath).toBe('paper.pdf');
  });

  it('搬进子目录 → relPath 变成 sub/x.pdf(旧实现没有 relPath,列表永远在根)', async () => {
    const src = join(root, 'paper.pdf');
    await fs.writeFile(src, 'PDF-BYTES', 'utf-8');
    const imported = await svc.importFile(src);
    const moved = await svc.moveFile(imported.id, 'sub');
    const row = svc.findById(moved.id);
    expect(row?.relPath).toBe('sub/paper.pdf');
    expect(moved.id).not.toBe(imported.id);
  });

  it('直接丢在磁盘子目录里的文件 → reload 后被发现并带正确 relPath', async () => {
    await fs.mkdir(join(litDir, 'sub', 'deep'), { recursive: true });
    await fs.writeFile(join(litDir, 'sub', 'deep', 'manual.pdf'), 'PDF', 'utf-8');
    await svc.load();
    const rows = svc.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.relPath).toBe('sub/deep/manual.pdf');
  });

  it('reload 仍能扫到根目录的文件(递归改造没把顶层漏掉)', async () => {
    await fs.writeFile(join(litDir, 'top.pdf'), 'PDF', 'utf-8');
    await svc.load();
    const rows = svc.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.relPath).toBe('top.pdf');
  });

  it('litRelPathOf:越界路径(不在 literature 子树内)→ 空串归根', () => {
    expect(litRelPathOf(litDir, join(litDir, 'sub', 'x.pdf'))).toBe('sub/x.pdf');
    expect(litRelPathOf(litDir, join(root, 'elsewhere', 'x.pdf'))).toBe('');
    expect(litRelPathOf(litDir, litDir)).toBe('');
  });
});
