// tests/unit/main/literature-db-failure-selfheal.test.ts
//
// 行为锁(audit-r243,2026-10-21):**DB 写失败时不得留下「盘上有、库里没有」
// 的半成品**,且**必须显式触发一次自愈 reload**。
//
// ── 缺陷 1:导入后 DB 写失败 ⇒ 孤儿文件 ──────────────────────────────
//   LiteratureService.importFile 的拷贝(importLiteratureFile)在 writeLock
//   **之外**先落盘,DB 行在锁内写。DB 写失败(SQLITE_BUSY / 磁盘满)⇒
//   抛错给用户,但那份**已经拷进 literature/ 的文件**留在盘上:既没有
//   resources 行、也没有 byId 条目 ⇒ 用户重试一次就多出「name (1).ext」,
//   列表里堆一堆「导入了但搜不到、也不在收藏里」的孤儿文件。
//   修法:DB 写失败 ⇒ 删掉刚拷出来的那份(回滚到「没导过」),错误照抛。
//
// ── 缺陷 2:目录搬移/改名后 DB 失败 ⇒ 没人自愈 ──────────────────────
//   moveDir / renameDir 的注释都写着「失败 throw 且 byId 保持原状,
//   chokidar 事件触发的 reload 自愈」—— 但**那个事件不会来**:
//   目录搬移走 withWatcherReleased(Windows 上 chokidar 持目录句柄 ⇒
//   改名必 EPERM),watcher 在 fs.rename 期间是关着的,重启又带
//   ignoreInitial: true ⇒ 搬移产生的 unlink / add 事件一个都收不到。
//   ⇒ DB 中途失败时:磁盘已搬到新位置,DB 里一半行还是旧 absPath/id,
//     byId 也停在旧键 —— 三态漂移且**没有自愈触发器**。
//   修法:失败时**显式**排一次 reload(按磁盘真值重建 byId + disk↔DB 差集)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const repo = vi.hoisted(() => ({
  upsertResource: vi.fn(),
  deleteResource: vi.fn(),
  renameResource: vi.fn(),
  listResources: vi.fn(() => [] as unknown[]),
  listResourceRelPaths: vi.fn(() => [] as string[]),
}));

vi.mock('../../../src/main/db/resources-repo', () => ({
  upsertResource: repo.upsertResource,
  deleteResource: repo.deleteResource,
  renameResource: repo.renameResource,
  listResources: repo.listResources,
  listResourceRelPaths: repo.listResourceRelPaths,
}));

import { setRootPath } from '../../../src/main/utils/safe-write';
import { LiteratureService } from '../../../src/main/literature/literature-service';

describe('literature DB 失败的自愈(audit-r243)', () => {
  let root: string;
  let svc: LiteratureService;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'rkms-litdb-'));
    setRootPath(root);
    await fs.mkdir(join(root, 'literature'), { recursive: true });
    repo.upsertResource.mockReset();
    repo.renameResource.mockReset();
    svc = new LiteratureService();
  });

  afterEach(async () => {
    await svc.stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('导入后 DB 写失败 ⇒ 刚拷进来的文件被回收(不留孤儿)', async () => {
    await svc.start({ skipInitialLoad: true });
    const src = join(root, 'paper.pdf');
    await fs.writeFile(src, 'PDF-BYTES', 'utf-8');
    repo.upsertResource.mockImplementationOnce(() => {
      throw new Error('SQLITE_BUSY: database is locked');
    });

    await expect(svc.importFile(src)).rejects.toThrow();

    const left = await fs.readdir(join(root, 'literature'));
    expect(left, `literature/ 里留下孤儿文件:${left.join(', ')}`).toEqual([]);
    // 源文件当然不能被动
    expect((await fs.stat(src)).isFile()).toBe(true);
  });

  it('目录搬移后 DB 失败 ⇒ 显式排一次 reload(chokidar 事件被 watcher 释放吞掉了)', async () => {
    await fs.mkdir(join(root, 'literature', 'sub'), { recursive: true });
    await fs.writeFile(join(root, 'literature', 'sub', 'p.pdf'), 'PDF-BYTES', 'utf-8');
    await svc.start(); // 不 skipInitialLoad:需要 byId 里有子树行
    expect(svc.list().length).toBeGreaterThan(0);

    const reloadSpy = vi.spyOn(
      svc as unknown as { scheduleReload: () => void },
      'scheduleReload',
    );
    repo.renameResource.mockImplementationOnce(() => {
      throw new Error('SQLITE_BUSY: database is locked');
    });

    await expect(svc.moveDir('sub', 'moved')).rejects.toThrow();

    expect(
      reloadSpy.mock.calls.length,
      'DB 失败后没排 reload ⇒ 三态漂移(盘已搬 / DB 旧 id / byId 旧键)永远没人收',
    ).toBeGreaterThan(0);
  });
});
