// src/shared/limits/ipc.ts
//
// IPC 边界 size / 字符上限 集中点 ——
//
// audit r52 (2026-10-15) C5:这些常量历史上集中于 `src/main/ipc/path-limits.ts`,
//   但 preload / 未来 renderer 校验入口也需要同一份 cap(main 改上限 → preload
//   不跟,IPC 边界契约就在两边漂移)。搬到 `@shared/limits/ipc` 后:
//     - main/ 继续 `from '@main/ipc/path-limits'`(re-export 保持向后兼容)
//     - preload/ `from '@shared/limits/ipc'`(跨进程直接拿)
//     - renderer/ 未来若需 input 预校验(如 title 长度),同一来源
//
// 单一来源(SSOT):本文件定义,path-limits.ts re-export。
//   不在本文件里走 const re-export(那只是 alias),让 path-limits.ts 显式
//   `export { MAX_X } from '@shared/limits/ipc'` —— grep 即可定位所有引用。
//
// 调整任何上限前请读:每个常量 JSDoc 注释说明「为什么是这个数」,
//   改大 / 改小都要先 review 是否仍覆盖真实场景 + 防御意图。
// 复用 pattern:与 `src/main/utils/body-cap.ts` 的 readBodyWithCap(5MB)、
//   `requireString(channel, val, field, { maxLen, maxBytes })` 配对使用。

/**
 * IPC 入口处接收的路径字符串最大字符数。
 *
 * 用于 requireString(..., { maxLen }) —— 防止 renderer 注入超大字符串让
 * fs.access / path.resolve 跑飞再被拒。所有"路径字段"的 maxLen 都引用它,
 * 未来想调整体上限只改这里一处。
 */
export const MAX_IPC_PATH_CHARS = 4096;

/**
 * 笔记 body / scan / 导入 共享 5MB 上限。
 *
 * 同一上限分散在 3 个文件,任意一处漂移都会让"写入口 5MB"与"扫描入口 6MB"
 * 不一致 —— 攻击者 / 同步冲突放一个 6MB .md 进 notes 目录,扫描阶段超出
 * 上限被 skip + log warn,写入路径却能完整吃下,下次扫描命中 → 死循环。
 * 集中到共享 limits 后,5MB 是单一来源。
 *
 * 为什么是 5MB:
 *   - readFile 一次性吃进堆,主进程被 block(不是 OOM 风险,是 GC 压力)
 *   - 实战经验:research notes 带图表 base64 嵌入最常见 50-500KB,5MB 给
 *     极限情况留 10x 余量
 *   - 增大需重新评估 V8 堆吃紧 + 主进程 IPC push 阻塞时长
 */
export const MAX_NOTE_BODY_BYTES = 5 * 1024 * 1024;

/**
 * 笔记 IPC 字段字符上限 —— 共享给 id / filename(都是 path 派生)。
 *
 * id 是 16 字符 hex(computeFileId 输出),filename 上限由 filename-validator
 * 120(grapheme count)再 cap 一层,这里 256 是更宽松的 IPC 入口防御。
 *
 * audit-r124:「16 字符 hex」前提对 **literature fileId** 不成立('lit:'+绝对
 * 路径,可远超 256),FAVORITES_TOGGLE 曾误借本常量做上限 → 长路径收藏恒
 * VALIDATION。收藏侧已改用 MAX_IPC_PATH_CHARS;借用本常量做新字段上限前,
 * 先确认字段形态真是短 id。
 */
export const MAX_NOTE_FIELD_CHARS = 256;

/**
 * 笔记 title 字符上限 —— 写路径 IPC 入口 + 读路径 frontmatter.cleanTitle
 * 共用同一份 (单一来源)。200 字符对中英文标题都足够,超出后 read 路径
 * 截断 / write 路径 requireString 拒绝,防止 renderer / 主进程被 GB 级
 * title 撑爆。
 */
export const MAX_NOTE_TITLE_CHARS = 200;

/**
 * 笔记 title 字节上限 —— char-only cap 在 CJK / emoji 上每个字符占 3-4 UTF-8
 * 字节,200 char title 可达 ~800B;maxBytes 兜底防 unicode 滥用。maxLen 与
 * maxBytes 并联,任一超即拒(走 requireString 的 VALIDATION 错误码,UI 可
 * 字段级处理)。800 = 200 char × 4 bytes/char(UTF-8 最差情况,ASCII 控制字符)。
 *
 * audit round 11 (2026-09-15):VAL-003 新增 —— 与 NOTES_WRITE body 的
 *   maxBytes=MAX_NOTE_BODY_BYTES 风格对称。
 */
export const MAX_NOTE_TITLE_BYTES = 800;

/**
 * 库导入文件大小上限 —— 500MB。
 *
 * 之前 import.ts 内联 `const MAX_LIBRARY_IMPORT_BYTES = 500 * 1024 * 1024`。
 * 单 caller,集中收益不大,但放在 IPC limits 与其他 size cap 并列,
 * 让"这个项目的字节上限族"一眼可见,新增 size cap 时知道来这里加。
 */
export const MAX_LIBRARY_IMPORT_BYTES = 500 * 1024 * 1024;

/**
 * settings.json 字节上限 —— 1MB。
 *
 * 之前 store.ts:22 内联。settings 字段固定 schema,实际写时 ~5-10KB,1MB
 * 是"意外把 GB 级数据写进去"的防御上限。
 */
export const MAX_SETTINGS_BYTES = 1 * 1024 * 1024;

/**
 * 读取器打开的任意文件字节上限 —— 10MB。
 *
 * 之前 reader.ts:16 内联 export。PDF / 图片 / 代码 / 文本共享同一上限,
 * 超出时抛 IO_ERROR 拒绝打开,避免主进程 readFile 整 GB 文件阻塞。
 */
export const READER_MAX_SIZE_BYTES = 10 * 1024 * 1024;

/**
 * library IPC 字段字符上限 —— 共享给 file id 等 path 派生字段。
 *
 * audit r32 (2026-09-23):之前 inline 在 library.ts:28,4 处 caller 共用同一值。
 * 集中收益:单点改 64 → 其他,无需 grep 4 个 callsite 同步。
 * file id 是 16 hex char(computeFileId),64 给 hash + sha256 派生 id 留余量。
 */
export const MAX_LIBRARY_ID_CHARS = 64;

/**
 * search IPC query 字符上限 —— 500。
 *
 * audit r32 (2026-09-23):之前 inline 在 search.ts:8。实际搜索场景 ~100 字符以内,
 * 500 是宽松上限,防止 renderer 注入 10MB 字符串拖垮 SQLite FTS5 主线程。
 */
export const MAX_SEARCH_QUERY_CHARS = 500;

/**
 * Toast / 推送消息字符上限 —— 4096。
 *
 * 之前 preload/index.ts:146 inline `const MAX_TOAST_MESSAGE_CHARS = 4096`。
 * 搬到 `@shared/limits/ipc` 后,main + preload 共享单一来源(与
 * MAX_IPC_PATH_CHARS / MAX_NOTE_BODY_BYTES 同族)。值与 MAX_IPC_PATH_CHARS
 * 对齐,4096 给常见 toast 文案(几百字)足够,远低于 setTimeout 内部 1ms
 * clamp 阈值。
 */
export const MAX_TOAST_MESSAGE_CHARS = 4096;

// audit-r73:删 MAX_EXTRA_IMPORT_ROOTS —— 它守卫的 `extraImportRoots` settings
// 字段已在 audit-r56 随「库」概念整体退役,JSDoc 声称的「sanitize 层 slice
// 截断」实现也随之消失,全项目(main/preload/renderer/测试)再无任何引用点,
// 只剩 path-limits.ts 一行 re-export 的空壳。DoS 防御由 MAX_SETTINGS_BYTES
// (1MB 写盘闸门)覆盖。
