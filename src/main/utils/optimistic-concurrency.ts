// src/main/utils/optimistic-concurrency.ts
//
// 乐观并发控制 helper —— 共享给所有「主进程写之前比对 mtime」场景,避免
// 三个 handler (NOTES_WRITE / SETTINGS_UPDATE / LIBRARY_IMPORT_PATHS) 各自
// inline 一段相同 mtime 比对逻辑导致漂移。
//
// 背景:之前的 writeNote 已经引入 expectedMtime(2026-10-08),用于防 OneDrive /
// Vim / 外部 git pull 等场景下「用户保存时文件已经被外部改过」被静默覆盖。
// r53 (2026-10-16) 把它从 notes 专属扩到 settings + library import 两条写路径。
//
// 设计要点:
//   - assertNoConflict(actual, expected?) → expected 缺省时**直接放行**(向后兼容
//     老 caller:旧 renderer / 早期 IPC 不带 expectedMtime 的请求正常过),不等
//     于「关闭并发检查」—— 仅表示 caller 主动放弃比对。
//   - 不一致时抛 AppError('CONFLICT', ...) —— 已有 IPC_ERROR_CODES tuple 收
//     CONFLICT(r50 加入),wrap.ts 透传到 renderer,UI 走专用冲突路径。
//   - 不在此处理 mtime 解析(读文件 stat / 读 DB mtime 列)—— 那是 caller 的
//     责任,本 helper 只做「两个数是否一致」的纯函数判定,便于单测(无 fs 依赖)。
import { AppError } from './error';

/**
 * 乐观并发比对:actual 是当前主进程读到的资源 mtime(milliseconds,整数),
 * expected 是 renderer 写请求里带回的「我读时的 mtime」快照。两者一致即放行,
 * 不一致抛 CONFLICT。
 *
 * @param actual  当前主进程读到的 mtime(ms)。NaN / Infinity 由 caller 自行校验。
 * @param expected renderer 回带的快照。undefined 表示 caller 主动跳过比对
 *                  (向后兼容老 IPC —— 不带 expectedMtime 的请求正常过)。
 */
export function assertNoConflict(actualMtime: number, expected?: number): void {
  if (expected === undefined) return;
  if (actualMtime !== expected) {
    throw new AppError('CONFLICT', `mtime mismatch: expected=${expected} actual=${actualMtime}`);
  }
}
