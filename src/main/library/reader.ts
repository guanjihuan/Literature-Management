// 按 path 读 bytes + size + mtime 给 renderer(reader 走 rkms:// iframe 单文件流)。
// r191 更正:旧注释说「Renderer 走 <input type="file"> + webUtils.getPathForFile()
// 拿 OS picker 绝对路径」—— **已不成立**:OS 选择器只用于导入(拷贝进工作区),
// 本模块的唯一调用方是 ipc/library.ts 的 handler,而它自 r191 起先把路径过
// 工作区白名单(assertInsideAllowedRoot)再进这里 ⇒ 到达本函数的 path 必在
// <rootPath> 内。
// 失败抛 LibraryError 让 wrap.ts 收口为 {ok:false, code, message, size?}。
import { promises as fs } from 'fs';
import { errnoCode, errMsg, LibraryError } from '../utils/error';
import { tr } from '../i18n';
import { createLogger } from '../utils/logger';
import { READER_MAX_SIZE_BYTES } from '../ipc/path-limits';
import { safeCloseFh } from '../utils/safe-write';
import type { ReadFileForReaderResult } from '../../shared/types';

const log = createLogger('library-reader');

export async function readFileForReader(absPath: string): Promise<ReadFileForReaderResult> {
  if (typeof absPath !== 'string' || absPath.length === 0) {
    throw new LibraryError('VALIDATION', tr('library.fileMissing'));
  }
  let fh: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    fh = await fs.open(absPath, 'r');
    const st = await fh.stat();
    if (!st.isFile()) {
      throw new LibraryError('IO_ERROR', tr('library.notAFile'));
    }
    if (st.size > READER_MAX_SIZE_BYTES) {
      throw new LibraryError('TOO_LARGE', tr('library.fileTooLarge'), undefined, st.size);
    }
    const data = await fh.readFile();
    return { data, size: st.size, mtime: st.mtimeMs };
  } catch (e: unknown) {
    if (e instanceof LibraryError) throw e;
    const code = errnoCode(e);
    if (code === 'ENOENT') {
      throw new LibraryError('NOT_FOUND', tr('library.fileMoved'));
    }
    if (code === 'EACCES') {
      throw new LibraryError('EACCES', tr('library.noPermission'));
    }
    throw new LibraryError('IO_ERROR', errMsg(e));
  } finally {
    await safeCloseFh(fh, 'fh.close failed in reader finally', log, { path: absPath });
  }
}
