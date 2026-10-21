// tests/unit/main/notes-reload-emit-fingerprint.test.ts
//
// 守 r223「notes reload 的 emit 幂等指纹」契约(镜像 literature r136 M1)。
//
// ── 被守卫的缺陷 ───────────────────────────────────────────────────
//   literature reload 自 r136 M1 起有 emit 幂等指纹(byId 内容没变 ⇒
//   不 emit),notes reload 却**无条件** `this.emit('changed')` ——
//   孪生实现口径不一致第八次应验。后果:chokidar 对 no-op 触碰(同步盘
//   周期 touch / 元数据抖动)也触发 scheduleReload → emit ⇒ renderer
//   每次都全量 listNotes IPC + setState(100+ 行重渲),内容一个字没变;
//   高频时正是 perf(2026-09-04) 系列一直在压的卡顿源。
//
//   修法(r223):指纹 = `${id}|${mtime}|${size}` 排序 join(r211/r220
//   双因子口径)+ **目录集**(r215 的教训:空文件夹增/删/改名不改变
//   任何文件行,只看文件指纹会把目录结构变化判成「没变」;r184 起
//   notes watcher 就监听 addDir/unlinkDir,指纹必须接住这一类)。
//   指纹只管 emit;syncDbWithDisk **无条件跑**(DB 自愈不依赖 renderer
//   是否需要刷新)。
//
// ── 本测锁四件事 ───────────────────────────────────────────────────
//   A. 磁盘零变化 → 第二次 load **不再 emit**(缺陷本体,修前红);
//   B. 外部改内容 → load 仍 emit(回归锚:真变化不许被指纹吞掉);
//   C. 外部建**空文件夹** → load 仍 emit(回归锚,r215 类:文件行没变,
//      目录集变 —— 没有目录维度的「修复」会把这类判成没变);
//   D. DB stale 行(indexed_at=0)→ load 仍回填(syncDbWithDisk 无条件
//      跑)但**不 emit**(修前红:HEAD  unconditional emit 多打一次)。
//
// 真库(electron app.getPath)在测试环境不可用 → resources-repo 整体 mock
// 成内存 Map(与 notes-reload-db-sync.test.ts 同款 harness)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

interface FakeRow {
  id: string;
  kind: string;
  title: string;
  relPath: string;
  mtime: number;
  size: number;
  indexedAt: number;
  body: string;
  absPath: string;
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
  listResourceRelPaths: vi.fn((kind: string) =>
    [...db.rows.values()].filter((r) => r.kind === kind).map((r) => r.relPath),
  ),
  listStaleIndexIds: vi.fn((kind: string) =>
    [...db.rows.values()].filter((r) => r.kind === kind && r.indexedAt === 0).map((r) => r.id),
  ),
  renameResource: vi.fn((prevId: string, r: FakeRow, body: string, absPath: string) => {
    db.rows.delete(prevId);
    db.rows.set(r.id, { ...r, body, absPath });
  }),
}));

// electron 需整体 mock:safe-write 用 shell.trashItem(节点环境没有真回收站)
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
import { noteResourceId } from '../../../src/shared/resource-id';

describe('notes reload 的 emit 幂等指纹(r223)', () => {
  let root: string;
  let notesDir: string;
  let svc: NotesService;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'rkms-notefp-'));
    setRootPath(root);
    notesDir = join(root, 'notes');
    await fs.mkdir(notesDir, { recursive: true });
    db.rows.clear();
    svc = new NotesService();
    await svc.start({ skipInitialLoad: true });
  });

  afterEach(async () => {
    await svc.stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('A 磁盘零变化 → 第二次 load 不再 emit(修前红:HEAD 无条件 emit)', async () => {
    await svc.create('a.md');
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

  it('B 外部改内容 → load 仍 emit(真变化不许被指纹吞掉)', async () => {
    const created = await svc.create('b.md');
    await svc.load();
    const changed = vi.fn();
    svc.on('changed', changed);

    await fs.appendFile(join(notesDir, 'b.md'), '\n外部新增内容\n', 'utf-8');
    // mtime 与 size 都变 ⇒ 指纹必变
    await svc.load();

    expect(changed).toHaveBeenCalledTimes(1);
    expect(svc.findById(created.id)?.body).toContain('外部新增内容');
  });

  it('C 外部建空文件夹 → load 仍 emit(r215 类:文件行没变,目录集变)', async () => {
    await svc.create('c.md');
    await svc.load();
    const changed = vi.fn();
    svc.on('changed', changed);

    await fs.mkdir(join(notesDir, 'empty-folder'));
    await svc.load();

    expect(
      changed,
      '目录结构变化必须 emit —— 只看文件指纹会把空文件夹的增删判成「没变」',
    ).toHaveBeenCalledTimes(1);
  });

  it('D DB stale 行(indexed_at=0)→ load 仍回填但不 emit(修前红)', async () => {
    const created = await svc.create('d.md');
    await svc.load();
    const rowId = noteResourceId(created.id);
    const row = db.rows.get(rowId);
    expect(row).toBeDefined();
    // 模拟 0005 迁移标记:FTS 只有 title 种子,等回填
    row!.indexedAt = 0;
    const changed = vi.fn();
    svc.on('changed', changed);

    await svc.load();

    expect(
      db.rows.get(rowId)?.indexedAt,
      'stale 回填被指纹跳过 ⇒ indexed_at=0 行永久残废(syncDbWithDisk 必须无条件跑)',
    ).not.toBe(0);
    expect(changed, 'byId 没变却为 DB 回填多打一次 emit').not.toHaveBeenCalled();
  });
});
