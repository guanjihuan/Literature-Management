// src/main/utils/reveal.ts — 跨平台"在文件管理器中显示文件"helper
//
// 集中到共享层是因为同一份 3-way 分支(Win / Mac / Linux)之前在 library.ts
// 与 notes.ts 各写一份,任何漂移(改 API、改日志、改错误形态)只能 grep 兜底,
// 且 Linux 失败路径只有 library.ts 接住 reject,notes.ts 偶发仍是静默 no-op
// (audit 2026-08-26 收口时未对齐)。共享 helper 把行为绑死:
//
//   - Windows / macOS: shell.showItemInFolder (Win32 SHOpenFolderAndSelectItems /
//     NSWorkspace selectFile,最可靠)。Win 上 child_process.spawn('explorer.exe',
//     ['/select,"..."'], ...) 在不少环境下被静默忽略(Node 命令行 quoting + explorer
//     解析在某些路径/会话下不兼容),改用 Electron 官方 API 是推荐做法。
//   - Linux: 无标准 reveal 语义,降级为打开父目录。shell.openPath 在 Linux 上
//     经常返回非空错误字符串(xdg-open 缺失 / dbus 不可用 / 无默认文件管理器),
//     不接住会让用户点了「在文件夹中显示」毫无反应 —— 这里把非空 err 翻译为
//     LibraryError 让 caller 决定走 IPC 错误流。
//
// 注:helper 不做文件存在预检 —— 预检归 caller(notes.ts:204 先过
//   utils/file-check.ts 的 assertFileExists,r24 起两域已收敛到该共享
//   helper,「library.ts:assertFileExists / notes.ts 内联 fs.open」的旧
//   分工已不存在;audit-r124 校正)。共享层只关心"文件存在就怎么 reveal"。

import { dirname } from 'path';
import { shell } from 'electron';
import { LibraryError, errMsg } from './error';

export async function revealInOSFileManager(absPath: string): Promise<void> {
  if (process.platform === 'linux') {
    // Linux: 无标准 reveal 语义,降级为打开父目录
    const openErr = await shell.openPath(dirname(absPath));
    if (openErr) throw new LibraryError('IO_ERROR', `openPath failed: ${openErr}`);
    return;
  }
  // Windows / macOS - 走官方 API;caller 的 assertFileExists 已经保证文件存在
  shell.showItemInFolder(absPath);
}

/**
 * Wrap revealInOSFileManager 抛错 → IPC 错误流。
 * notes.ts 旧实现把非 Linux 路径吞掉,Mac/Linux 上次抛错静默,这里统一 catch
 * 后转 IO_ERROR,行为与 library.ts 收口对齐。
 */
export async function revealInOSFileManagerSafe(absPath: string): Promise<void> {
  try {
    await revealInOSFileManager(absPath);
  } catch (err: unknown) {
    if (err instanceof LibraryError) throw err;
    throw new LibraryError('IO_ERROR', errMsg(err));
  }
}
