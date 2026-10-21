// 共享文件存在性检查:fs.open → close 单 syscall,无 TOCTOU。
//
// audit 2026-09-21 audit-r24:library.ts:assertFileExists 与 notes.ts:
// NOTES_SHOW_IN_FOLDER inline 重复 ~20 行(都走 fs.open → safeCloseFh →
// 抛 LibraryError FILE_MISSING)。抽到 utils 共享层,改 API/改错误形态
// 只改一处。
//
// 设计要点:
//   - absPath 由 caller 校验(走 requireAbsolutePath + 业务白名单),
//     本 helper 不再二次防御
//   - 错误码统一 FILE_MISSING(与 NOTES_READ 通道保持一致;audit-r78 删
//     「LIBRARY_GET」并列 —— 该通道 r56 已退役,不能作为现行为锚点)
//   - safeCloseFh 走 Windows stale handle EBUSY warn(老实现 swallow 让
//     fd 泄漏信号消失,见 safe-write.ts 注释)
//   - i18n 文案由 caller 在 catch 边界翻译,helper 不依赖任何具体 key,
//     也不重复占位符。典型 caller 模式:tr(key, params) → helper 拼 errno
import { promises as fs } from 'fs';
import { LibraryError, errMsg, errnoCode } from './error';
import { safeCloseFh } from './safe-write';
import type { createLogger } from './logger';

type LoggerLike = ReturnType<typeof createLogger>;

/**
 * 用 fs.open('r') 单 syscall 校验文件存在,不存在抛 LibraryError(FILE_MISSING)。
 *
 * @param absPath 绝对路径(由 caller 校验)
 * @param notFoundMessage 不存在时抛错的 i18n message —— caller 已填好所有占位符,
 *        helper 在 syscall 失败时附加 `(errMsg(err))` 便于排查
 * @param log 模块 logger,用于 safeCloseFh 内部 warn
 */
export async function assertFileExists(
  absPath: string,
  notFoundMessage: string,
  log: LoggerLike,
): Promise<void> {
  if (!absPath) {
    throw new LibraryError('FILE_MISSING', notFoundMessage);
  }
  let fh: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    fh = await fs.open(absPath, 'r');
  } catch (err: unknown) {
    // audit r33 (2026-09-23):旧实现一律 FILE_MISSING —— EACCES / EPERM
    //   / EISDIR 等都被错报成「文件不存在」,UI 端的 toast 让用户以为是临时
    //   状况不停 retry,真实根因(权限、类型错配)被埋没。修法:照 errnoCode()
    //   精确分类 —— ENOENT 才报 FILE_MISSING,EACCES/EPERM 报 IO_ERROR 让
    //   上层 store 能区分并加权限提示。
    //   audit-r96:分类三支(ENOENT / !code → FILE_MISSING,其余 → IO_ERROR)
    //   首补行为锁 tests/unit/main/utils/file-check.test.ts,摘 !code 分支必红。
    const code = errnoCode(err);
    const msg = `${notFoundMessage} (${errMsg(err)})`;
    if (code === 'ENOENT' || !code) {
      throw new LibraryError('FILE_MISSING', msg);
    }
    throw new LibraryError('IO_ERROR', msg);
  } finally {
    if (fh) {
      // audit 2026-09-14:finally close 改 warn —— Windows stale handle 偶发 EBUSY,
      //   旧 swallow 让 fd 泄漏信号消失。
      // audit round 8 (2026-09-14):走 safeCloseFh helper。
      await safeCloseFh(fh, 'fh.close failed in assertFileExists', log, { path: absPath });
    }
  }
}

/**
 * 文件是不是**真的**不在磁盘上了。
 *
 * `existsSync` 把「文件不存在」与「文件读不到」都压成 `false` ⇒ 分不开这两
 * 种情况(而且它**永不 throw**,try/catch 包住它 = 死代码)。本项目对「读
 * 不到」的处置是 fail-safe(r200 settings / r199 收藏 / r210 笔记索引同款
 * 口径):**判不出来 ⇒ 当作还在**。理由是两条路的代价不对等:
 *   - 误判「还在」⇒ 留一个 ghost 行(列表里有一条点进去 NOT_FOUND 的
 *     条目)—— 轻微、可自愈(下次 resync 再清);
 *   - 误判「没了」⇒ 把用户**还在磁盘上**的条目从索引里删掉(列表 / 搜索里
 *     消失,且本轮不会补回)—— 数据可见性损失,用户会以为文件被删了。
 * 所以只有 **ENOENT**(确定的不存在)才算「没了」,其余错误(EACCES /
 * EPERM / EBUSY —— Defender 扫描、OneDrive placeholder、同步盘占用)一律
 * 当作「还在」。
 *
 * 本函数**永不 throw**(stat 的任何错误都被分类掉),caller 不需要也不应该
 * 再包 try/catch。单一真相源:notes(r210 两处)与 literature(r219 两处)
 * 的「删索引行之前再确认一次」全部走这里 —— 凡是「判文件在不在 → 决定
 * 删不删索引行」的场景不许再出现裸 `existsSync`。
 */
export async function isReallyGone(absPath: string): Promise<boolean> {
  try {
    await fs.stat(absPath);
    return false;
  } catch (err: unknown) {
    return errnoCode(err) === 'ENOENT';
  }
}
