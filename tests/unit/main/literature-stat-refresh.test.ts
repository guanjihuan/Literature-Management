// tests/unit/main/literature-stat-refresh.test.ts
//
// 守 r211「文献行的 mtime / size 永远停在导入那一刻」契约。
//
// 现象(文献域与笔记域的口径差):
//   笔记侧 syncDbWithDisk(r180)每次 reload 都重读文件 ⇒ 行的 mtime 跟着磁盘走。
//   文献侧 reload() 只对 **disk-only**(新出现)的文件 stat,已经在库里的行
//   **一次都不 stat** ⇒ 行上的 mtime/size 永远停在导入那一刻。
//
// 连带三处用户可见的错:
//   1. 列表里「2.3 MB · 2h ago」是假的 —— 文件早就被重下 / 被同步盘覆盖;
//   2. 列表按 mtime 倒序 ⇒ 顺序也停在导入那一刻(新下载的文献排不上去);
//   3. emit 指纹是 `${id}|${mtime}` ⇒ 指纹恒定 ⇒ **连 'changed' 事件都
//      不发** ⇒ 渲染层永远收不到刷新通知(手动点「刷新」拉回来的还是旧值)。
//
// 本测锁四件事:
//   A. 文件在磁盘上被替换 ⇒ reload 后行的 size/mtime 是**磁盘真值**;
//   B. svc.list()(渲染层拿的就是它)也必须给新值;
//   C. 变化 ⇒ 必须 emit('changed');没变化 ⇒ **不许** emit(否则每次 reload
//      都把渲染层拖一遍全量拉);
//   D. stat 失败(EPERM / EBUSY)⇒ 行**保留**旧值,不崩、不当成「文件没了」
//      (那是 db-only 分支的职责)。
//
// 另加一条「内容变但 mtime 被保留」(备份还原 / cp -p)⇒ 指纹必须**也**看
// size,否则这种情况仍然是「静默无变化」。
//
// 真库(electron app.getPath)在测试环境不可用 → resources-repo 整体 mock
// 成内存 Map;被测行为(什么时候 stat、什么时候写库、什么时候 emit)全在
// service 内。chokidar 也 mock 掉 —— 真 watcher 会在测试写文件时异步发
// 'add'/'change' ⇒ 额外排一次 reload ⇒ emit 计数变成竞态。
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
  const calls = { upsert: 0, del: 0, stat: 0 };
  return { rows, calls };
});

vi.mock('../../../src/main/db/resources-repo', () => ({
  upsertResource: vi.fn((r: FakeRow, body: string, absPath: string) => {
    db.calls.upsert++;
    db.rows.set(r.id, { ...r, body, absPath });
  }),
  deleteResource: vi.fn((id: string) => {
    db.calls.del++;
    db.rows.delete(id);
  }),
  listResources: vi.fn((kind?: string) =>
    [...db.rows.values()].filter((r) => !kind || r.kind === kind),
  ),
  renameResource: vi.fn((prevId: string, r: FakeRow, body: string, absPath: string) => {
    db.rows.delete(prevId);
    db.rows.set(r.id, { ...r, body, absPath });
  }),
  // r211 新增:只更 size/mtime 两列(**不碰 FTS**)。
  updateResourceStat: vi.fn((id: string, size: number, mtime: number) => {
    const r = db.rows.get(id);
    if (r) {
      r.size = size;
      r.mtime = mtime;
    }
  }),
}));

// chokidar mock:真 watcher 会在测试写文件时异步发 'add'/'change',
// 排一次 reload ⇒ emit 计数变竞态。mock 掉让 reload 只由测试显式驱动。
vi.mock('chokidar', () => {
  const watch = vi.fn(() => {
    const w = {
      on: () => w,
      close: vi.fn(async () => {}),
      removeAllListeners: vi.fn(),
    };
    return w;
  });
  return { default: { watch }, watch };
});

// 「某个文件 stat 不出来」(Defender 锁 / 同步盘占位 / 权限翻转):
//   fsFail.statLocked 打开后,路径含 'locked' 的 stat / lstat 直接 reject(EPERM)。
//   用开关而不是「路径即开关」—— 首轮 reload 需要把这个文件**正常插进来**
//   (它得先在 DB 里才有「刷不动」这回事)。
//
// perf r254:stat **与** lstat 一起挡 —— 旧实现里「刷 stat」走的是独立的
//   fs.stat 一轮,所以只挡 stat 就能造出「拿不到 stat」的场景;r254 把
//   刷 stat 改成**复用扫描期那次 lstat**(见 literature-service.ts 的
//   LitDiskStat 头注),「拿不到 stat 信息」的第一个落点变成**扫描期**:
//   lstat 失败 ⇒ 该文件不进 diskPaths ⇒ 落进 db-only 分支 ⇒
//   isReallyGone 只在 ENOENT 时才判「没了」,EPERM 一律 fail-safe 当
//   「还在」⇒ 行保留旧值。**可观察行为不变**(行保留旧值 / 不删行 /
//   列表里还在),只是「拿不到」发生在哪一 syscall 上换了。
const fsFail = vi.hoisted(() => ({ statLocked: false }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const realStat = actual.promises.stat;
  const realLstat = actual.promises.lstat;
  const blocked = (path: unknown, op: string): Error | null => {
    if (fsFail.statLocked && typeof path === 'string' && path.includes('locked')) {
      return Object.assign(new Error(`EPERM: operation not permitted, ${op} '${path}'`), {
        code: 'EPERM',
      });
    }
    return null;
  };
  return {
    ...actual,
    default: actual,
    promises: {
      ...actual.promises,
      stat: (path: unknown, opts: unknown) => {
        const err = blocked(path, 'stat');
        if (err) return Promise.reject(err);
        return realStat(path as never, opts as never);
      },
      lstat: (path: unknown, opts: unknown) => {
        const err = blocked(path, 'lstat');
        if (err) return Promise.reject(err);
        return realLstat(path as never, opts as never);
      },
    },
  };
});

import { setRootPath } from '../../../src/main/utils/safe-write';
import { LiteratureService } from '../../../src/main/literature/literature-service';

describe('文献行的 stat 必须跟着磁盘刷新(r211)', () => {
  let root: string;
  let litDir: string;
  let svc: LiteratureService;

  /** 当前 DB 里唯一的文献行(测试里始终只有一篇)。 */
  function onlyRow(): FakeRow {
    const rows = [...db.rows.values()];
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  /** 把文件内容换掉并把 mtime 推到未来(模拟「重下 / 同步盘覆盖」)。 */
  async function replaceFile(p: string, content: string): Promise<void> {
    await fs.writeFile(p, content, 'utf-8');
    const t = new Date(Date.now() + 60_000);
    await fs.utimes(p, t, t);
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'rkms-litstat-'));
    setRootPath(root);
    litDir = join(root, 'literature');
    await fs.mkdir(litDir, { recursive: true });
    db.rows.clear();
    db.calls.upsert = 0;
    db.calls.del = 0;
    fsFail.statLocked = false;
    svc = new LiteratureService();
    await svc.start({ skipInitialLoad: true });
  });

  afterEach(async () => {
    await svc.stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('磁盘上的文件被替换 ⇒ reload 后行的 size/mtime 是磁盘真值', async () => {
    const p = join(litDir, 'paper.pdf');
    await fs.writeFile(p, 'AAAA', 'utf-8');
    await svc.load();
    const before = onlyRow();
    expect(before.size).toBe(4);
    // 取快照(memory mock 的 updateResourceStat 是**原地改**行对象,
    // 直接留引用会让「改之前」的值也跟着变 ⇒ 断言失真)
    const beforeMtime = before.mtime;
    const beforeSize = before.size;

    await replaceFile(p, 'AAAAAAAAAA'); // 10 字节 + 未来 mtime
    const disk = await fs.stat(p);

    await svc.load();

    const after = onlyRow();
    expect(after.size).toBe(10);
    expect(after.mtime).toBe(disk.mtimeMs);
    expect(after.size).not.toBe(beforeSize);
    expect(after.mtime).toBeGreaterThan(beforeMtime);
  });

  it('svc.list()(渲染层拿的就是它)必须给新值', async () => {
    const p = join(litDir, 'paper.pdf');
    await fs.writeFile(p, 'AAAA', 'utf-8');
    await svc.load();

    await replaceFile(p, 'AAAAAAAAAA');
    await svc.load();

    const row = svc.list()[0];
    expect(row?.size).toBe(10);
    expect(row?.mtime).toBe((await fs.stat(p)).mtimeMs);
  });

  it('文件被替换 ⇒ 必须 emit changed(否则渲染层永远看不到变化)', async () => {
    const p = join(litDir, 'paper.pdf');
    await fs.writeFile(p, 'AAAA', 'utf-8');
    await svc.load(); // 第一次:指纹 null → 有值,这次 emit 不计入

    let changedCount = 0;
    svc.on('changed', () => {
      changedCount++;
    });

    await replaceFile(p, 'BBBBBBBB');
    await svc.load();

    expect(changedCount).toBe(1);
  });

  it('文件没变 ⇒ 不许 emit changed(否则每次 reload 都把渲染层拖一遍)', async () => {
    const p = join(litDir, 'paper.pdf');
    await fs.writeFile(p, 'AAAA', 'utf-8');
    await svc.load();

    let changedCount = 0;
    svc.on('changed', () => {
      changedCount++;
    });

    await svc.load();
    await svc.load();

    expect(changedCount).toBe(0);
  });

  it('内容变了但 mtime 被保留(备份还原 / cp -p)⇒ 也要刷(指纹必须看 size)', async () => {
    const p = join(litDir, 'paper.pdf');
    await fs.writeFile(p, 'AAAA', 'utf-8');
    await svc.load();
    const orig = await fs.stat(p);

    let changedCount = 0;
    svc.on('changed', () => {
      changedCount++;
    });

    await fs.writeFile(p, 'AAAAAAAAAA', 'utf-8');
    await fs.utimes(p, orig.atime, orig.mtime); // mtime 还原成原值

    await svc.load();

    expect(onlyRow().size).toBe(10);
    expect(changedCount).toBe(1);
  });

  it('stat 失败(EPERM)⇒ 行保留旧值,不崩、不当成「文件没了」', async () => {
    const p = join(litDir, 'locked.pdf');
    await fs.writeFile(p, 'AAAA', 'utf-8');
    await svc.load();
    const before = onlyRow();
    const beforeSize = before.size;
    const beforeMtime = before.mtime;

    // 从这里起 stat 拿不到(文件还在,只是读不出 stat)
    fsFail.statLocked = true;
    // 换成更大内容 + 未来 mtime
    await fs.writeFile(p, 'AAAAAAAAAA', 'utf-8');
    const t = new Date(Date.now() + 60_000);
    await fs.utimes(p, t, t);

    await svc.load();
    fsFail.statLocked = false;

    const after = onlyRow();
    expect(after.id).toBe(before.id);
    expect(after.size).toBe(beforeSize); // 刷不动就保持旧值
    expect(after.mtime).toBe(beforeMtime);
    expect(db.calls.del).toBe(0); // 绝不能把「读不到」当成「没了」
    expect(svc.list()).toHaveLength(1);
  });
});
