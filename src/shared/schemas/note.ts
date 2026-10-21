// src/shared/schemas/note.ts
//
// Zod schemas for StandaloneNote 及其 summary 派生。
//
// r50 (2026-10-15) 适配:
//   - relPath 字段共享 IPC path cap —— audit-r91 起 schema 层直接 import
//     MAX_IPC_PATH_CHARS(此前注释宣称「共享」实为字面量拷贝,改常量那天
//     Zod 与 requireString 静默分叉)。长度防御现为双保险:schema max 与
//     main/ipc requireString 同引同一常量。
//   - .strict() 拒绝多余字段(renderer 偷偷加 `encrypted: true` 立刻 INVALID_INPUT)。

import { z } from 'zod';
// audit-r91:长度上限引用 SSOT,不再写死字面量(r9/r52 集中常量的动机
// ——「一处改大改小别处不跟」——对 schema 层同样成立)。
import { MAX_IPC_PATH_CHARS, MAX_NOTE_FIELD_CHARS } from '../limits/ipc';

/**
 * StandaloneNote —— 笔记文件的 in-memory 形态。
 *
 * 注意:`body` 字段不进 schema —— 笔记 body 可能 5MB,IPC 边界 Zod 校验代价
 * 不菲(整字符串遍历),body 字段由 ipc/notes.ts 的 requireString({ maxBytes:
 * MAX_NOTE_BODY_BYTES }) 守,不走 Zod。summary 不含 body,自然无此顾虑。
 */
export const ZodNoteSummary = z
  .object({
    id: z.string(),
    relPath: z.string().max(MAX_IPC_PATH_CHARS),
    filename: z.string().max(MAX_NOTE_FIELD_CHARS),
    title: z.string().nullable(),
    tags: z.array(z.string()).nullable(),
    mtime: z.number().int().nonnegative(),
  })
  .strict();

/**
 * StandaloneNote 完整形态(含 body)。仅在 IPC handler 真正读笔记时校验,
 * NOT for NOTES_LIST(NOTES_LIST 返 summary,5k 文件 body 数组走 Zod 会爆)。
 */
export const ZodStandaloneNote = z
  .object({
    id: z.string(),
    relPath: z.string().max(MAX_IPC_PATH_CHARS),
    filename: z.string().max(MAX_NOTE_FIELD_CHARS),
    title: z.string().nullable(),
    tags: z.array(z.string()).nullable(),
    mtime: z.number().int().nonnegative(),
    body: z.string(),
  })
  .strict();
