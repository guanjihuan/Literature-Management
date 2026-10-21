// tests/unit/main/library-reader-root-guard.test.ts
//
// 守 r191「library:readFileForReader 必须过工作区白名单」契约。
//
// 漏洞(本轮实证):`src/main/ipc/library.ts` 的 handler 只查
//   `requireAbsolutePath`(是不是绝对路径),**不查是否落在工作区内**
//   ⇒ renderer 拿到任意绝对路径就能把字节读回来。
//
//   同威胁模型的两条兄弟路径**都有**白名单,唯独 reader 这条漏了:
//     - rkms:// 协议(protocol.ts)→ assertInsideAllowedRoot → 403
//       (注释原文:「防止 renderer 拿到任意路径都能读(iframe 内
//        fetch().text() 可外泄 ~/.ssh/id_rsa)」)
//     - shell.open-path(ipc/shell.ts)→ assertInsideAllowedRoot → EPERM
//   ⇒ 读侧比 iframe 侧**更松**:一个被注入的 renderer 脚本可以读
//     ~/.ssh/id_rsa / 浏览器 cookie / 任何用户文件,并把字节发出去。
//
//   注:protocol.ts 的 import 注释写着「protocol.ts / shell.ts / reader.ts
//   三处独立写…」—— 以为 reader.ts 也在用同一份 assertInsideAllowedRoot,
//   实际 reader.ts 根本没接 ⇒ 注释与实现的漂移正是本漏洞的来源。
//
// 本测锁:
//   1. 工作区**外**的绝对路径 → 拒绝(ok:false / EPERM),且**不返回任何字节**;
//   2. 工作区**内**的文件 → 照常读出字节(不回归);
//   3. 工作区内的 symlink 指向区外 → 拒绝(白名单的 lstat + realpath 链防线)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const electronMock = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  return {
    handlers,
    ipcMain: {
      handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
        handlers.set(channel, fn);
      },
    },
    shell: { trashItem: vi.fn() },
  };
});

vi.mock('electron', () => ({
  ipcMain: electronMock.ipcMain,
  shell: electronMock.shell,
}));

import { setRootPath } from '../../../src/main/utils/safe-write';
import { registerLibraryIPC } from '../../../src/main/ipc/library';
import { IPC } from '../../../src/shared/types';

interface IpcOk<T> {
  ok: boolean;
  data?: T;
  code?: string;
  message?: string;
}

/** ReadFileForReaderResult —— data / size / mtime(字节在 .data 里)。 */
interface ReadPayload {
  data: Uint8Array;
  size: number;
  mtime: number;
}

describe('library:readFileForReader 的工作区白名单(r191)', () => {
  let root: string;
  let outside: string;

  beforeEach(async () => {
    // 两个**互不相干**的临时目录 —— outside 不在 root 之下
    root = await fs.mkdtemp(join(tmpdir(), 'rkms-reader-root-'));
    outside = await fs.mkdtemp(join(tmpdir(), 'rkms-reader-out-'));
    setRootPath(root);
    electronMock.handlers.clear();
    registerLibraryIPC();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });

  function handler(): (event: unknown, ...args: unknown[]) => unknown {
    const h = electronMock.handlers.get(IPC.LIBRARY_READER_FOR_FILE);
    expect(h).toBeTruthy();
    return h!;
  }

  it('工作区外的文件 → 拒绝,不返回任何字节', async () => {
    const secret = join(outside, 'id_rsa');
    await fs.writeFile(secret, 'PRIVATE-KEY-MATERIAL', 'utf-8');

    const res = (await handler()({}, secret)) as IpcOk<ReadPayload>;
    expect(res.ok).toBe(false);
    expect(res.code).toBe('EPERM');
    // 关键:失败时**不能**带 data(否则报错路径也漏字节)
    expect(res.data).toBeUndefined();
    expect(JSON.stringify(res)).not.toContain('PRIVATE-KEY-MATERIAL');
  });

  it('工作区内的文件 → 照常读出字节(不回归)', async () => {
    const litDir = join(root, 'literature');
    await fs.mkdir(litDir, { recursive: true });
    const file = join(litDir, 'note.txt');
    await fs.writeFile(file, 'hello workspace', 'utf-8');

    const res = (await handler()({}, file)) as IpcOk<ReadPayload>;
    expect(res.ok).toBe(true);
    expect(Buffer.from(res.data!.data).toString('utf-8')).toBe('hello workspace');
    expect(res.data!.size).toBe('hello workspace'.length);
  });

  it('工作区内的 symlink 指向区外 → 拒绝', async () => {
    const litDir = join(root, 'literature');
    await fs.mkdir(litDir, { recursive: true });
    const secret = join(outside, 'id_rsa');
    await fs.writeFile(secret, 'PRIVATE-KEY-MATERIAL', 'utf-8');
    const link = join(litDir, 'link.txt');
    try {
      // Windows 上建 symlink 需要特权(Developer Mode / 管理员)—— 建不出来
      // 就跳过这一条(其余两条已经锁住主契约)。
      await fs.symlink(secret, link, 'file');
    } catch {
      return;
    }

    const res = (await handler()({}, link)) as IpcOk<ReadPayload>;
    expect(res.ok).toBe(false);
    expect(res.code).toBe('EPERM');
    expect(JSON.stringify(res)).not.toContain('PRIVATE-KEY-MATERIAL');
  });
});
