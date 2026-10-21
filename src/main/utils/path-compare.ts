// 跨平台路径等价比较 —— 「这两个字符串是不是同一个目录」
//
// audit 2026-10-03:起因是 settings/library-migration.ts 用裸 `!==` 比较
//   `settings.libraryPath` 与 `deriveLibraryPath(settings.rootPath)`。
//   那是**字符串**比较,却被用来回答「是不是同一个目录」这个**文件系统**
//   问题,于是三种完全合法的写法都被判成「库不在规范位置」:
//
//     1. 尾部分隔符   `...\library\`   vs `...\library`
//     2. 分隔符风格   `C:/Users/foo`  vs `C:\Users\foo`
//     3. 大小写       `C:\Users\Foo`  vs `c:\users\foo`   (NTFS / APFS)
//
// 后果不是「多弹一次窗」:迁移动作会因为「目标已存在」而报错(目标其实就是
// 源本身),UI 于是叫用户**删掉自己的库目录**;而用户点「保持现状」之后,派生
// 量会在下一轮启动把它重算成待迁移,弹窗反复出现。
//
// 放在 utils/ 而不是 shared/:大小写折叠要用 `isCaseInsensitiveFs`
// (utils/platform.ts),那是**主进程**的平台真相;shared/ 三端共用且拿不到
// process.platform。

import { isCaseInsensitiveFs } from './platform';

/**
 * 归一化路径,使其可与另一条路径做同一目录比较。
 *
 * - 折叠分隔符风格:仅当路径呈 win32 形态(盘符 / UNC / 含反斜杠)才把 `/`
 *   转成 `\`。POSIX 路径的 `/` 是语义的一部分,不能碰。
 *   **判定只看字符串形态,不看宿主平台** —— 这是刻意的:同一份判定要与
 *   src/shared/path-layout.ts 的 detectSeparator 同源,而后者是给三端共用的。
 *   因此 caller 若持有的是**平台原生**路径(`path.join` / `path.resolve` 的产物),
 *   要先自己过一遍 `resolve()` 再传进来 —— 见 settings/store.ts 的
 *   changeDataPath 跳过库目录那一处。
 * - 剥尾部多余分隔符,但保住 `C:\` 与 `/` 这类根本身(剥空了就丢了根)。
 * - case-insensitive FS 上 lowercase(单一真相来自 utils/platform)。
 */
export function normalizePathForCompare(p: string): string {
  // win32 形态判定与 src/shared/path-layout.ts 的 detectSeparator **同规则**:
  // 盘符 / UNC 两种前缀都按「两个前导分隔符」来认(不区分 `\\` 与 `//`,因为
  // `//server/share` 是 Windows 上完全合法的 UNC 写法)。
  //
  // 这里曾经只认 `\\` 开头的 UNC,于是 `//server/share/lib` 被当成 POSIX 路径
  // 原样保留,而 `\\server\share\lib` 走 win32 分支 —— 同一个 UNC 服务器的
  // 两种写法被判成两个目录。两处判定必须同源,否则「单一真相」只是口号。
  const looksWin32 = /^[a-zA-Z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p) || p.includes('\\');
  let s = looksWin32 ? p.replace(/\//g, '\\') : p;
  s = s.replace(/[\\/]+$/, '');
  if (s === '' || /^[a-zA-Z]:$/.test(s)) s = looksWin32 ? `${s}\\` : `${s}/`;
  return isCaseInsensitiveFs ? s.toLowerCase() : s;
}

/** 两条路径是否指向同一个目录(而非同一个字符串)。 */
export function isSameDir(a: string, b: string): boolean {
  return normalizePathForCompare(a) === normalizePathForCompare(b);
}
