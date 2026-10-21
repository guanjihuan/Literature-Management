// src/shared/path-utils.ts
//
// 跨 main + renderer 的纯字符串路径工具 — 零 fs / 零 Node path 模块依赖。
//
// audit C3R68 (2026-08-22):抽 stripExt 到 @shared/,消除
//   - src/main/library/path-mapping.ts:23 (path.extname 实现)
//   - src/shared/wiki.ts:22 (inline lastIndexOf 实现)
// 的 verbatim 重复。
//
// 行为契约:
//   - 输入是单一文件 relPath(库文件路径),不是目录
//   - audit-r85 (2026-10-17):旧注释声称「at-most-1 extension 时
//     `lastIndexOf('.')` 与 Node `path.extname` 等价」—— node REPL 实证
//     反驳:等价性只在最后一段文件名含点时成立;目录名含点即破
//     ('dir.v2/file' 旧返回 'dir' 截断,'dir/.hidden' 旧返回 'dir/')。
//     现契约 = 「点必须落在最后一段内,且不在段首」才剥,与 extname 对齐。
//   - 隐藏文件 `.hidden` 不被当扩展名(段首点守卫)
//
// 不放回 main/path-mapping.ts:那个模块本身依赖 fs/path Node API,
// shared 模块不能依赖 main-only helper。

/**
 * 取 relPath 的父目录部分(posix 口径),根目录返回空串。
 *
 * 契约与 renderer 侧 `lib/folder-view.ts` 的 `dirnameOfRelPath(item)` 一致
 * (那条吃 item 对象,这条吃裸串;两边都按最后一个 `/` 切)。
 *
 * 为什么要有这条:「重命名」只该改**文件名**,不该改所在目录 —— 但主进程
 * 独立笔记的 `renameNote` 以前把整条 relPath 换成新文件名,于是
 * `sub/a.md` 重命名成 `b.md` 会把文件搬到 notes 根(用户以为改了个名,
 * 笔记却从当前文件夹里消失了)。修法要用「父目录 + 新文件名」重拼,
 * 父目录必须由 relPath 推导 —— 这条就是那个推导。
 *
 * @example
 *   parentDirOfRelPath('sub/a.md') === 'sub'
 *   parentDirOfRelPath('a.md') === ''      // 根
 *   parentDirOfRelPath('sub/deep/a.md') === 'sub/deep'
 */
export function parentDirOfRelPath(relPath: string): string {
  if (!relPath) return '';
  const i = relPath.lastIndexOf('/');
  return i < 0 ? '' : relPath.slice(0, i);
}

/**
 * 去文件扩展名。无扩展名 / 隐藏文件返回原串。
 *
 * @example
 *   stripExt('papers/attention.md') === 'papers/attention'
 *   stripExt('README') === 'README'
 *   stripExt('.hidden') === '.hidden'
 */
export function stripExt(relPath: string): string {
  const i = relPath.lastIndexOf('.');
  // i <= 0:'..foo' / '.hidden' / 无 . → 抛回原串(隐藏文件 passthrough)
  if (i <= 0) return relPath;
  // audit-r85:点必须在最后一段。'dir.v2/file' 的点在目录名上,剥了会把
  //   整路径截成 'dir';'dir/.hidden' 的点在段首(嵌套隐藏文件),同
  //   串首隐藏文件 passthrough。两种分隔符都认(shared 三端共用,输入
  //   可能是 win32 形态 relPath)。
  const lastSep = Math.max(relPath.lastIndexOf('/'), relPath.lastIndexOf('\\'));
  if (i <= lastSep + 1) return relPath;
  // 末尾空扩展名('file.' / 'file..')→ 视为无扩展名,返回原串
  if (i === relPath.length - 1) return relPath;
  return relPath.slice(0, i);
}
