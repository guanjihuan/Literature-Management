// src/shared/schemas/favorites.ts
//
// Favorites (★) 文件 + entry 的 Zod schemas —— 给 favorites IPC 边界
// 校验 + favorites.md 启动加载用。
//
// r50 (2026-10-15):favorites 分组 read-only,无 create/edit/delete UI
// (workspace-unification 备注)—— schema 仍提供完整 group/file union,虽然
// 当前不会写 group,保留 schema 等 V2.0 加管理功能时不必再设计。
//
// schemaVersion 字段:z.literal(1) 锁住版本号,favorites 文件结构变更时必须
// 升 2 而非改 1 —— 启动加载路径见到 schemaVersion !== 1 走 migration v1→v2。
//
// audit r55 (2026-10-16):时间戳字段从 z.number() 修正为 z.string()。
//   初版(r51)把 addedAt/createdAt/updatedAt 写成 number(epoch),但 wire
//   真相是 ISO string —— src/main/workspace/favorites.ts 写入侧
//   `addedAt/updatedAt: new Date().toISOString()`(audit-r103:原引
//   「favorites.ts:144」行号已漂且文件名歧义,改语义锚),
//   normalizeEntry 的 asIsoString 也按 string 处理,types.ts:442/451-452 的
//   FavoritesFileEntry/FavoritesGroupEntry 同样声明 string。r51 时这些 schema
//   没接到 handleZod(旧 handle 不做 Res 校验)所以漂移没人发现;r54 I4 把
//   FAVORITES_GET_STATE 接上 handleZod 后类型立即报红。以 wire 真相为准修
//   schema,不改 service(避免 favorites.md 格式迁移)。
// audit-r211:FAVORITES_GET_STATE 通道整对下线(空壳:renderer 全域零调用点,
//   且与 FAVORITES_LIST 同源同形)⇒ 本文件这两个 schema 目前未接线;
//   本段记录保留 —— 它说明「schema 必须以 wire 真相为准」这条约束的由来。

import { z } from 'zod';
// audit-r91:relPath 上限引 SSOT(见 limits/ipc MAX_IPC_PATH_CHARS 头注)。
import { MAX_IPC_PATH_CHARS } from '../limits/ipc';

// wire 上的时间戳一律是 ISO 8601 string(见文件头注 r55 修正记录)。
// 不用 z.string().datetime():asIsoString 的容忍度比 datetime() 宽(允许
// 无毫秒 / 带 offset),normalize 后的输出恒为合法 ISO,但 IPC Res 校验
// 只需要跟 types.ts 的 string 契约对齐,不再加额外收紧。
const ZodIsoTimestamp = z.string();

export const ZodFavoritesFileEntry = z
  .object({
    kind: z.literal('file'),
    id: z.string(),
    fileId: z.string(),
    title: z.string().min(1),
    relPath: z.string().min(1).max(MAX_IPC_PATH_CHARS),
    addedAt: ZodIsoTimestamp,
  })
  .strict();

export const ZodFavoritesGroupEntry = z
  .object({
    kind: z.literal('group'),
    id: z.string(),
    name: z.string().min(1),
    description: z.string(),
    items: z.array(ZodFavoritesFileEntry),
    createdAt: ZodIsoTimestamp,
    updatedAt: ZodIsoTimestamp,
  })
  .strict();

export const ZodFavoritesFile = z
  .object({
    schemaVersion: z.literal(1),
    entries: z.array(z.union([ZodFavoritesFileEntry, ZodFavoritesGroupEntry])),
    updatedAt: ZodIsoTimestamp,
  })
  .strict();
