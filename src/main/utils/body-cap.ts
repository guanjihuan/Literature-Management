// 笔记 / Markdown body 读统一入口 — audit r47 (2026-10-15) M5。
//
// 契约:任何在 src/main/** 读 .md / 笔记 body 的代码必须走本文件(或
//   notes/standalone.ts:parseNoteFile 的块读 + 早 abort 路径,
//   后者是 scan hot path 的特化,见 standalone.ts:140-148 注释)。
//   grep 守卫:tests/unit/main/lint/no-direct-body-read.test.ts
//   扫 `fs.readFile(` + `.md` 路径,除本文件与 standalone.ts 之外
//   全部 fail。
//
// 为什么有 TOCTOU 问题(规范问题):fs.stat + fs.readFile 两步走法,
//   stat / read 间存在时间窗口,AV 隔离 / OneDrive 重水合 / 用户
//   atomic-rename 都可能把文件换成 1GB+ 大文件,5MB 上限失效,主进程 OOM。
//   本实现用单 fd 拿 stat + read,缩小窗口;更严的 scan hot path
//   在 standalone.ts:parseNoteFile(块读 + 字节累计 + 早 abort)。
//
// cap 默认值 = MAX_NOTE_BODY_BYTES(5MB),调用方可按需调低(例如搜索 snippet
//   只需 16KB)。
import { open } from 'node:fs/promises';
import { AppError } from './error';
import { MAX_NOTE_BODY_BYTES } from '../ipc/path-limits';
import { createLogger } from './logger';
import { safeCloseFh } from './safe-write';

const log = createLogger('body-cap');

/**
 * 读文件 body,size 超过 cap 抛 AppError('TOO_LARGE')。
 *
 * @param abs 绝对路径
 * @param cap 上限,默认 MAX_NOTE_BODY_BYTES(5MB)
 * @returns utf-8 字符串
 * @throws AppError(TOO_LARGE) 超过上限
 * @throws Error 其他 fs 错误(open / read 失败)
 *   audit-r124:close 失败不再 throw —— 旧实现裸 `await fh.close()` 在
 *   finally 里,EBADF 等 close 错误会把已成功的 read 结果整体替换掉(真数据
 *   丢失假象),更会把 TOO_LARGE 的准确错因掩盖成 close 错。改走 safe-write
 *   的 safeCloseFh:warn 落日志,fd 泄漏由进程退出兜底(单 fd 生命周期内
 *   close 失败极罕见,宁可丢一个 fd 不可错报内容)。
 */
export async function readBodyWithCap(abs: string, cap = MAX_NOTE_BODY_BYTES): Promise<string> {
  const fh = await open(abs, 'r');
  try {
    const stat = await fh.stat();
    if (stat.size > cap) {
      throw new AppError('TOO_LARGE', `${abs}: ${stat.size} > ${cap}`);
    }
    return await fh.readFile({ encoding: 'utf8' });
  } finally {
    await safeCloseFh(fh, 'body-cap: fh close failed', log, { path: abs });
  }
}
