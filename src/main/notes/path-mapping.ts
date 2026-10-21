// 笔记专用路径 / ID 助手 —— audit-r56 从 src/main/library/path-mapping.ts 搬过来:
//
// library/path-mapping.ts 随 library 整套(scan / import / watcher)下线,
// 但 toPosix / computeFileId / filenameOf / toNotePath 这四个 helper 被
// notes 子树继续使用:
//
//   - service.ts:     toPosix, computeFileId
//   - standalone.ts:  toPosix, computeFileId, filenameOf, toNotePath
//   - note-id.ts:     computeFileId
//
// 原模块还包含 library-only 工具(deriveLibraryPath / isInsideLibrary /
// isInsideData / toSidecarPath / toAIPath 等)随 library 整体退役,本文件
// 不再保留这些。命名前缀不再加 'library' 概念 —— notes 的 helper 放在
// notes/ 下,call site 不再跨模块读 library/*。
//
// 设计约束:
//   - toPosix / computeFileId 零 fs 依赖,理论上可下沉到 @shared/path-utils,
//     但目前 3 个 caller 全是 main,放 shared 会让 shared 模块增长边角;
//     留 main 侧就近调用,等真有 renderer 需求再搬。
//   - 行为契约与原 path-mapping.ts 完全一致 —— 见 CHANGELOG / tests
//     对 toPosix / computeFileId 的字面比对。

import { createHash } from 'crypto';
import { join, sep } from 'path';
import { WORKSPACE_DATA_LAYOUT } from '@shared/types';

/**
 * 把 path 模块产生的 native 分隔符统一折叠为 posix `/`。
 *
 * 之所以统一:notes 在 settings.json / DB 落盘的 relPath 必须与 OS 无关,
 * Windows 上 `path.relative('a\\b', 'a\\b\\c')` 返 `'c'`,`path.relative('a/b','a/b/c')`
 * 才返 `'c'`,但 SQL FTS / favorites 跨设备同步都按字面字符串匹配,字面 `'a\\b\\c'`
 * 与 `'a/b/c'` 算两个文件。统一为 `/` 是已落地的口径。
 */
export function toPosix(p: string): string {
  return p.split(sep).join('/');
}

/**
 * 由 relPath 派生稳定 16-char 十六进制 ID —— SHA-256 截前 16 位。
 *
 * **大小写敏感**:`computeFileId('A.md') !== computeFileId('a.md')`。
 * 上层不归一化大小写是故意的 —— 文件系统语义本身在 macOS(APFS default
 * case-insensitive) / Windows(NTFS) / Linux(ext4) 之间漂移,笔记
 * relPath 一旦落盘再以另一种大小写去重 hash,会出现「同文件两 id」
 * 的不可见问题,而用户机器上**只有一个文件**。解决思路是上游 relPath
 * 已经按磁盘真实形态记录,这层 hash 保持对字面串敏感即可。
 */
export function computeFileId(relPath: string): string {
  return createHash('sha256').update(relPath).digest('hex').slice(0, 16);
}

/**
 * 把 relPath 收成 `<dataPath>/notes/<relPath>` 绝对路径。
 * 仅做 join + sep 兼容 —— relPath 已由 caller 保证是 posix 形态(经过
 * toPosix),这里直接 join 到 dataPath,sep 由运行时 path 模块决定。
 */
export function toNotePath(dataPath: string, relPath: string): string {
  return join(dataPath, WORKSPACE_DATA_LAYOUT.NOTES_DIR, relPath);
}

/**
 * 取 relPath 末段作为 filename。语义与 Node `path.basename` 一致
 * (按 posix 分隔符切,取末段),不依赖 `path.basename` 防止 Windows 下
 * `\\` 与 `/` 混用导致结果漂移。
 */
export function filenameOf(relPath: string): string {
  // 末段分隔符统一按 posix 切
  const parts = relPath.split('/');
  return parts[parts.length - 1] ?? relPath;
}
