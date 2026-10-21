// src/shared/schemas/ipc.ts
//
// r50 (2026-10-15) IPC 边界 Zod schemas —— 每个 invoke channel 一个
// Zod*Req / Zod*Res pair,src/main/ipc/wrap.ts 的新签名 handle<Req, Res>
// (channel, schemaReq, schemaRes, fn) 用它们校验。
//
// 阶段选择(audit-r124 时态校正,原注「完整 38 个迁移到 r52+」是未兑现的
// 计划):实测 handleZod 调用点至今仅 1 个 —— bootstrap.ts 的 APP_BOOTSTRAP
// (audit-r211:原第 2 个调用点 workspace.ts 的 FAVORITES_GET_STATE 随该通道
// 整对下线);其余全部 channel 仍走旧 handle<TArgs, TRet>(兼容性 shim)。
// 所谓「重点覆盖 SETTINGS_GET / APP_BOOTSTRAP / NOTES_LIST」只有
// APP_BOOTSTRAP 真正接线,另两族 schema 是 r51 按「边界锁脚手架」写就的
// 未接线件 —— 新增字段时 schema 会立刻 mismatch 挡在测试面,但运行时校验
// 并不生效(接线时再逐个接上)。
//
// Req 字段约定:
//   - 空 args channel → ZodVoidReq = z.void() (无参数)
//   - 单 string id   → ZodStringReq = z.tuple([z.string().max(...)])
//   - 单 object      → ZodObjectReq = z.object({...}).strict()
//
// Res 字段约定:strict 收紧(与 settings/note 同款),renderer 收到
// 不在 schema 内的字段会触发 wrap.ts 「response schema mismatch」分支
// 返回 INTERNAL —— 防止主进程悄悄改返回结构 renderer 没察觉。
//
// audit-r56:删 ZodLibraryListReq / ZodLibraryListRes / ZodLibraryScanProgressGetStateReq
//   / ZodLibraryScanProgressGetStateRes / ZodLibraryMigrationGetStateReq /
//   ZodLibraryMigrationGetStateRes / ZodScanErrorSummary / ZodScanSummary ——
//   library 整体退役,IPC 边界不再有 library 通道。ZodWorkspacePaths 删
//   library 字段(WorkspacePaths 类型已无 library)。ZodStartupGetStateRes
//   删 library phase + progress event。

import { z } from 'zod';
// audit-r91:长度上限全部引 SSOT limits/ipc,不再写死字面量拷贝
// (r9/r52 集中常量的动机对 schema 层同样成立:改常量那天裸拷贝会静默分叉)。
import {
  MAX_IPC_PATH_CHARS,
  MAX_NOTE_FIELD_CHARS,
  MAX_NOTE_TITLE_CHARS,
  MAX_SEARCH_QUERY_CHARS,
} from '../limits/ipc';
import { ZodAppSettings } from './settings';
import { ZodNoteSummary, ZodStandaloneNote } from './note';
import { ZodFavoritesFileEntry } from './favorites';

// ===== Bootstrap =====

/** APP_BOOTSTRAP 无参数;settings + paths 走 ZodAppSettings / ZodWorkspacePaths。 */
export const ZodBootstrapReq = z.void();

export const ZodWorkspacePaths = z
  .object({
    root: z.string(),
    notes: z.string(),
    favorites: z.string(),
  })
  .strict();

export const ZodBootstrapRes = z
  .object({
    settings: ZodAppSettings,
    paths: ZodWorkspacePaths,
  })
  .strict();

// ===== Settings =====

/** SETTINGS_GET 无参数。 */
export const ZodSettingsGetReq = z.void();
export const ZodSettingsGetRes = ZodAppSettings;

/** SETTINGS_UPDATE:接收 Partial<AppSettings>(settings.ts 走 sanitizeSettingsPatch 剥脏)。 */
export const ZodSettingsUpdateReq = z.record(z.string(), z.unknown());
export const ZodSettingsUpdateRes = ZodAppSettings;

// ===== Notes =====

/** NOTES_LIST 无参数,返 summary 数组。 */
export const ZodNotesListReq = z.void();
export const ZodNotesListRes = z.array(ZodNoteSummary);

/** NOTES_READ:单个 id (16 hex chars,shared/types)。 */
export const ZodNotesReadReq = z.tuple([z.string().max(MAX_NOTE_FIELD_CHARS)]);
export const ZodNotesReadRes = ZodStandaloneNote;

/** NOTES_WRITE:args = [id, body, title?, expectedMtime?]。 */
export const ZodNotesWriteReq = z.tuple([
  z.string().max(MAX_NOTE_FIELD_CHARS),
  z.string(),
  z.string().max(MAX_NOTE_TITLE_CHARS).optional(),
  z.number().int().nonnegative().optional(),
]);
export const ZodNotesWriteRes = ZodStandaloneNote;

/** NOTES_CREATE:args = [filename]。 */
export const ZodNotesCreateReq = z.tuple([z.string().max(MAX_NOTE_FIELD_CHARS)]);
export const ZodNotesCreateRes = ZodStandaloneNote;

/** NOTES_TRASH:args = [id]。 */
export const ZodNotesTrashReq = z.tuple([z.string().max(MAX_NOTE_FIELD_CHARS)]);
export const ZodNotesTrashRes = z.void();

// ===== Favorites =====

/** FAVORITES_TOGGLE:args = [fileId, info?: { title?, relPath? }]。 */
export const ZodFavoritesToggleReq = z.tuple([
  // audit-r137:fileId 上限从 MAX_NOTE_FIELD_CHARS (256) 改 MAX_IPC_PATH_CHARS —
  //   literature fileId 形态是 'lit:' + absPath,深层路径超 256 直接被 Zod
  //   拒为「INVALID_INPUT」,深层文献无法收藏。注释自承「已改」是误,本次真改。
  z.string().max(MAX_IPC_PATH_CHARS),
  z
    .object({
      title: z.string().max(MAX_NOTE_TITLE_CHARS).optional(),
      relPath: z.string().max(MAX_IPC_PATH_CHARS).optional(),
    })
    .optional(),
]);
export const ZodFavoritesToggleRes = z.object({
  favorited: z.boolean(),
  fileId: z.string(),
});

/** FAVORITES_LIST:无参数,返 FavoritesFileEntry[] —— audit r54 (2026-10-16) I6
 *  从 FavoritesEntry[] (union) 收紧到 FavoritesFileEntry[],与 IPC handler filter
 *  对齐(group entry 无 renderer caller,留 FavoritesGroupEntry 给 normalizeEntries 内部用)。 */
export const ZodFavoritesListReq = z.void();
export const ZodFavoritesListRes = z.array(ZodFavoritesFileEntry);

// ===== Search =====

/** SEARCH_QUERY:args = [query: string]。 */
export const ZodSearchQueryReq = z.tuple([z.string().max(MAX_SEARCH_QUERY_CHARS)]);
export const ZodSearchQueryRes = z.array(
  z
    .object({
      kind: z.enum(['file', 'note']),
      id: z.string(),
      relPath: z.string().max(MAX_IPC_PATH_CHARS),
      title: z.string().nullable(),
      snippet: z.string(),
      score: z.number(),
    })
    .strict(),
);

// ===== Startup / Bootstrap / Window / Shell / Menu =====

/** STARTUP_GET_STATE:无参数,返 StartupProgressSnapshot。
 *  audit-r56:删 'library' phase —— library service 整体下线,启动期无
 *  library 扫描进度;同步删 currentPhase enum 的 'library' 项。 */
export const ZodStartupGetStateReq = z.void();
export const ZodStartupGetStateRes = z
  .object({
    done: z.boolean(),
    startedAt: z.number().int().nullable(),
    currentPhase: z.enum(['notes', 'notes-resync', 'literature', 'finalizing']).nullable(),
    phases: z.object({
      notes: z.object({
        state: z.enum(['pending', 'running', 'done']),
        count: z.number().int().nonnegative().optional(),
        total: z.number().int().nonnegative().optional(),
        error: z.string().optional(),
      }),
      'notes-resync': z.object({
        state: z.enum(['pending', 'running', 'done']),
        count: z.number().int().nonnegative().optional(),
        total: z.number().int().nonnegative().optional(),
        error: z.string().optional(),
      }),
      // audit-r147 (2026-10-19) HIGH:补齐 literature phase。
      //   StartupProgressSnapshot.phases.literature 早在 r136 就加了,
      //   但 ZodStartupGetStateRes 的 currentPhase enum 与 phases object
      //   漏同步 —— schema 仍按 r56 删 library 后的 3 phase 形态。
      //   当前 main/ipc/startup.ts:10 仍走 handle<...,StartupProgressSnapshot>
      //   不接 handleZod,bug 是 dormant;若谁照 r56 favorites 模式接
      //   handleZod,18s literature rescan 期间 StartupOverlay 卡死。
      literature: z.object({
        state: z.enum(['pending', 'running', 'done']),
        count: z.number().int().nonnegative().optional(),
        total: z.number().int().nonnegative().optional(),
        error: z.string().optional(),
      }),
      finalizing: z.object({
        state: z.enum(['pending', 'running', 'done']),
        count: z.number().int().nonnegative().optional(),
        total: z.number().int().nonnegative().optional(),
        error: z.string().optional(),
      }),
    }),
    lastError: z.string().nullable(),
  })
  .strict();

/** WINDOW_IS_MAXIMIZED:无参数,返 boolean。 */
export const ZodWindowIsMaximizedReq = z.void();
export const ZodWindowIsMaximizedRes = z.boolean();

/** SHELL_OPEN_PATH:args = [raw: string],返 { opened: string }。 */
export const ZodShellOpenPathReq = z.tuple([z.string().max(MAX_IPC_PATH_CHARS)]);
export const ZodShellOpenPathRes = z.object({ opened: z.string() });

/** WORKSPACE_GET_PATHS:无参数,返 WorkspacePaths。 */
export const ZodWorkspaceGetPathsReq = z.void();
export const ZodWorkspaceGetPathsRes = ZodWorkspacePaths;

// ===== Pull-snapshot (r54 I4) =====
//
// 每个 GET_STATE handler 返「push 通道最近一次 emit 的状态」的浅拷贝 snapshot,
// 让 renderer 在 mount 时主动拉一次填补「主进程 push 已先于 listener 注册」
// 的 race(同 STARTUP_GET_STATE 的设计)。
//
// Zod schema 挡的不仅是返回类型,更重要的是**语义约束**(z.void()、nonnegative
// int、enum 等)—— 老 Zod 边界测试看的是「结构合规」,新加 case 看「业务不变量」。
//
// audit-r56:删 LIBRARY_SCAN_PROGRESS_GET_STATE / LIBRARY_MIGRATION_GET_STATE
//   两对 pull-snapshot schema —— library 推送通道整体下线,这两个 GET_STATE
//   也无消费方。
// audit-r73:删 ZodNotesResyncProgressGetState{Req,Res} —— 配对的
//   NOTES_RESCYNC_PROGRESS(_GET_STATE)通道无发送点 / 无调用方,整对下线。
// audit-r211:删 ZodFavoritesGetState{Req,Res} —— 配对的 FAVORITES_GET_STATE
//   通道整对下线(空壳:renderer 全域零调用点,且与 FAVORITES_LIST 同源同形)。
//   现存 pull-snapshot 只剩 STARTUP_GET_STATE 一对(它的 schema 是
//   ZodStartupGetState{Req,Res},见上)。

// 注:本文件其余 Zod* export 是 r51 起的「边界锁脚手架」—— 通道还没迁移到
//   handleZod,schema 先写好放在这儿(新增字段时能立刻 mismatch 挡在测试面)。
//   它们**未接线**,故不参与本文件的运行时校验;接线时再逐个接上。
