// tests/unit/main/literature-db-only-gone-guard.test.ts
//
// 守 r219「db-only 清理把**还在磁盘上**的文献从索引里删掉」契约。
//
// 现象(与 notes 域 r210 同一个 bug 类,第四次出现):
//   literature 有两条「db-only ⇒ 删索引行」路径,判「文件在不在」都用裸
//   `existsSync(r.absPath)`:
//     ① reload step 5:DB 有、磁盘扫不到的行,`!existsSync` ⇒ deleteResource;
//     ② resyncExternal(60s 周期):byId 里 absPath 落在 literature/ 之外的
//       旧库迁移行,`existsSync` false ⇒ deleteResource + byId.delete。
//   而 `existsSync` 把「文件不存在」与「文件**读不到**」压成同一个 false
//   (Defender 扫描 / OneDrive placeholder / 同步盘瞬时占用 ⇒ EACCES /
//   EPERM / EBUSY)⇒ 一次**瞬时**错误就把还在磁盘上的文献从索引里删掉:
//   列表 / 搜索里消失(本轮不会补回),用户以为文件被删了。
//   ②的 try/catch 包 existsSync 还是**死代码** —— existsSync 自己吞掉所有
//   错误返回 false,catch 永远进不去。
//
// 修法(r219):两条路都换成 `utils/file-check.ts` 的 `isReallyGone()` ——
//   **只有 ENOENT 才算「没了」**,其余错误 fail-safe 当作「还在」(代价
//   不对等:误判「还在」= 留一条可自愈的 ghost 行;误判「没了」= 删掉
//   用户的数据可见性)。notes 侧 r209/r210 的两处本地实现一并上收到
//   file-check.ts 单一真相源,两个域不再各自维护孪生实现。
//
// 本测锁四件事:
//   A. reload:db-only 行 stat 报 EPERM ⇒ 行**必须留下**(缺陷本体,修前红);
//   B. reload:db-only 行真 ENOENT ⇒ 行**仍被清理**(回归锚,守卫不许把
//      真 ghost 留下,修前绿);
//   C. resyncExternal:外部行 stat 报 EPERM ⇒ 行留下 + **不 emit changed**
//      (修前红);
//   D. resyncExternal:外部行真 ENOENT ⇒ 删 + emit changed 一次(修前绿)。
//
// 真库(electron app.getPath)在测试环境不可用 → resources-repo 整体 mock
// 成内存 Map;chokidar mock 掉(真 watcher 会被测试写文件触发,异步排额外
// reload ⇒ emit 计数竞态);「读不到」用 fs.promises.stat 按路径关键字
// ('locked')注入 EPERM —— 比 chmod 可靠(Windows 上 POSIX 权限位不可靠)。
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
  const delIds: string[] = [];
  return { rows, delIds };
});

vi.mock('../../../src/main/db/resources-repo', () => ({
  upsertResource: vi.fn((r: FakeRow, body: string, absPath: string) => {
    db.rows.set(r.id, { ...r, body, absPath });
  }),
  deleteResource: vi.fn((id: string) => {
    db.delIds.push(id);
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

// chokidar mock:让 reload 只由测试显式驱动(真 watcher 会被测试写文件
// 异步触发 ⇒ 额外排 reload ⇒ emit 计数竞态)。
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

// 「读不到」注入:开关打开后,路径含 'locked' 的:
//   - `promises.stat` reject(EPERM)—— isReallyGone 走这条路,被分类成
//     「读不到 ⇒ 还在」;
//   - `existsSync` 返回 false —— **这正是 existsSync 在 EPERM 下的真实行为**
//     (它吞掉所有错误返回 false)。不能只 mock statSync:Node 的 existsSync
//     绑的是内部 statSync 引用,模块命名空间的 statSync mock 拦不到它。
// 用开关而不是「路径即开关」—— 有的用例需要先让文件正常进 byId,再注入。
const fsFail = vi.hoisted(() => ({ statLocked: false }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const realStat = actual.promises.stat;
  const realExistsSync = actual.existsSync;
  const isLocked = (path: unknown): path is string =>
    fsFail.statLocked && typeof path === 'string' && path.includes('locked');
  return {
    ...actual,
    default: actual,
    existsSync: (path: unknown) => {
      if (isLocked(path)) return false; // existsSync 在 EPERM/EACCES 下的真实行为
      return realExistsSync(path as never);
    },
    promises: {
      ...actual.promises,
      stat: (path: unknown, opts: unknown) => {
        if (isLocked(path)) {
          const err = Object.assign(new Error(`EPERM: operation not permitted, stat '${path}'`), {
            code: 'EPERM',
          });
          return Promise.reject(err);
        }
        return realStat(path as never, opts as never);
      },
    },
  };
});

import { setRootPath } from '../../../src/main/utils/safe-write';
import { LiteratureService } from '../../../src/main/literature/literature-service';
import { litResourceId } from '../../../src/shared/resource-id';
import { toPosix } from '../../../src/main/notes/path-mapping';

function seedRow(absPath: string): FakeRow {
  const id = litResourceId(toPosix(absPath)) as string;
  const row: FakeRow = {
    id,
    kind: 'literature',
    title: 'paper',
    mtime: 1000,
    size: 4,
    indexedAt: 1,
    absPath,
    rootId: null,
    extractStatus: 'done',
    body: '',
  };
  db.rows.set(id, row);
  return row;
}

/** 调私有 resyncExternal(60s 周期等不起;行为锁直接打方法)。 */
async function runResyncExternal(svc: LiteratureService): Promise<void> {
  await (svc as unknown as { resyncExternal(): Promise<void> }).resyncExternal();
}

describe('db-only 清理只删「真的没了」的文献行(r219)', () => {
  let root: string;
  let litDir: string;
  let svc: LiteratureService;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'rkms-litghost-'));
    setRootPath(root);
    litDir = join(root, 'literature');
    await fs.mkdir(litDir, { recursive: true });
    db.rows.clear();
    db.delIds.length = 0;
    fsFail.statLocked = false;
    svc = new LiteratureService();
    await svc.start({ skipInitialLoad: true });
  });

  afterEach(async () => {
    await svc.stop();
    fsFail.statLocked = false;
    await fs.rm(root, { recursive: true, force: true });
  });

  it('A reload:db-only 行 stat 报 EPERM(读不到)⇒ 行必须留下', async () => {
    // 文件从未写过盘 ⇒ 磁盘扫不到 ⇒ db-only;stat 被注入 EPERM。
    const row = seedRow(join(litDir, 'locked-paper.pdf'));
    fsFail.statLocked = true;

    await svc.load();

    expect(
      db.rows.has(row.id),
      'stat 读不到(EPERM)被当成「文件没了」⇒ 还在磁盘上的文献被从索引里删掉',
    ).toBe(true);
    expect(db.delIds).not.toContain(row.id);
    expect(svc.list().map((r) => r.id)).toContain(row.id);
  });

  it('B reload:db-only 行真 ENOENT ⇒ 行仍被清理(回归锚)', async () => {
    // 文件从未写过盘,stat 走真 fs ⇒ ENOENT ⇒ 真 ghost,必须清。
    const row = seedRow(join(litDir, 'gone-paper.pdf'));

    await svc.load();

    expect(db.rows.has(row.id), '真 ghost 行被守卫误留').toBe(false);
    expect(db.delIds).toContain(row.id);
  });

  it('C resyncExternal:外部行 stat 报 EPERM ⇒ 行留下 + 不 emit changed', async () => {
    // 旧库迁移行:absPath 在 literature/ 之外。先写真实文件让它进 byId。
    const extDir = join(root, 'old-lib');
    await fs.mkdir(extDir, { recursive: true });
    const extPath = join(extDir, 'locked-ext.pdf');
    await fs.writeFile(extPath, 'AAAA', 'utf-8');
    const row = seedRow(extPath);
    await svc.load();
    expect(svc.list().map((r) => r.id)).toContain(row.id);

    const changed = vi.fn();
    svc.on('changed', changed);
    fsFail.statLocked = true;
    await runResyncExternal(svc);

    expect(
      db.rows.has(row.id),
      'stat 读不到(EPERM)被当成「文件没了」⇒ 旧库文献被从索引里删掉',
    ).toBe(true);
    expect(db.delIds).not.toContain(row.id);
    expect(svc.list().map((r) => r.id)).toContain(row.id);
    expect(changed, '没有真实删除却发了 changed ⇒ 渲染层被拖一遍全量拉').not.toHaveBeenCalled();
  });

  it('D resyncExternal:外部行真 ENOENT ⇒ 删 + emit changed 一次(回归锚)', async () => {
    const extDir = join(root, 'old-lib');
    await fs.mkdir(extDir, { recursive: true });
    const extPath = join(extDir, 'gone-ext.pdf');
    await fs.writeFile(extPath, 'AAAA', 'utf-8');
    const row = seedRow(extPath);
    await svc.load();
    expect(svc.list().map((r) => r.id)).toContain(row.id);

    await fs.rm(extPath); // 真被外部删掉
    const changed = vi.fn();
    svc.on('changed', changed);
    await runResyncExternal(svc);

    expect(db.rows.has(row.id), '真 ghost 行被守卫误留').toBe(false);
    expect(db.delIds).toContain(row.id);
    expect(svc.list().map((r) => r.id)).not.toContain(row.id);
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
