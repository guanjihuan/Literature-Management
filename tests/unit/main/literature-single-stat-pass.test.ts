// tests/unit/main/literature-single-stat-pass.test.ts
//
// 守 r254「文献 reload 每轮把整棵子树 stat 两遍」的修复契约 ——
//   一轮 reload 对每个磁盘文件只允许有**一次** stat(lstat)调用。
//
// 背景(用户诉求「使用流畅,不要有卡顿」):
//   文献 reload 是 chokidar 100ms 防抖的**高频**路径(用户往库里丢一批
//   PDF / 同步盘落一批文件 ⇒ 连续几轮 reload)。旧实现每轮做两遍 stat:
//     ① 扫描期 collectLiteratureFiles:每文件一次 lstat —— 只为了 symlink
//        防御,拿到的 mtimeMs / size 被**直接丢掉**;
//     ② 刷新期 refreshDiskStats:对每个已在库的文件再来一次 fs.stat。
//   实测(2000 个文献文件 / 20 个子目录):①≈40ms + ②≈35ms = 75ms/轮,
//   而 ① 的结果本来就在手上 ⇒ 合并后只剩一次。
//
// 本测锁两件事:
//   A. **调用次数**:N 个文件 ⇒ lstat 恰好 N 次、stat **0 次**
//      (变异:把 refreshDiskStats 改回 fs.stat ⇒ stat 次数 = N ⇒ 变红);
//   B. **语义不丢**:合并后行的 size / mtime 仍须是磁盘真值,且文件变了
//      仍要刷(否则「省了 stat 却把 r211 的修复弄丢了」—— 列表里的
//      「2.3 MB · 2h ago」会变回假的)。
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

// 计数 fs 的 stat / lstat 调用 —— 本测的**唯一**观测点。
const fsCalls = vi.hoisted(() => ({ stat: 0, lstat: 0, reset: () => { fsCalls.stat = 0; fsCalls.lstat = 0; } }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const realStat = actual.promises.stat;
  const realLstat = actual.promises.lstat;
  return {
    ...actual,
    default: actual,
    promises: {
      ...actual.promises,
      stat: (path: unknown, opts: unknown) => {
        fsCalls.stat++;
        return realStat(path as never, opts as never);
      },
      lstat: (path: unknown, opts: unknown) => {
        fsCalls.lstat++;
        return realLstat(path as never, opts as never);
      },
    },
  };
});

import { setRootPath } from '../../../src/main/utils/safe-write';
import { LiteratureService } from '../../../src/main/literature/literature-service';

const N = 5;

describe('文献 reload 每轮只做一遍 stat(r254)', () => {
  let root: string;
  let litDir: string;
  let svc: LiteratureService;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'rkms-litstat1-'));
    setRootPath(root);
    litDir = join(root, 'literature');
    await fs.mkdir(litDir, { recursive: true });
    db.rows.clear();
    fsCalls.reset();
    svc = new LiteratureService();
    await svc.start({ skipInitialLoad: true });
  });

  afterEach(async () => {
    await svc.stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function seed(): Promise<string[]> {
    const paths: string[] = [];
    for (let i = 0; i < N; i++) {
      const p = join(litDir, `paper${i}.pdf`);
      await fs.writeFile(p, 'AAAA', 'utf-8');
      paths.push(p);
    }
    return paths;
  }

  it('N 个文件 ⇒ lstat N 次、stat 0 次(不能有第二遍 stat)', async () => {
    await seed();
    fsCalls.reset();
    await svc.load();

    expect(fsCalls.lstat, '扫描期每个文件一次 lstat').toBe(N);
    expect(fsCalls.stat, 'reload 不得再对每个文件 stat 一遍').toBe(0);
  });

  it('合并后行的 size / mtime 仍是磁盘真值(语义没丢)', async () => {
    await seed();
    await svc.load();

    const rows = svc.list();
    expect(rows).toHaveLength(N);
    for (const r of rows) {
      const disk = await fs.stat(r.absPath);
      expect(r.size, `${r.absPath} 的 size 必须是磁盘真值`).toBe(disk.size);
      expect(r.mtime, `${r.absPath} 的 mtime 必须是磁盘真值`).toBe(disk.mtimeMs);
    }
  });

  it('文件被替换 ⇒ 行照样刷(省 stat 不能把 r211 的修复弄丢)', async () => {
    const paths = await seed();
    await svc.load();
    const before = svc.list().find((r) => r.absPath === paths[0]);
    expect(before?.size).toBe(4);

    await fs.writeFile(paths[0]!, 'AAAAAAAAAA', 'utf-8');
    const t = new Date(Date.now() + 60_000);
    await fs.utimes(paths[0]!, t, t);

    await svc.load();

    const after = svc.list().find((r) => r.absPath === paths[0]);
    expect(after?.size, '内容变了必须刷出新 size').toBe(10);
    expect(after?.mtime).toBe(t.getTime());
  });

  it('第二轮 reload(文件没变)同样零 stat', async () => {
    await seed();
    await svc.load();
    fsCalls.reset();
    await svc.load();
    expect(fsCalls.lstat).toBe(N);
    expect(fsCalls.stat).toBe(0);
  });
});
