// tests/unit/main/notes-dir-structure-signal.test.ts
//
// 守 r184「磁盘**目录结构**变了,主进程必须发信号」契约。
//
// 旧实现:notes 的 chokidar 只监听 add / change / unlink(全是**文件级**
// 事件)⇒ 用户在资源管理器里建了一个**空文件夹**(没有任何文件)时,
// 主进程一个事件都收不到 ⇒ reload 不跑 ⇒ 'changed' 不发 ⇒ renderer
// 完全不知道磁盘的目录结构变了。
//
// 后果(用户诉求「列表应该和对应的文件夹完全一致」被打破):
//   - 外部新建的文件夹在左侧栏永远不出现;
//   - 外部删掉的文件夹永远还在(点进去是空的);
//   - 外部改名的文件夹显示旧名,里面文件的行从当前视图里「消失」。
//
// 本测锁:notes 服务在**只有目录变、没有文件变**时也必须发 'changed'。
// (renderer 侧「收到 changed → 树缓存失效并重拉」由
//  tests/unit/renderer/hooks/folder-tree-external-refresh.test.ts 锁。)
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

import { setRootPath } from '../../../src/main/utils/safe-write';
import { NotesService } from '../../../src/main/notes/service';

/** 等到 predicate 成立(或超时)。chokidar 事件 → 100ms 防抖 → reload。 */
async function waitForEvent(
  svc: NotesService,
  predicate: () => boolean,
  timeoutMs = 8000,
): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

describe('notes 目录结构变化必须发信号(r184)', () => {
  let root: string;
  let notesDir: string;
  let svc: NotesService;
  let changedCount: number;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'rkms-notedir-'));
    setRootPath(root);
    notesDir = join(root, 'notes');
    await fs.mkdir(notesDir, { recursive: true });
    svc = new NotesService();
    await svc.start({ skipInitialLoad: true });
    changedCount = 0;
    svc.on('changed', () => {
      changedCount += 1;
    });
    // chokidar 的初始扫描是异步的 —— watcher 还没 ready 时建的目录收不到
    // addDir 事件(ignoreInitial: true ⇒ 只报 watcher 就绪之后的变化)。
    await new Promise((r) => setTimeout(r, 600));
  });

  afterEach(async () => {
    await svc.stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('外部新建空文件夹 → 发 changed(旧实现只监听文件级事件,永远不发)', { timeout: 20000 }, async () => {
    await fs.mkdir(join(notesDir, 'empty-folder'), { recursive: true });

    const fired = await waitForEvent(svc, () => changedCount > 0);
    expect(fired).toBe(true);
  });

  it('外部删掉空文件夹 → 发 changed', { timeout: 20000 }, async () => {
    const dir = join(notesDir, 'gone-folder');
    await fs.mkdir(dir, { recursive: true });
    await waitForEvent(svc, () => changedCount > 0);
    const before = changedCount;

    await fs.rmdir(dir);
    const fired = await waitForEvent(svc, () => changedCount > before);
    expect(fired).toBe(true);
  });
});
