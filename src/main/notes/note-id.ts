// src/main/notes/note-id.ts
//
// audit C3R77 (2026-08-22):scanNotes + readNote 各有一份字面
//   `typeof fm['id'] === 'string' && /^[a-f0-9]{16}$/.test(fm['id']) ? fm['id'] : computeFileId(relPath)`
// 同文件内 ~50 行重复。改一边漏另一边 = "scan 时拿的是 frontmatter id,read 时拿的是
// relPath hash" — 同一个笔记 2 个 ID,silent 数据不一致(收藏夹引用旧 ID,
// 主表 list 跳到新 ID)。
//
// 抽到独立模块后,NOTE_ID_RE + extractNoteId 单一 source-of-truth,改动一次两边生效。
//
// 设计取舍:
//   - 独立模块而不是放进 filename-validator.ts:filename 和 id 是两套独立 schema,
//     文件名允许 CJK/空格/斜杠,ID 只允许 16-char 十六进制,混合放会模糊语义
//   - `fm` 参数用 `Record<string, unknown>`(两个 caller 都在 gray-matter 解析后立即
//     取 `fm['id']`,此时类型还是 unknown,cast 边界保留在 caller)
//   - 不放 path-mapping.ts(computeFileId 所在):那模块是纯路径/ID 计算,无 frontmatter 概念

// audit-r56:library/path-mapping.ts 整体下线 —— 搬到 ./path-mapping(notes 同目录)。
import { computeFileId } from './path-mapping';

/**
 * 笔记 ID 允许形态:16-char 小写十六进制(SHA-256 截前 16 位)。
 * 历史:旧版笔记文件 frontmatter 写有 id 字段(手写或导出兼容),新代码统一由
 * relPath SHA-256 派生。两条路径必须共用同一 regex 才不会产生 2 个 ID 视图。
 */
export const NOTE_ID_RE = /^[a-f0-9]{16}$/;

/**
 * 从 gray-matter frontmatter + relPath 派生稳定 ID。
 * 优先 frontmatter.id(旧兼容),否则由 relPath SHA-256 派生。
 *
 * @param fm     gray-matter 解析后的 frontmatter(`fm['id']` 是 unknown,需 runtime 验证)
 * @param relPath POSIX 风格相对路径(库根目录下)
 */
export function extractNoteId(fm: Record<string, unknown>, relPath: string): string {
  const candidate = fm['id'];
  return typeof candidate === 'string' && NOTE_ID_RE.test(candidate)
    ? candidate
    : computeFileId(relPath);
}
