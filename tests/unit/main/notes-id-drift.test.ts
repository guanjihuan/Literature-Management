// tests/unit/main/notes-id-drift.test.ts
//
// 守 r192「笔记 id 漂移」在**主进程**这一侧的契约。
//
// id 的两套真相(这是漂移的根源):
//   - 读:extractNoteId(note-id.ts)优先取**磁盘上的 frontmatter id**
//     (兼容旧文件 / 手写 / 从别的机器拷来的 .md);
//   - 写:writeNote(standalone.ts)把 fm.id **重钉**为 computeFileId(relPath)
//     (r124「副本重映射」规则)⇒ 只要磁盘上的 fm.id 与路径哈希不一致,
//     保存之后 id 就变了。
//
// 现实触发源(不是理论):
//   - 用户在资源管理器里改了文件名 / 移动了文件(fm.id 还是旧路径的哈希);
//   - 从别的机器 / 别的工具拷进来的 .md(自带别的路径的 fm.id);
//   - 手改过 frontmatter。
//
// 本测锁(主进程侧的三条事实):
//   1. 漂移**确实会发生**:磁盘 fm.id ≠ 路径哈希时,write 返回的 id 是**新 id**;
//   2. 旧 id **真的死了**(byId 里查不到)⇒ renderer 若还拿着旧 id,下一次
//      自动保存必撞 NOT_FOUND(正文只进内存草稿 ⇒ 重启即丢 = 数据丢失);
//   3. 收藏(★)跟着改:旧 fileId 变孤儿 ⇒ ★ 静默消失(r189 同款,触发点是
//      「保存」)。
//
// renderer 侧的重映射(选中态 / 多选 / 正在编辑的那篇)由
// tests/unit/renderer/store/notes-save-id-drift.test.ts 守。
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

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  return {
    handlers,
    ipcMain: {
      handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
        handlers.set(channel, fn);
      },
    },
    shell: {
      trashItem: vi.fn(),
      showItemInFolder: vi.fn(),
    },
  };
});

vi.mock('electron', () => ({
  ipcMain: electronMock.ipcMain,
  shell: electronMock.shell,
}));

import { setRootPath } from '../../../src/main/utils/safe-write';
import { NotesService } from '../../../src/main/notes/service';
import { registerNotesIPC } from '../../../src/main/ipc/notes';
import { getFavoritesService } from '../../../src/main/workspace/favorites';
import { computeFileId } from '../../../src/main/notes/path-mapping';
import { IPC } from '../../../src/shared/types';

interface IpcOk<T> {
  ok: boolean;
  data?: T;
  code?: string;
}

const STALE_FM_ID = 'aaaaaaaaaaaaaaaa';

describe('笔记 id 漂移(保存时 fm.id 被重钉)(r192)', () => {
  let root: string;
  let notes: NotesService;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'rkms-iddrift-'));
    setRootPath(root);
    await fs.mkdir(join(root, 'notes'), { recursive: true });
    electronMock.handlers.clear();
    await getFavoritesService().start();
    notes = new NotesService();
  });

  afterEach(async () => {
    await notes.stop();
    await getFavoritesService().stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  /**
   * 落一个 frontmatter id 与路径哈希**不一致**的笔记(模拟「从别的机器
   * 拷来的 .md」/「用户在资源管理器里改过文件名」)。
   */
  async function writeStaleNote(filename: string, body: string): Promise<void> {
    await fs.writeFile(
      join(root, 'notes', filename),
      `---\nid: ${STALE_FM_ID}\ntitle: T\n---\n\n${body}\n`,
      'utf-8',
    );
  }

  it('磁盘 fm.id ≠ 路径哈希 ⇒ 扫描时按 fm.id 载入,保存后返回**新 id**,且旧 id 真的死了', async () => {
    await writeStaleNote('n.md', 'v1');
    await notes.start(); // 全量扫描

    // 扫描后:按磁盘上的 fm.id 载入
    expect(notes.findById(STALE_FM_ID)).toBeTruthy();
    const pathId = computeFileId('n.md');
    expect(pathId).not.toBe(STALE_FM_ID);

    // 保存 ⇒ 主进程把 fm.id 重钉为路径哈希 ⇒ 返回新 id
    const written = await notes.write(STALE_FM_ID, 'v2');
    expect(written.id).toBe(pathId);
    expect(written.id).not.toBe(STALE_FM_ID);

    // 旧 id **真的死了** —— renderer 若还拿着它,下一次自动保存必 NOT_FOUND
    expect(notes.findById(STALE_FM_ID)).toBeNull();
    expect(notes.findById(pathId)).toBeTruthy();

    // 磁盘上的 fm.id 也已经是新 id(下次读不会又漂一次)
    const raw = await fs.readFile(join(root, 'notes', 'n.md'), 'utf-8');
    expect(raw).toContain(`id: ${pathId}`);
  });

  it('走 IPC 保存(真实链路)⇒ 收藏(★)跟着改,不会在保存成功的瞬间静默消失', async () => {
    await writeStaleNote('n.md', 'v1');
    await notes.start();

    const fav = getFavoritesService();
    // 用户给这篇点了 ★(renderer 存的是当前 id = 磁盘 fm.id)
    await fav.toggle(STALE_FM_ID, { title: 'n.md', relPath: 'n.md' });

    registerNotesIPC(notes);
    const handler = electronMock.handlers.get(IPC.NOTES_WRITE);
    expect(handler).toBeTruthy();

    const res = (await handler!(
      {},
      STALE_FM_ID,
      'v2',
      undefined,
      undefined,
    )) as IpcOk<{ id: string; relPath: string }>;
    expect(res.ok).toBe(true);
    const newId = res.data!.id;
    expect(newId).not.toBe(STALE_FM_ID);

    // 收藏条目:fileId 已是新 id,路径形态仍是 relPath(notes 域)
    const entries = fav
      .listEntries()
      .filter((e) => e.kind === 'file')
      .map((e) => ({ fileId: (e as { fileId: string }).fileId, relPath: e.relPath }));
    expect(entries).toHaveLength(1);
    expect(entries[0]!.fileId).toBe(newId);
    expect(entries[0]!.relPath).toBe('n.md');
  });

  it('没有漂移(fm.id 本来就是路径哈希)⇒ id 不变,收藏也不该被无谓改写', async () => {
    await notes.start();
    const created = await notes.create('fresh.md');
    const fav = getFavoritesService();
    await fav.toggle(created.id, { title: 'fresh.md', relPath: 'fresh.md' });

    registerNotesIPC(notes);
    const handler = electronMock.handlers.get(IPC.NOTES_WRITE);
    const res = (await handler!({}, created.id, 'v2', undefined, undefined)) as IpcOk<{
      id: string;
    }>;
    expect(res.ok).toBe(true);
    expect(res.data!.id).toBe(created.id);

    const entries = fav
      .listEntries()
      .filter((e) => e.kind === 'file')
      .map((e) => (e as { fileId: string }).fileId);
    expect(entries).toEqual([created.id]);
  });
});
