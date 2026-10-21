// tests/unit/main/literature-reload-emit-fingerprint.test.ts
//
// 守 r257「文献 reload 的 emit 幂等指纹」契约 —— 并锁住「指纹不许再拼
// 成一根大字符串」的性能契约。
//
// ── 为什么这一轮是「补守卫」而不是「补功能」 ─────────────────────────
//   文献域的 emit 指纹自 r136 M1 起就有(byId 内容没变 ⇒ 不 emit),
//   notes 域自 r223 起也补上了(r223 的守卫:notes-reload-emit-fingerprint
//   .test.ts)。但**文献域这半边一直没有守卫** —— tests/unit/main/ 下的
//   literature-* 守卫覆盖的是导入 / 改名 / 移动 / stat 刷新 / 目录信号,
//   **没有一个**盯 emit 指纹本身。r136 M1 之后这块代码被动过至少四次
//   (r172 relPath / r197 O(N×M) / r211 双因子 / r254 单遍 stat),每一次
//   都可能把「指纹维度」悄悄改掉 —— 而没有守卫会发现。
//   notes 侧守的是 r223 契约;文献侧现在补齐同一份契约(孪生实现口径
//   应当一致 —— 这正是 r223 那条注释里说的「第八次应验」)。
//
// ── 指纹的三个维度(缺一个就有一类用户可见的错) ──────────────────────
//   ① 文件集 + 每行的 (mtime, size) —— 内容变了要 emit;
//   ② 目录集(r215)—— 空文件夹增删不改任何文件行;
//   ③ 首轮必 emit(r136 M1:初始 null)—— 否则首屏拿不到数据。
//
// ── 本测锁七件事 ───────────────────────────────────────────────────
//   A. 磁盘零变化 → 第二次 load **不再 emit**(缺陷本体;文献侧此前无
//      守卫 ⇒ 这条是本轮新增的回归网);
//   B. 外部改内容(mtime + size 都变)→ load 仍 emit(真变化不许被吞);
//   C. 外部建**空文件夹** → load 仍 emit(r215 维度);
//   D. 内容变长 + **mtime 保留**(cp -p / 备份还原 / 同步盘按内容去重的
//      真实形态)→ load 仍 emit(r211 的 size 维度必须参与指纹);
//   F. 内容长度不变但 mtime 变(外部 touch / no-op 写)→ load 仍 emit
//      (mtime 维度必须参与指纹);
//   G. 首轮 load 必须 emit(r136 M1:初始基线为空也要把初始状态推出去);
//   E. 指纹表示:**每行状态落在 Map 里**(不是拼成一根大字符串)——
//      这是本轮的性能契约(旧实现每轮拼 N 个 `${id}|${mtime}|${size}`
//      字符串 + 排序 + join:lit id 是绝对路径(平均 108 字符)⇒ 每轮
//      额外分配 ≈ 250KB 字符串、实测 ≈ 0.8ms/2000 行纯主线程 CPU;新
//      实现只做 O(n) 逐项比对 ≈ 0.13ms)。
//
// chokidar mock 掉(本测要的是「reload 之后」的判定,不是「事件有没有
// 被订阅」—— 后者由 literature-dir-structure-signal.test.ts 守);
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

import { setRootPath } from '../../../src/main/utils/safe-write';
import { LiteratureService } from '../../../src/main/literature/literature-service';

describe('文献 reload 的 emit 幂等指纹(r257)', () => {
  let root: string;
  let litDir: string;
  let svc: LiteratureService;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'rkms-litfp-'));
    setRootPath(root);
    litDir = join(root, 'literature');
    await fs.mkdir(litDir, { recursive: true });
    db.rows.clear();
    svc = new LiteratureService();
    await svc.start({ skipInitialLoad: true });
  });

  afterEach(async () => {
    await svc.stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function seed(name: string, content = 'AAAA'): Promise<string> {
    const p = join(litDir, name);
    await fs.writeFile(p, content, 'utf-8');
    return p;
  }

  it('A 磁盘零变化 → 第二次 load 不再 emit(缺陷本体)', async () => {
    await seed('a.pdf');
    await svc.load(); // 指纹落基线
    const changed = vi.fn();
    svc.on('changed', changed);

    await svc.load();
    await svc.load();

    expect(
      changed,
      'byId 一个字没变也 emit ⇒ 同步盘 no-op 触碰每次都拖 renderer 全量重拉',
    ).not.toHaveBeenCalled();
  });

  it('B 外部改内容(mtime + size 都变)→ load 仍 emit(真变化不许被吞)', async () => {
    const p = await seed('b.pdf');
    await svc.load();
    const changed = vi.fn();
    svc.on('changed', changed);

    await fs.writeFile(p, 'AAAAAAAAAAAA', 'utf-8');
    const t = new Date(Date.now() + 60_000);
    await fs.utimes(p, t, t);
    await svc.load();

    expect(changed).toHaveBeenCalledTimes(1);
    expect(svc.list().find((r) => r.absPath === p)?.size).toBe(12);
  });

  it('C 外部建空文件夹 → load 仍 emit(r215 维度:目录集参与指纹)', async () => {
    await seed('c.pdf');
    await svc.load();
    const changed = vi.fn();
    svc.on('changed', changed);

    await fs.mkdir(join(litDir, 'empty-folder'));
    await svc.load();

    expect(
      changed,
      '目录结构变化必须 emit —— 只看文件行会把空文件夹的增删判成「没变」',
    ).toHaveBeenCalledTimes(1);
  });

  it('D 内容变长 + mtime 保留 → load 仍 emit(r211 的 size 维度)', async () => {
    // mtime 从**第一次落盘起**就钉死(不是「改完再写回」—— 那条路会把
    //   亚毫秒精度截掉,于是「mtime 保留」其实没保住,size 维度就被
    //   mtime 维度的假差掩盖了)。这里两轮都是同一个整秒 mtime。
    const p = join(litDir, 'd.pdf');
    const fixed = new Date(1_700_000_000_000);
    await fs.writeFile(p, 'AAAA', 'utf-8');
    await fs.utimes(p, fixed, fixed);
    await svc.load();
    const changed = vi.fn();
    svc.on('changed', changed);

    // 内容变长但 mtime 钉死(备份还原 / cp -p / 同步盘按内容去重)
    await fs.writeFile(p, 'AAAAAAAAAAAA', 'utf-8');
    await fs.utimes(p, fixed, fixed);
    await svc.load();

    expect(
      changed,
      'mtime 被保留但 size 变了 ⇒ 指纹必须变(只看 mtime 会静默不刷)',
    ).toHaveBeenCalledTimes(1);
  });

  it('F 内容长度不变但 mtime 变(外部 touch / no-op 写)→ load 仍 emit(mtime 维度)', async () => {
    const p = await seed('f.pdf', 'AAAA');
    await svc.load();
    const changed = vi.fn();
    svc.on('changed', changed);

    const t = new Date(Date.now() + 60_000);
    await fs.utimes(p, t, t);
    await svc.load();

    expect(
      changed,
      'mtime 变了就必须 emit —— 指纹的 mtime 维度不许被删(否则外部改动静默不刷)',
    ).toHaveBeenCalledTimes(1);
  });

  it('G 首轮 load 必须 emit(初始基线为空 ⇒ 必须把初始状态推给 renderer)', async () => {
    await seed('g.pdf');
    const changed = vi.fn();
    svc.on('changed', changed);

    await svc.load();

    expect(
      changed,
      '首轮不 emit ⇒ renderer 永远拿不到初始列表(r136 M1 的「初始 null ⇒ 必 emit」)',
    ).toHaveBeenCalledTimes(1);
  });

  it('E 指纹表示:每行状态落在 Map 里(不是拼成一根大字符串)', async () => {
    await seed('e1.pdf');
    await seed('e2.pdf');
    await seed('e3.pdf');

    // 观测点:Map.prototype.set 的调用记录。reload 期间出现的 Map 里,
    //   只有 per-row 状态表的**值**是纯 {mtime, size}:
    //     - db.rows / rowsById / refreshed / byId 的值是资源行(带 id);
    //     - diskStats 的值是扫描期 stat(带 mtimeMs,不是 mtime);
    //   所以「值只含 mtime+size」这一条就能把状态表单独摘出来。
    const seen: Array<Map<unknown, unknown>> = [];
    const origSet = Map.prototype.set;
    const spy = vi
      .spyOn(Map.prototype, 'set')
      .mockImplementation(function (this: Map<unknown, unknown>, key: unknown, value: unknown) {
        seen.push(this);
        return origSet.call(this, key, value);
      });
    try {
      await svc.load();
    } finally {
      spy.mockRestore();
    }

    const tables = new Set(
      seen.filter((m) => {
        const vals = [...m.values()];
        return (
          vals.length > 0 &&
          vals.every((v) => {
            const o = v as Record<string, unknown>;
            return typeof o.mtime === 'number' && typeof o.size === 'number' && !('id' in o);
          })
        );
      }),
    );

    expect(
      tables.size,
      'reload 必须有一张纯 {mtime,size} 的 per-row 状态表(旧实现只有一根字符串)',
    ).toBe(1);
    expect([...tables][0]!.size, '状态表的条数必须等于文件行数').toBe(3);
  });
});
