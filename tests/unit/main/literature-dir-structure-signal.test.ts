// tests/unit/main/literature-dir-structure-signal.test.ts
//
// 守 r215「文献域磁盘**目录结构**变了,主进程必须发信号」契约。
//
// ── 被守卫的缺陷(孪生实现漏一边)────────────────────────────────────
//   notes 域 r184 就修过同一条:watcher 只监听 add / change / unlink
//   (全是**文件级**事件)⇒ 用户在资源管理器里**建/删一个空文件夹**时
//   主进程一个事件都收不到 ⇒ 左侧栏文件夹树与磁盘永久对不上,要等下次
//   启动。literature 域**漏了**同一条(r215 前)。
//
//   而且 literature 域比 notes **多一层坑**:它的 reload 有 emit 指纹
//   (r136 M1:指纹不变不 emit),指纹原来只看**文件行**
//   `${id}|${mtime}|${size}` —— 空文件夹的增删不改变任何文件行
//   ⇒ 就算接了 addDir/unlinkDir,reload 跑完指纹恒定 ⇒ 照样不 emit
//   ⇒ 树还是不刷新。所以修法是**两件事一起**:
//     ① watcher 接 addDir / unlinkDir(事件要进得来);
//     ② 目录集进 emit 指纹(变化要能变成 emit)。
//   本测的端到端断言(外部建空文件夹 ⇒ 收到 changed)对**只修一半**
//   的两种形态都是红的。
//
// ── 与 notes 侧守卫的关系 ────────────────────────────────────────────
//   notes 侧同契约由 notes-dir-structure-signal.test.ts 锁(r184);
//   本文件是 literature 域的镜像(r215)。renderer 侧「收到 changed →
//   树缓存失效重拉」由 folder-tree-external-refresh.test.ts 锁
//   (useDiskFolderSidebar 对两个域同一条订阅,useDiskFolderSidebar.ts:366)。
//
// 真 chokidar(被测的就是「事件有没有被订阅」,mock 掉就没得测);
// resources-repo mock 成内存 Map(真库要 electron app.getPath)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

interface FakeRow {
  id: string;
  kind: string;
  title: string;
  mtime: number;
  size: number;
  indexedAt: number;
  absPath: string;
  rootId: string | null;
  extractStatus: string;
  body: string;
}

const db = vi.hoisted(() => {
  const rows = new Map<string, FakeRow>();
  return { rows };
});

vi.mock('../../../src/main/db/resources-repo', () => ({
  upsertResource: vi.fn((r: FakeRow, body: string, absPath: string) => {
    db.rows.set(r.id, { ...r, body, absPath });
  }),
  deleteResource: vi.fn((id: string) => {
    db.rows.delete(id);
  }),
  listResources: vi.fn((kind?: string) =>
    [...db.rows.values()].filter((r) => !kind || r.kind === kind),
  ),
  renameResource: vi.fn((prevId: string, r: FakeRow, body: string, absPath: string) => {
    db.rows.delete(prevId);
    db.rows.set(r.id, { ...r, body, absPath });
  }),
  updateResourceStat: vi.fn((id: string, size: number, mtime: number) => {
    const r = db.rows.get(id);
    if (r) {
      r.size = size;
      r.mtime = mtime;
    }
  }),
}));

import { setRootPath } from '../../../src/main/utils/safe-write';
import { LiteratureService } from '../../../src/main/literature/literature-service';

/** 等到 predicate 成立(或超时)。chokidar 事件 → 100ms 防抖 → reload。 */
async function waitForEvent(predicate: () => boolean, timeoutMs = 8000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

describe('literature 目录结构变化必须发信号(r215)', () => {
  let root: string;
  let litDir: string;
  let svc: LiteratureService;
  let changedCount: number;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'rkms-litdir-'));
    setRootPath(root);
    litDir = join(root, 'literature');
    await fs.mkdir(litDir, { recursive: true });
    db.rows.clear();
    svc = new LiteratureService();
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

  it('外部新建空文件夹 → 发 changed(旧实现没接 addDir,永远不发;只接事件不进指纹也不发)', { timeout: 20000 }, async () => {
    await fs.mkdir(join(litDir, 'empty-folder'), { recursive: true });

    const fired = await waitForEvent(() => changedCount > 0);
    expect(fired).toBe(true);
  });

  it('外部删掉空文件夹 → 发 changed', { timeout: 20000 }, async () => {
    const dir = join(litDir, 'gone-folder');
    await fs.mkdir(dir, { recursive: true });
    await waitForEvent(() => changedCount > 0);
    const before = changedCount;

    await fs.rmdir(dir);
    const fired = await waitForEvent(() => changedCount > before);
    expect(fired).toBe(true);
  });

  it('外部给空文件夹改名 → 发 changed(addDir + unlinkDir 各一,至少一次)', { timeout: 20000 }, async () => {
    const dir = join(litDir, 'old-name');
    await fs.mkdir(dir, { recursive: true });
    await waitForEvent(() => changedCount > 0);
    const before = changedCount;

    await fs.rename(dir, join(litDir, 'new-name'));
    const fired = await waitForEvent(() => changedCount > before);
    expect(fired).toBe(true);
  });

  it('对照:纯文件行无变化的重复 reload 不重复 emit(指纹机制没被 r215 破坏)', async () => {
    // 目录结构稳定时,显式 load() 两次:第二次指纹必须命中「没变」分支。
    // (指纹机制是 r136 M1 的防风暴闸,r215 只是在指纹里**加了一维**,
    //  不是把闸拆了。)
    await svc.load();
    const before = changedCount;
    await svc.load();
    expect(changedCount).toBe(before);
  });
});
