// src/main/ipc/path-limits.ts
//
// audit r52 (2026-10-15) C5:常量搬到 `@shared/limits/ipc` 后,本文件保留
//   `requireAbsolutePath` helper(constants 经由 re-export 维持向后兼容,
//   main/ 老 import 路径 `'../ipc/path-limits'` 继续可用)。
//
// 背景:历史上 MAX_*_CHARS / *_BYTES 散在 5+ 文件,一处改大 / 改小别处不跟,
//   IPC 边界契约漂移。r9 (2026-09-15) 先集中到本文件,r52 C5 再搬到 shared。
//
// 单一来源(SSOT):constants 在 `@shared/limits/ipc` 定义,本文件 re-export。
//   未来想消掉 main → shared 的间接层,直接把 main/ 全部 imports 改成
//   `'@shared/limits/ipc'` 即可,本文件可删。
//
// 调整任何上限请读:`@shared/limits/ipc` 对应常量 JSDoc。

export {
  MAX_IPC_PATH_CHARS,
  MAX_NOTE_BODY_BYTES,
  MAX_NOTE_FIELD_CHARS,
  MAX_NOTE_TITLE_CHARS,
  MAX_NOTE_TITLE_BYTES,
  MAX_LIBRARY_IMPORT_BYTES,
  MAX_SETTINGS_BYTES,
  READER_MAX_SIZE_BYTES,
  MAX_LIBRARY_ID_CHARS,
  MAX_SEARCH_QUERY_CHARS,
  MAX_TOAST_MESSAGE_CHARS,
  // audit-r73:删 MAX_EXTRA_IMPORT_ROOTS 转发(源常量随 extraImportRoots
  // 字段退役而移除,无消费者)。
} from '../../shared/limits/ipc';

// ---------------------------------------------------------------------------
// requireAbsolutePath 留在 main/(依赖 main/utils/error 的 ValidationError)。
// ---------------------------------------------------------------------------

import { isAbsolute } from 'path';
import { ValidationError } from '../utils/error';

/**
 * 校验 IPC 字段是绝对路径 —— 否则抛 ValidationError。
 *
 * audit 2026-09-16 r19:M3 — 曾 4 处 inline caller(历史行号,现已收敛,勿按图索骥:
 *   library.ts:113 LIBRARY_CHANGE_PATH
 *   newPath / library.ts:222 LIBRARY_IMPORT_FILES paths[] / notes.ts:217
 *   NOTES_IMPORT_FROM_FILE path / settings.ts:113 SETTINGS_MIGRATE_DATA
 *   newPath)各自 `if (!isAbsolute(...)) throw new ValidationError(...)`,
 *   防御口径相同("防 renderer 注入相对路径,fs 在 cwd 下解析越界")。
 *
 * 抽到 path-limits.ts 让单点改:
 *   - 字段名(`field`)由 caller 注入,错误消息保留 caller 上下文。
 *   - 错误消息格式统一: `${IPC}: field "${field}" must be an absolute path`。
 *
 * 注意:caller 仍然需要先调 requireString(..., { maxLen: MAX_IPC_PATH_CHARS })
 *   守 type / 长度,本函数只补 isAbsolute 这一层。多数 caller 已经在前一行
 *   调了 requireString,组合无额外开销。
 *
 * 实现:用 path.isAbsolute 而非手写正则 —— Node 的 isAbsolute 正确处理
 *   Windows drive letter / UNC / Posix 三种绝对路径形态,正则易漏
 *   UNC '\\?\D:\long\path' 或 Linux `/foo/bar` 等边缘情况。
 */
export function requireAbsolutePath(value: string, options: { ipc: string; field: string }): void {
  if (!isAbsolute(value)) {
    throw new ValidationError(
      `${options.ipc}: field "${options.field}" must be an absolute path`,
      options.field,
    );
  }
}
