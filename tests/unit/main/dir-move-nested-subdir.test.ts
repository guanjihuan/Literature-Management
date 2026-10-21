// tests/unit/main/dir-move-nested-subdir.test.ts
//
// 守 r188「Windows 上重命名 / 搬移一个**含子目录**的文件夹」契约。
//
// 根因(本机实证,chokidar 4 + Windows 11 —— 见 utils/watcher-release.ts 头注):
//   chokidar 用 fs.watch(ReadDirectoryChangesW)递归监听目录树,对**每个**
//   被监听的目录持有一个 OS 句柄。Windows 拒绝重命名一个**内部存在打开
//   句柄**的目录 ⇒ 只要待搬动的目录里还有子目录(chokidar 正监听着它),
//   fs.rename 必然 EPERM。
//
//   四格对照实验:
//     无 watcher + 扁平子结构 → rename OK
//     无 watcher + 含子目录   → rename OK
//     有 watcher + 扁平子结构 → rename OK
//     有 watcher + 含子目录   → rename **EPERM**  ← 旧行为
//
// 既有退避重试(retryOnWindowsTransient,5 次 / ~750ms)救不了:句柄是
// **长期**的(chokidar 一直在监听那个子目录),不是 Defender 那种瞬时占用。
//
// 修法:物理搬目录前关掉 watcher(释放全部目录句柄),搬完重建。
//
// 本测锁:
//   1. notes 域:重命名一个含子目录的文件夹 → 成功,磁盘结构对,子树里
//      每个笔记的 id 跟着重算;
//   2. literature 域:重命名 + 跨目录搬移,同款;
//   3. **watcher 仍然活着** —— 搬完之后在**新位置**建文件,服务仍能感知
//      (修 EPERM 靠的是「关掉再重建」,若重建失败/不重建,监听就永久
//      丢了 —— 外部改动再也进不来,而且没有任何报错);
//   4. 扁平目录(无子目录)仍然能改名 —— 不回归。
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
  ipcMain: { handle: vi.fn() },
  shell: {
    trashItem: vi.fn(),
    showItemInFolder: vi.fn(),
  },
}));

import { setRootPath } from '../../../src/main/utils/safe-write';
import { LiteratureService } from '../../../src/main/literature/literature-service';
import { NotesService } from '../../../src/main/notes/service';

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 8000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return predicate();
}

describe('含子目录的文件夹改名 / 搬移(r188)', () => {
  let root: string;
  let lit: LiteratureService;
  let notes: NotesService;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'rkms-dirmove-'));
    setRootPath(root);
    await fs.mkdir(join(root, 'notes'), { recursive: true });
    await fs.mkdir(join(root, 'literature'), { recursive: true });
    lit = new LiteratureService();
    notes = new NotesService();
    await lit.start({ skipInitialLoad: true });
    await notes.start({ skipInitialLoad: true });
  });

  afterEach(async () => {
    await notes.stop();
    await lit.stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('notes:重命名含子目录的文件夹 → 成功,子树里每个笔记的 id 跟着重算', async () => {
    await fs.mkdir(join(root, 'notes', 'sub', 'deep'), { recursive: true });
    const top = await notes.create('n.md');
    await notes.moveFile(top.id, 'sub');
    const deep = await notes.create('n2.md');
    await notes.moveFile(deep.id, 'sub/deep');

    const res = await notes.renameDir('sub', 'renamed');
    expect(res.relPath).toBe('renamed');

    // 磁盘结构:整棵子树跟着走
    const entries = await fs.readdir(join(root, 'notes', 'renamed', 'deep'));
    expect(entries).toContain('n2.md');
    expect(await fs.stat(join(root, 'notes', 'renamed', 'n.md')).then(() => true)).toBe(true);
    // 旧位置没了
    expect(await fs.stat(join(root, 'notes', 'sub')).then(() => true, () => false)).toBe(false);

    // 子树里两个笔记的 id 都重算了(路径绑定 id)
    const relPaths = notes.list().map((n) => n.relPath).sort();
    expect(relPaths).toEqual(['renamed/deep/n2.md', 'renamed/n.md']);
    const ids = notes.list().map((n) => n.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids).not.toContain(top.id);
    expect(ids).not.toContain(deep.id);
  });

  it('notes:跨目录搬移含子目录的文件夹 → 成功', async () => {
    await fs.mkdir(join(root, 'notes', 'sub', 'deep'), { recursive: true });
    await fs.mkdir(join(root, 'notes', 'arch'), { recursive: true });
    const n = await notes.create('n.md');
    await notes.moveFile(n.id, 'sub/deep');

    const res = await notes.moveDir('sub', 'arch');
    expect(res.relPath).toBe('arch/sub');
    expect(
      await fs.stat(join(root, 'notes', 'arch', 'sub', 'deep', 'n.md')).then(() => true),
    ).toBe(true);
    expect(notes.list().map((x) => x.relPath)).toEqual(['arch/sub/deep/n.md']);
  });

  it('literature:重命名含子目录的文件夹 → 成功,子树里每个文献的 id 跟着重算', async () => {
    await fs.mkdir(join(root, 'literature', 'sub', 'deep'), { recursive: true });
    const src = join(root, 'paper.pdf');
    await fs.writeFile(src, 'PDF-BYTES', 'utf-8');
    const imported = await lit.importFile(src);
    const moved = await lit.moveFile(imported.id, 'sub/deep');

    const res = await lit.renameDir('sub', 'renamed');
    expect(res.relPath).toBe('renamed');
    expect(res.idRemap).toHaveLength(1);
    expect(res.idRemap[0]!.oldId).toBe(moved.id);
    expect(res.idRemap[0]!.newId).not.toBe(moved.id);

    const entries = await fs.readdir(join(root, 'literature', 'renamed', 'deep'));
    expect(entries).toContain('paper.pdf');
    expect(lit.list().map((r) => r.relPath)).toEqual(['renamed/deep/paper.pdf']);
  });

  it('literature:跨目录搬移含子目录的文件夹 → 成功', async () => {
    await fs.mkdir(join(root, 'literature', 'sub', 'deep'), { recursive: true });
    await fs.mkdir(join(root, 'literature', 'arch'), { recursive: true });
    const src = join(root, 'paper.pdf');
    await fs.writeFile(src, 'PDF-BYTES', 'utf-8');
    const imported = await lit.importFile(src);
    await lit.moveFile(imported.id, 'sub/deep');

    const res = await lit.moveDir('sub', 'arch');
    expect(res.relPath).toBe('arch/sub');
    expect(
      await fs.stat(join(root, 'literature', 'arch', 'sub', 'deep', 'paper.pdf')).then(
        () => true,
      ),
    ).toBe(true);
    expect(lit.list().map((r) => r.relPath)).toEqual(['arch/sub/deep/paper.pdf']);
  });

  it('搬完之后 watcher 仍然活着:新位置里新建的文件能被感知', async () => {
    await fs.mkdir(join(root, 'notes', 'sub', 'deep'), { recursive: true });
    const n = await notes.create('n.md');
    await notes.moveFile(n.id, 'sub/deep');

    await notes.renameDir('sub', 'renamed');

    // 修 EPERM 靠的是「关掉 watcher 再重建」—— 若重建不生效,监听就
    // 永久丢了:外部在**新位置**建文件,服务再也感知不到,而且**没有任何
    // 报错**(静默失聪比报错更难查)。
    await fs.writeFile(join(root, 'notes', 'renamed', 'deep', 'new.md'), '# new\n', 'utf-8');
    const seen = await waitFor(() =>
      notes.list().some((x) => x.relPath === 'renamed/deep/new.md'),
    );
    expect(seen, '重建后的 watcher 应仍能感知新位置的文件新增').toBe(true);
  });

  it('扁平目录(无子目录)仍然能改名 —— 不回归', async () => {
    await fs.mkdir(join(root, 'notes', 'flat'), { recursive: true });
    const n = await notes.create('n.md');
    await notes.moveFile(n.id, 'flat');

    const res = await notes.renameDir('flat', 'renamed');
    expect(res.relPath).toBe('renamed');
    expect(notes.list().map((x) => x.relPath)).toEqual(['renamed/n.md']);
  });
});
