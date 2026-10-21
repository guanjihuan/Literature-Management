// tests/unit/main/notes-self-write-echo.test.ts
//
// 守 perf r239「notes 域的自写回声不触发全量重扫」契约。
//
// 问题(用户诉求「使用流畅,不要有卡顿」的直接来源):
//   autosave 每 1.5s 落一次盘 → chokidar 'change' → scheduleReload(100ms
//   防抖)→ **全量重扫**(scanNotes 把每个 .md 都 open+read+gray-matter
//   解析一遍)。实测(本机,8KB/篇):500 篇 → 124ms;2000 篇 → 410ms。
//   主进程被占住 ⇒ 整个应用卡顿(不只是列表)。
//   而这次重扫是**纯浪费**:write() 自己已经做完 byId.set + syncResource
//   (DB/FTS) + emit('changed'),watcher 的回声只是把同样的状态重新从
//   磁盘读一遍。
//
// 顺带修掉的第二个浪费:原子写的 tmp 文件(`<target>.rkms-a<rand>.tmp`)
// 也会命中 chokidar 'add' ⇒ 旧实现**每次 autosave 多触发一次全量重扫**。
//   tmp 后缀不是 .md/.markdown ⇒ 按后缀过滤天然滤掉。
//
// 本测锁三条行为:
//   A. 应用自己写盘 ⇒ watcher 回声**不**触发全量重扫。
//   B. 外部改文件 ⇒ **照常**触发全量重扫(不能被误吞)。
//   C. DB 同步失败时 ⇒ 回声**仍然**触发重扫(自愈不能被优化掉)。
//
// 「有没有发生全量重扫」的可观测口径:scanNotes 的调用次数
//   (重扫 = scanNotes,这是 reload() 的唯一入口)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const repo = vi.hoisted(() => ({
  failUpsert: false,
  upsertResource: vi.fn(() => {
    if (repo.failUpsert) throw new Error('boom: db write failed');
  }),
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

// 计数「全量重扫」次数 —— 部分 mock:其余导出原样透传。
const scan = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../../../src/main/notes/standalone', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/notes/standalone')>();
  return {
    ...actual,
    scanNotes: async (...args: Parameters<typeof actual.scanNotes>) => {
      scan.calls += 1;
      return actual.scanNotes(...args);
    },
  };
});

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

/** 等到 predicate 成立(或超时)。 */
async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

const NOTE_FM = (title: string) => `---\nid: "x"\ntitle: "${title}"\n---\n\nbody of ${title}\n`;

describe('notes 自写回声不触发全量重扫(r239)', () => {
  let root: string;
  let notesDir: string;
  let svc: NotesService;

  /** 落一个笔记文件到磁盘(不经过 service ⇒ 算「外部」内容)。 */
  async function putFile(name: string, title: string): Promise<string> {
    const p = join(notesDir, name);
    await fs.writeFile(p, NOTE_FM(title), 'utf8');
    return p;
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'rkms-selfecho-'));
    setRootPath(root);
    notesDir = join(root, 'notes');
    await fs.mkdir(notesDir, { recursive: true });
    await putFile('a.md', 'A');
    await putFile('b.md', 'B');
    svc = new NotesService();
    await svc.start();
    // chokidar 的初始扫描是异步的 —— watcher 还没 ready 时发生的变化收不到事件
    await new Promise((r) => setTimeout(r, 700));
    scan.calls = 0;
    repo.failUpsert = false;
  });

  afterEach(async () => {
    await svc.stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('A. 应用自己写盘 ⇒ 回声不触发全量重扫', { timeout: 20000 }, async () => {
    const note = svc.list()[0]!;
    await svc.write(note.id, 'new body from the app', 'A2');
    // 落盘 → chokidar(awaitWriteFinish 50ms)→ 事件 → 100ms 防抖 → reload
    // ⇒ 给足时间,确保「如果没被抑制,重扫一定已经发生」
    await new Promise((r) => setTimeout(r, 2500));
    expect(scan.calls).toBe(0);
    // 写本身必须成功(否则上面的 0 只是因为压根没写成功)
    const onDisk = await fs.readFile(join(notesDir, note.relPath), 'utf8');
    expect(onDisk).toContain('new body from the app');
  });

  it('B. 外部改文件 ⇒ 照常触发全量重扫(不能被误吞)', { timeout: 20000 }, async () => {
    const target = svc.list().find((n) => n.filename === 'b.md')!;
    await fs.writeFile(join(notesDir, 'b.md'), NOTE_FM('B edited outside'), 'utf8');
    const fired = await waitFor(() => scan.calls > 0);
    expect(fired).toBe(true);
    // 重扫之后内存里的内容必须是外部改后的
    await waitFor(() => svc.findById(target.id)?.body.includes('B edited outside') === true);
    expect(svc.findById(target.id)?.body).toContain('B edited outside');
  });

  it('C. DB 同步失败 ⇒ 回声仍触发重扫(自愈不被优化掉)', { timeout: 20000 }, async () => {
    const note = svc.list()[0]!;
    repo.failUpsert = true;
    await svc.write(note.id, 'body that fails to reach the db', 'A3');
    // DB 写失败 ⇒ 不打自写标记 ⇒ watcher 回声照常触发全量重扫
    // (否则这条笔记的 resources 行永远停在旧正文,搜索搜不到新内容)
    const fired = await waitFor(() => scan.calls > 0);
    expect(fired).toBe(true);
  });

  it('D. 往 notes/ 里丢非笔记文件(图片等)⇒ 不触发全量重扫', { timeout: 20000 }, async () => {
    await fs.writeFile(join(notesDir, 'screenshot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    // 等足够久(chokidar 事件 + 100ms 防抖 + reload)
    await new Promise((r) => setTimeout(r, 2500));
    expect(scan.calls).toBe(0);
    // 对照:同目录下的 .md 改动**必须**照常触发(不能被过滤误伤)
    await fs.writeFile(join(notesDir, 'b.md'), NOTE_FM('B edited again'), 'utf8');
    const fired = await waitFor(() => scan.calls > 0);
    expect(fired).toBe(true);
  });

  it('E. app 写盘后**立刻**被外部改 ⇒ 外部内容必须可见(不得被自写回声吞掉)', { timeout: 30000 }, async () => {
    const target = svc.list().find((n) => n.filename === 'b.md')!;
    // 1) app 自己写盘 → 记下「写完时的文件指纹」
    await svc.write(target.id, 'body written by the APP', 'B-app');
    // 2) 紧接着外部工具(Obsidian / 同步盘)改**同一个**文件
    await fs.writeFile(join(notesDir, 'b.md'), NOTE_FM('B EXTERNAL EDIT'), 'utf8');
    // 3) 等 watcher 事件 + 去抖 + reload 全部发生
    await new Promise((r) => setTimeout(r, 3000));
    expect(scan.calls, '外部改动必须触发一次全量重扫').toBeGreaterThan(0);
    expect(svc.findById(target.id)?.body ?? '', '内存里必须是外部改后的内容').toContain(
      'B EXTERNAL EDIT',
    );
  });

  it('F. app 写盘后**立刻**被外部删 ⇒ 删除必须可见(watcher 可能整个吞掉这次删除)', { timeout: 30000 }, async () => {
    const target = svc.list().find((n) => n.filename === 'b.md')!;
    await svc.write(target.id, 'body written by the APP', 'B-app');
    // 外部在 app 写盘后 1ms 内把文件删了。
    //   危险点:chokidar 的 awaitWriteFinish 还在等这个文件「大小稳定 50ms」,
    //   文件却先没了 ⇒ chokidar 认为「那个待上报的写没了」,**既不发
    //   'change' 也不发 'unlink'** ⇒ 外部删除彻底不可见(机器繁忙时必现)。
    //   兜底 = 写盘后的**延迟复核**(见 service.scheduleWriteVerify)。
    await fs.unlink(join(notesDir, 'b.md'));
    await new Promise((r) => setTimeout(r, 3000));
    expect(scan.calls, '外部删除必须触发一次全量重扫').toBeGreaterThan(0);
    expect(
      svc.list().some((n) => n.filename === 'b.md'),
      '已被外部删除的笔记不得还留在内存索引里',
    ).toBe(false);
  });
});
