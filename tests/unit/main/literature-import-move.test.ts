// tests/unit/main/literature-import-move.test.ts
//
// 守 literature 域「导入 → 立刻搬进子目录」链路(r170)。
//
// 用户报「粘贴功能有问题」的文献侧根因:旧实现在 IPC handler 里直调
// importLiteratureFile + upsertResource,**没更新 LiteratureService.byId**
// —— 导入后紧跟的 svc.moveFile(id, target) 走 byId.get(id) 必 miss →
// NOT_FOUND。两条用户可见路径同时失效:
//   - 「复制 → 粘贴」进文件夹(store/literature.ts copy 分支)
//   - 「OS 拖文件进文件夹」(LiteratureList 拖放 handler)
//
// 本用例在 service 层锁契约:importFile 之后 byId 立即可见,moveFile 不再
// NOT_FOUND,且搬移后 id 变化(absPath 变 → 'lit:'+absPath 变)。
//
// 真库(electron app.getPath)在测试环境不可用 → resources-repo 整体 mock;
// 被测行为(文件拷贝 + byId 维护 + moveFile 的 fs.rename)全在 service 内。
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
import { LiteratureService } from '../../../src/main/literature/literature-service';

describe('LiteratureService 导入 → 搬进子目录(r170)', () => {
  let root: string;
  let svc: LiteratureService;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'rkms-lit-'));
    setRootPath(root);
    await fs.mkdir(join(root, 'literature'), { recursive: true });
    svc = new LiteratureService();
    // skipInitialLoad: 只关心 import → move 这条链,不引入 reload 的磁盘扫描
    await svc.start({ skipInitialLoad: true });
  });

  afterEach(async () => {
    await svc.stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('importFile 之后 byId 立即可见(旧实现只写 DB 行,byId 缺 → moveFile NOT_FOUND)', async () => {
    const src = join(root, 'paper.pdf');
    await fs.writeFile(src, 'PDF-BYTES', 'utf-8');
    const imported = await svc.importFile(src);
    // 内存索引已含新行 —— 搬移立刻能找到它
    expect(svc.findById(imported.id)).not.toBeNull();
    // DB 行也写了
    expect(repo.upsertResource).toHaveBeenCalled();
  });

  it('导入后立刻搬进子目录成功,id 随 absPath 变化', async () => {
    const src = join(root, 'paper.pdf');
    await fs.writeFile(src, 'PDF-BYTES', 'utf-8');
    const imported = await svc.importFile(src);
    const moved = await svc.moveFile(imported.id, 'sub');
    expect(moved.id).not.toBe(imported.id);
    expect(moved.absPath).toContain('sub');
    // 旧 id 已被换掉(内存索引与 DB 同步)
    expect(svc.findById(imported.id)).toBeNull();
    expect(svc.findById(moved.id)).not.toBeNull();
  });

  it('搬不存在的 id 仍抛 NOT_FOUND(契约不因本轮改动而松动)', async () => {
    const ghost = 'lit:no-such' as unknown as Parameters<LiteratureService['moveFile']>[0];
    await expect(svc.moveFile(ghost, 'sub')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
