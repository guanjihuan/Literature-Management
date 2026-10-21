// 通用 shell IPC:渲染层在文件管理器中打开模块数据目录。安全三关——
// 路径必须在白名单根内(rootPath),否则 EPERM;路径必须存在,否则 ENOENT
// (shell.openPath 静默 no-op 让用户困惑);shell.openPath 返非空字符串翻译 EOPEN。
// 不复用 NOTES_SHOW_IN_FOLDER:那个接受 note id 走 revealInOSFileManager
// (Win/Mac showItemInFolder select 语义),这里是"打开目录",语义不同。
// (audit-r77 更正:原注释写 LIBRARY_SHOW_IN_FOLDER —— 该通道已随 r56 库退役
// 删除,现存的同款通道是 notes 域。)
import { promises as fs } from 'fs';
import { shell } from 'electron';
import { IPC } from '../../shared/types';
import { AppError, errMsg, errnoCode } from '../utils/error';
import { handle, requireString } from './wrap';
import { MAX_IPC_PATH_CHARS } from './path-limits';
import { createLogger } from '../utils/logger';

import { assertInsideAllowedRoot } from './paths';

const log = createLogger('shell');

export function registerShellIPC(): void {
  handle<[string], { opened: string }>(IPC.SHELL_OPEN_PATH, async (_e, raw) => {
    // 4096 走 path-limits.ts 共享常量(原本 inline 与其它 4 处分散声明)
    const path = requireString(IPC.SHELL_OPEN_PATH, raw, 'raw', { maxLen: MAX_IPC_PATH_CHARS });

    // 1. 白名单 + 绝对路径解析
    //
    // audit-r229:错误消息**不回显路径** —— 与 ipc/library.ts 同源口径
    //   (r137/r160)。非 INTERNAL 的 code 在 ipc/wrap.ts 里是**原样透传**的
    //   (scrubInternal 只处理 INTERNAL 分支),所以消息里带绝对路径 ⇒
    //   家目录 / OneDrive 目录名进 renderer 与 telemetry。renderer 不需要
    //   知道文件系统布局,main 侧日志留全路径即可(区分「路径不在工作区」
    //   与「路径不可访问」)。
    let abs: string;
    try {
      abs = assertInsideAllowedRoot(path);
    } catch (err: unknown) {
      // EINVAL('path required')不含路径 ⇒ 原样透传;其余(含 EPERM 越界)
      // 一律换成不含路径的文案。
      if (err instanceof AppError && err.code === 'EPERM') {
        log.warn('open-path rejected by workspace whitelist', { path });
        throw new AppError('EPERM', 'path is outside the workspace');
      }
      throw err;
    }

    // 2. 存在性校验:shell.openPath 路径不存在静默失败,提前抛 ENOENT
    // audit-r77 (2026-10-17):探针由 fs.open(abs,'r')+close 改 fs.stat(abs)。
    //   语义修正而非平台 bug(曾疑「POSIX open 目录抛 EISDIR 判死打开目录」,
    //   实证驳回:open(2) 只在写/读写标志抛 EISDIR,O_RDONLY 打开目录三平台
    //   均成功;本机 Windows 含 System32 实测 OK)。换 stat 的真实理由:
    //   - 探针职责是「存在性」,stat 是正语义;open 还额外要求**可读**,权限位
    //     拒绝会被旧探针报成 EACCES/ENOENT 类失败,而 shell.openPath 对同一
    //     路径大概率能正常工作 —— OS 的答案才是权威。
    //   - 单 syscall,去掉 close EBUSY 尾钩(旧代码专为它加了 warn)。
    //   - r33 时代的 EISDIR 分流分支:open(目录,'r') 根本不产 EISDIR、close
    //     也不产 —— 本就是死分支,随 stat 一并删。
    try {
      await fs.stat(abs);
    } catch (err: unknown) {
      // errnoCode 分流到正确码:ENOENT/EACCES/EPERM/ENOTDIR 各归各位,
      // 兜底 IO_ERROR —— 旧实现一律 ENOENT 让权限拒绝用户永远 retry 不好
      //
      // audit-r229:文案不含路径 —— Node 的 fs 错误 message 本身带绝对路径
      //   ("ENOENT: no such file or directory, stat 'C:\Users\…'"),旧的
      //   `${abs} (${errMsg(err)})` 双重回显 ⇒ 家目录进 renderer / telemetry。
      //   完整错误(含路径)只留在 main 侧日志。
      const code = errnoCode(err);
      log.warn('open-path stat failed', { code, abs, detail: errMsg(err) });
      if (code === 'ENOENT') {
        throw new AppError('ENOENT', 'path does not exist');
      }
      if (code === 'EACCES' || code === 'EPERM') {
        throw new AppError('EACCES', 'permission denied');
      }
      if (code === 'ENOTDIR') {
        throw new AppError('EOPEN', 'path component is not a directory');
      }
      throw new AppError('IO_ERROR', 'path not accessible');
    }

    // 3. 系统文件管理器,返非空字符串 = 平台报错
    const err = await shell.openPath(abs);
    if (err) {
      throw new AppError('EOPEN', err);
    }
    return { opened: abs };
  });
}
