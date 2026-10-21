// tests/unit/main/literature-rename.test.ts
//
// 守 r187「文献单文件重命名」契约。
//
// 背景(用户诉求:「相关的文件操作也是对应的」):
//   左侧两个列表的操作集此前**不对应** —— 笔记能右键改名(notes:rename-file),
//   文献不能(literature 域根本没有重命名通道)。用户只能去资源管理器改,
//   改完 app 里还是旧名(直到手动刷新),两侧行为不一致。
//
// 本测锁的契约:
//   1. 改名落盘:文件出现在新路径、旧路径消失、id 随路径变、内存索引换键;
//   2. **撞名不覆盖**(数据丢失红线):Windows 的 fs.rename 在目标已存在时
//      静默替换目标文件(MoveFileExW + MOVEFILE_REPLACE_EXISTING)—— 直接
//      rename 等于把用户另一份同名 PDF 抹掉;
//   3. 不写扩展名 → 沿用原扩展名(pdf/epub/... 多种格式,不能一律 .md);
//   4. 非法文件名(带路径分隔符)→ 拒收,文件原地不动;
//   5. 仅大小写重命名 → 允许(Win32 大小写不敏感,资源管理器能做);
//   6. 改名后收藏(★)跟着走(lit id = 'lit:'+absPath,改名即换 id)。
//
// 真库(electron app.getPath)在测试环境不可用 → resources-repo 整体 mock;
// electron 也 mock(ipcMain.handle 捕获 handler 以验 IPC 接线,shell 兜底)。
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
      trashItem: async (target: string) => {
        const { rename } = await import('fs/promises');
        const { basename, join: j } = await import('path');
        const trashDir = j(target, '..', '..', '.trash');
        await fs.mkdir(trashDir, { recursive: true });
        await rename(target, j(trashDir, basename(target)));
      },
    },
  };
});

vi.mock('electron', () => ({
  ipcMain: electronMock.ipcMain,
  shell: electronMock.shell,
}));

import { setRootPath } from '../../../src/main/utils/safe-write';
import { LiteratureService } from '../../../src/main/literature/literature-service';
import { registerLiteratureIPC } from '../../../src/main/ipc/literature';
import { getFavoritesService } from '../../../src/main/workspace/favorites';
import { IPC } from '../../../src/shared/types';

describe('文献单文件重命名(r187)', () => {
  let root: string;
  let lit: LiteratureService;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'rkms-litrename-'));
    setRootPath(root);
    await fs.mkdir(join(root, 'notes'), { recursive: true });
    await fs.mkdir(join(root, 'literature'), { recursive: true });
    electronMock.handlers.clear();
    repo.upsertResource.mockClear();
    repo.deleteResource.mockClear();
    lit = new LiteratureService();
    await lit.start({ skipInitialLoad: true });
  });

  afterEach(async () => {
    await lit.stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function importPaper(name: string, bytes = 'PDF-BYTES'): Promise<string> {
    const src = join(root, name);
    await fs.writeFile(src, bytes, 'utf-8');
    const imported = await lit.importFile(src);
    return imported.id;
  }

  /** absPath 在库里可能是 OS 原生形态(导入)也可能是 POSIX 形态(搬移)——
   *  断言时统一成正斜杠再比。 */
  const norm = (p: string): string => p.replace(/\\/g, '/');

  it('改名落盘:新路径有文件、旧路径消失、id 变、内存索引换键', async () => {
    const id = await importPaper('paper.pdf');
    // 导入那一步本身会调 upsertResource(写新行)—— 先清掉调用计数,
    // 下面只断言「改名这一步」的 DB 调用。
    repo.upsertResource.mockClear();
    repo.deleteResource.mockClear();
    repo.renameResource.mockClear();
    const renamed = await lit.renameFile(id as never, 'thesis');

    const litDir = join(root, 'literature');
    expect(await fs.readFile(join(litDir, 'thesis.pdf'), 'utf-8')).toBe('PDF-BYTES');
    await expect(fs.lstat(join(litDir, 'paper.pdf'))).rejects.toThrow();
    // id 随路径变(lit id = 'lit:'+posix absPath)
    expect(renamed.id).not.toBe(id);
    expect(norm(renamed.absPath)).toBe(norm(join(litDir, 'thesis.pdf')));
    // 内存索引换键
    expect(lit.findById(id)).toBeNull();
    expect(lit.findById(renamed.id)).not.toBeNull();
    // DB:r196 契约 —— 「upsert 新行 + 删旧行」必须**同事务**
    //   (renameResource),不再是 deleteResource + upsertResource 两个独立
    //   事务。理由:两个事务中间失败 ⇒ DB 里旧行没了、新行没进 ⇒ 这条文献
    //   从列表/搜索里凭空消失,而磁盘没动 ⇒ 无 watcher 事件可自愈。
    expect(repo.renameResource).toHaveBeenCalledWith(
      id,
      expect.objectContaining({ id: renamed.id }),
      '',
      expect.stringContaining('thesis.pdf'),
    );
    // 旧的两个独立事务调用**不许**再出现
    expect(repo.deleteResource).not.toHaveBeenCalled();
    expect(repo.upsertResource).not.toHaveBeenCalled();
  });

  it('撞名不覆盖:目标已存在 → VALIDATION,目标文件内容原封不动', async () => {
    const id = await importPaper('paper.pdf', 'MINE');
    // 同目录再放一个同名目标(直接写盘,绕开 import 的撞名自动改名)
    const litDir = join(root, 'literature');
    await fs.writeFile(join(litDir, 'other.pdf'), 'THEIRS', 'utf-8');

    await expect(lit.renameFile(id as never, 'other')).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    // 目标文件没被覆盖(数据丢失红线)
    expect(await fs.readFile(join(litDir, 'other.pdf'), 'utf-8')).toBe('THEIRS');
    // 源文件也还在原地
    expect(await fs.readFile(join(litDir, 'paper.pdf'), 'utf-8')).toBe('MINE');
  });

  it('不写扩展名 → 沿用原扩展名(literature 有 pdf/epub/... 多种格式)', async () => {
    const id = await importPaper('paper.pdf');
    const renamed = await lit.renameFile(id as never, 'thesis');
    expect(norm(renamed.absPath).endsWith('/thesis.pdf')).toBe(true);
  });

  it('文件名带路径分隔符 → 拒收,文件原地不动(重命名不改位置)', async () => {
    const id = await importPaper('paper.pdf');
    await expect(lit.renameFile(id as never, 'sub/paper.pdf')).rejects.toMatchObject({
      code: 'VALIDATION',
    });
    const litDir = join(root, 'literature');
    expect(await fs.readFile(join(litDir, 'paper.pdf'), 'utf-8')).toBe('PDF-BYTES');
  });

  it('仅大小写重命名 → 允许(Win32 大小写不敏感,资源管理器能做)', async () => {
    const id = await importPaper('paper.pdf');
    const renamed = await lit.renameFile(id as never, 'Paper');
    expect(norm(renamed.absPath).toLowerCase().endsWith('/paper.pdf')).toBe(true);
    expect(lit.findById(renamed.id)).not.toBeNull();
  });

  it('不存在的 id → NOT_FOUND(契约不因本轮改动而松动)', async () => {
    const ghost = 'lit:no-such' as never;
    await expect(lit.renameFile(ghost, 'x')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('IPC 通道 literature:rename-file 存在,且改名后收藏(★)跟着走', async () => {
    const fav = getFavoritesService();
    await fav.start();
    try {
      const id = await importPaper('paper.pdf');
      await fav.toggle(id, { title: 'paper.pdf', relPath: join(root, 'literature', 'paper.pdf') });

      registerLiteratureIPC(lit);
      const handler = electronMock.handlers.get(IPC.LITERATURE_RENAME_FILE);
      expect(handler).toBeTruthy();
      const res = (await handler!({}, id, 'thesis')) as {
        ok: boolean;
        data?: { id: string; absPath: string; oldAbsPath: string };
      };
      expect(res.ok).toBe(true);
      expect(res.data!.id).not.toBe(id);
      expect(res.data!.oldAbsPath).toContain('paper.pdf');

      const entries = fav.listEntries().filter((e) => e.kind === 'file');
      expect(entries).toHaveLength(1);
      expect(entries[0]?.fileId).toBe(res.data!.id);
      expect(entries[0]?.relPath).toContain('thesis.pdf');
    } finally {
      await getFavoritesService().stop();
    }
  });
});
