// src/shared/schemas/settings.ts
//
// Zod schemas for AppSettings / WorkspaceLayout —— 主进程 IPC 边界 + 设置
// 校验入口的单一真相源(audit r50)。
//
// 设计决策:
//   - **strict() 而非 all()**:Zod 默认允许多余字段,主进程 IPC 入口必须 reject
//     任何未声明字段,否则 renderer 偷偷加新字段上线后才暴露
//   - **不替 IPC schema 包 envelope**:IPC payload 校验在 src/shared/schemas/ipc.ts
//   - **length caps 在 settings/validate.ts**:本 schema 只保证类型 + 必要字段 +
//     严格模式,长度上限是「防超大 alloc 撑爆 settings.json」的安全阀,与类型契约正交
//
// 类型推导:`z.infer<typeof ZodAppSettings>` 与 shared/types.ts 的 AppSettings
// 不完全一致(后者是手写 interface),IPC 边界校验后用 `parsed.data as Partial<AppSettings>`
// 接续,类型差距由 sanitizer 抹平。
//
// audit-r56:删 libraryPath / libraryMigrationPending / libraryMigrationAcknowledged /
//   extraImportRoots / includeAllExtensions / enabledExtensions 字段 —— library
//   整体退役,settings.json 实际文件可能仍含这些字段(老数据),但 Zod strict 会 reject,
//   settings/store.ts 的 sanitize 流程负责剥掉(而不是 throw)

import { z } from 'zod';
// audit-r91:path 上限引 SSOT(见 limits/ipc MAX_IPC_PATH_CHARS 头注)。
// version 的 64 不属 SSOT(语义自选,与 MAX_LIBRARY_ID_CHARS 巧合同值),
// 保留字面量 —— parity 锁白名单。
import { MAX_IPC_PATH_CHARS } from '../limits/ipc';
// audit-r229:字体族引 SSOT(shared/types.ts 的 FONT_FAMILIES tuple)——
//   此前这里手抄了 z.enum(['system','serif','mono']),注释还写「(shared/types.ts
//   单一源)」,实际是拷贝:加一个字族时 schema 不跟 ⇒ 用户在设置页选了新字体,
//   **存盘时被 strict schema 拒**,字体设置静默丢失(与 THEME_PRESETS 在
//   r125 修掉的是同一类病)。theme 族已有哨兵
//   tests/unit/shared/themes-enum-single-source-parity.test.ts;字体族本轮
//   补上同款守卫 tests/unit/shared/font-enum-single-source-parity.test.ts。
import { FONT_FAMILIES, THEME_PRESETS } from '../types';

/**
 * WorkspaceLayout —— UI 状态偏好(statusBar / font / theme preset)。
 * strict() 锁死 schema,renderer 偷偷加新字段会立刻 INVALID_INPUT,不会进 settings.json。
 * audit-r65:zenMode 整体退役,只留 statusBarHidden。
 * r242:加回 sidebarCollapsed(左栏折叠态)—— 与 types.ts 的 WorkspaceLayout 对齐。
 *
 * audit-r80 (2026-10-17) HIGH:三字段必须 .optional() —— TS 侧 WorkspaceLayout
 *   字段全部 optional(types.ts「旧设置文件无此段也能正常 hydrate」),
 *   DEFAULT_SETTINGS.workspaceLayout = {}。旧 schema 三字段全 required,
 *   于是新装用户(从未 toggle 过布局)的 settings 过不了 ZodAppSettings;
 *   而 APP_BOOTSTRAP 的响应走 handleZod 校验(wrap.ts:mismatch →
 *   {ok:false, INTERNAL}),bootstrap 对新用户**必败** → main.tsx 标记
 *   loaded=true 跳过 legacy 兜底 → settings 永久 null,主区禁用(实证:
 *   safeParse({}) === false;safeParse({statusBarHidden:true}) === false,
 *   单字段 patch 也过不了)。strict() 保留:未知字段照样拒。
 */
export const ZodWorkspaceLayout = z
  .object({
    statusBarHidden: z.boolean().optional(),
    // r242:左侧列表面板折叠态(标题栏按钮 + ⌘B 切换)。
    //   必须同步加 —— 本 schema 是 .strict(),漏加会让 renderer 写回的
    //   workspaceLayout 被判「未声明字段」⇒ 整个 settings.update 被拒 ⇒
    //   折叠态永远存不下来(且用户看到「设置保存失败」类错误)。
    sidebarCollapsed: z.boolean().optional(),
    // FONT_FAMILIES = ['system', 'serif', 'mono'](shared/types.ts 单一源)
    fontFamily: z.enum(FONT_FAMILIES).optional(),
    // THEME_PRESETS(shared/types.ts 单一源,r247 起 15 档)。
    //   ⚠ 本 schema 是 .strict(),漏加成员会让 renderer 写回的
    //   workspaceLayout 被判「未声明字段」⇒ 整个 settings.update 被拒 ⇒
    //   主题设置静默丢失(r242 同款事故)。引 SSOT 而不是手抄字面量 ——
    //   手抄那次(r125 之前)正是「加了预设但 schema 没跟」的病根。
    themePreset: z.enum(THEME_PRESETS).optional(),
  })
  .strict();

/**
 * AppSettings 顶层 schema。
 * 字段适配 actual 代码:dataPath 保留为镜像字段(ADR-0003 降级兼容老版本);
 * audit-r156:删 `notesResyncPending` zod 字段 —— r50 M6 链路从未接线
 * (audit-r124 实证 service 从未写、renderer 零读),ghost 行清理自 audit-r124
 * 起由 NotesService.resyncIfNeeded 就地完成。strict() 仍拒未知字段,但
 * legacy settings.json 含此字段会被默认 passthrough 行为剥除(老数据迁移无风险)。
 */
export const ZodAppSettings = z
  .object({
    rootPath: z.string().max(MAX_IPC_PATH_CHARS),
    // ADR-0003:dataPath 已 deprecated,镜像写入兼容老版本
    dataPath: z.string().max(MAX_IPC_PATH_CHARS).optional(),
    theme: z.enum(['light', 'dark', 'system']),
    language: z.enum(['zh-CN', 'en-US']),
    version: z.string().max(64),
    workspaceLayout: ZodWorkspaceLayout.optional(),
  })
  .strict();

// audit-r138:删 `AppSettingsZod`(原本用 `z.infer<typeof ZodAppSettings>` 推导,
//   0 生产 caller:调用方 IPC 边界校验后用 `parsed.data as Partial<AppSettings>`,
//   推导出的类型与手写 AppSettings 形状基本一致,但其存在诱使下游写
//   `as AppSettingsZod` 这种强转替代 sanitizer 的正确路径,本就是
//   注释里警告的「类型差距由 sanitizer 抹平」的反模式)。要类型用
//   `z.infer<typeof ZodAppSettings>` 内联,不要复用这个别名。
