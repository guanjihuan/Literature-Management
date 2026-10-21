// src/main/ipc/library.ts
//
// IPC.LIBRARY_READER_FOR_FILE handler — 整个 library 频道表面退役后剩下的
// 唯一一条 channel,名字沿用避免 ipc 字符串散落。handler 内部走 library/reader.ts
// 的 readFileForReader(path)。
//
// r191:**读白名单** —— 本 handler 此前只查「是不是绝对路径」,不查「是不是
//   工作区内的文件」⇒ renderer 拿到任意绝对路径就能把字节读回来。
//   同威胁模型的两条兄弟路径**都有**白名单,唯独这条漏了:
//     - rkms:// 协议(protocol.ts)→ assertInsideAllowedRoot → 403
//       (注释原文:「防止 renderer 拿到任意路径都能读(iframe 内
//        fetch().text() 可外泄 ~/.ssh/id_rsa)」)
//     - shell.open-path(ipc/shell.ts)→ assertInsideAllowedRoot → EPERM
//   ⇒ 读侧比 iframe 侧**更松**。protocol.ts 的 import 注释写着
//   「protocol.ts / shell.ts / reader.ts 三处独立写…」—— 以为 reader.ts
//   也在用同一份 assertInsideAllowedRoot,实际 reader.ts 根本没接;
//   这条注释漂移正是本漏洞的来源。
//
// 修法:与 shell.ts / protocol.ts 同款,在 handler 里过
//   assertInsideAllowedRoot(工作区根 + symlink / realpath 链防线)。
//
// 为什么不误伤正常用户:本通道的唯一生产调用点是
//   renderer/Reader.tsx 的 `api.readFileForReader(file.absPath)`,
//   file 是 literature store 的一行 —— 文献导入是**拷贝**进
//   <rootPath>/literature/(literature/import.ts),所以 absPath 恒在
//   工作区内。OS 文件选择器(<input type="file">)只用于**导入**,
//   不用于读;preload 里「路径来自 webUtils.getPathForFile」的旧注释
//   已不成立(见 preload/index.ts 同名注释的 r191 更正)。
import { handle, requireString } from './wrap';
import { IPC } from '../../shared/types';
import { readFileForReader } from '../library/reader';
import { MAX_IPC_PATH_CHARS, requireAbsolutePath } from './path-limits';
import { assertInsideAllowedRoot } from './paths';
import { AppError, errMsg } from '../utils/error';
import { createLogger } from '../utils/logger';
import type { ReadFileForReaderResult } from '../../shared/types';

const log = createLogger('library-ipc');

export function registerLibraryIPC(): void {
  handle<[string], ReadFileForReaderResult>(
    IPC.LIBRARY_READER_FOR_FILE,
    async (_event, raw) => {
      const absPath = requireString(IPC.LIBRARY_READER_FOR_FILE, raw, 'absPath', {
        maxLen: MAX_IPC_PATH_CHARS,
      });
      // audit-r137:与 notes/literature/settings 同源 — 防御 renderer 注入
      // 相对路径(原 bug:requireString 只守 type / 长度,fs.open 按
      // process.cwd() 解析,renderer 注入 '../etc/passwd' 也能拿到 bytes)。
      requireAbsolutePath(absPath, { ipc: IPC.LIBRARY_READER_FOR_FILE, field: 'absPath' });
      // r191:工作区白名单(绝对路径 ≠ 工作区内)—— 挡住 renderer 读工作区
      // 外的任意文件。区外 / symlink 逃逸一律 EPERM。
      // 错误消息**不回显路径**:renderer 不需要知道文件系统布局,main 侧
      // 日志留全路径即可(区分「路径不在工作区」与「工作区还没初始化」)。
      let abs: string;
      try {
        abs = assertInsideAllowedRoot(absPath);
      } catch (err: unknown) {
        const code = err instanceof AppError ? err.code : 'INTERNAL';
        log.warn('reader path rejected by workspace whitelist', { code, absPath });
        // audit-r244:INTERNAL(工作区还没初始化 —— getRootPath() 未 setRootPath)
        //   **≠**「路径在工作区外」。旧实现把**所有**失败一律翻成 EPERM
        //   「file is outside the workspace」⇒ renderer 把「工作区未初始化」
        //   误报成「越界访问」,排查方向完全跑偏(用户看到的提示是假的)。
        //   INTERNAL 走原样上抛(wrap.ts 的 INTERNAL 分支会 scrub 路径)。
        if (code === 'INTERNAL') {
          throw err instanceof AppError ? err : new AppError('INTERNAL', errMsg(err), err);
        }
        throw new AppError('EPERM', 'file is outside the workspace');
      }
      return readFileForReader(abs);
    },
  );
}
