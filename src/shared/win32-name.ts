// src/shared/win32-name.ts
//
// Win32 命名规则的**唯一**来源(单一真相源)。
//
// 历史:同一批规则在仓库里被抄了三份,各抄各的,已经抄漏过:
//
//   A. src/main/notes/filename-validator.ts
//      WIN32_FORBIDDEN_CHARS / CONTROL_CHARS / RESERVED_DEVICE_NAME
//      —— 用于**笔记文件名**(notes 域);
//   B. src/main/literature/rename-file.ts
//      RESERVED_DEVICE_NAMES(一份手抄的 Set)+ 内联的字符正则
//      —— 用于**文献文件名**(literature 域);
//   C. (缺) src/shared/rel-path.ts 的 validateFolderName —— **文件夹名**
//      一条 Win32 规则都没有 ⇒ 抄漏的第三处。
//
// 抄漏(C)不是「少一条规则」的小事,它是一个用户可见的死胡同
// (audit 2026-10-21 P1-1):
//
//   1. 文件夹名以 '.' 结尾(如 'a.')/ 以空格结尾(如 'a ')/
//      是 Windows 保留设备名(如 'CON')/ 含 Win32 保留字符(如 'a:b'):
//      validateFolderName **放行** ⇒ 用户在侧栏「新建文件夹」能建成;
//   2. 但 notes 域的笔记文件名校验(filename-validator.ts)对**每一段**
//      都拒这些形态 ⇒ 在这个夹里**建不了任何笔记**
//      (createNote 收的是含目录的 relPath:'a./Untitled 1.md' → 段 'a.'
//      命中「结尾带点」→ ValidationError);
//   3. 文献域同理:文献能搬进去(文献侧校验的是**目录归属**,不是段名),
//      但**改名**进不去;
//   ⇒ 「建得出、进不去笔记的死夹」。而且 'a:' 这类名字连 fs.mkdir 都会
//      失败(ENOTDIR/ENOENT)⇒ 用户看到的是一句天书级的 IO 报错,而不是
//      「这个名字不能用」。
//
// 修法(本轮):把 Win32 规则收成**一份**(本文件),三处调用点全部引用它;
// 并且把规则应用到**文件夹名**的创建策略(shared/rel-path.ts 的
// validateFolderName)—— 判据是「Windows 上真的建不出来 / 建出来也没法
// 放东西」的形态。
//
// 分层(与 shared/rel-path.ts 的思路一致):
//   - **核心段规则**(validateRelPathSegment):不管 Win32 命名 —— 磁盘上
//     可能存在这类名字(用户用别的工具建的),应用必须能**看见并进入**
//     它们,否则又变成「列得出来进不去」(r186 的 I2 不变量)。
//   - **创建策略**(validateFolderName / 文件名校验):应用**自己**新建的
//     名字必须满足 Win32 规则 —— 否则应用会造出「自己管不了」的目录。
//
// 本文件在 src/shared/ 下:main / renderer / preload 三端都可能引用,
// 因此零依赖、纯字符串逻辑(不 import Node 内置模块 —— 见 rel-path.ts 头注)。
//
// 参考:https://learn.microsoft.com/windows/win32/fileio/naming-a-file

/** Win32 保留字符(**不含** '/' 与 '\' —— 它们是路径分隔符,单独处理)。 */
export const WIN32_FORBIDDEN_CHARS = /[<>:"|?*]/;

/** 控制字符(含 NUL 与 DEL)。 */
// eslint-disable-next-line no-control-regex
export const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Windows 保留设备名(带扩展名也算 —— 'CON.txt' 在 Win32 一样非法)。
 * 判定用「**词干**」:第一个 '.' 之前那一段(见 stemOf)。
 */
export const RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** 名字不合法的原因。 */
export type Win32NameProblem =
  | 'control-chars'
  | 'forbidden-chars'
  | 'trailing-dot-or-space'
  | 'reserved-device-name';

/** 段里是否含控制字符。 */
export function hasControlChars(s: string): boolean {
  return CONTROL_CHARS.test(s);
}

/** 段里是否含 Win32 保留字符。 */
export function hasWin32ForbiddenChars(s: string): boolean {
  return WIN32_FORBIDDEN_CHARS.test(s);
}

/**
 * 结尾是否带点 / 空格 —— Win32 会**静默截断**它(存下来的名字与用户
 * 输入的不一样 ⇒ 用户下次找不到自己的文件;且 Explorer 里显示的是
 * 被截断后的名字)。
 */
export function hasTrailingDotOrSpace(s: string): boolean {
  return /[. ]$/.test(s);
}

/** 取「词干」:第一个 '.' 之前那一段('CON.txt' → 'CON'、'a.b.c' → 'a')。 */
export function stemOf(segment: string): string {
  const dot = segment.indexOf('.');
  return dot > 0 ? segment.slice(0, dot) : segment;
}

/** 段是否是 Windows 保留设备名(按词干判定)。 */
export function isReservedDeviceName(segment: string): boolean {
  return RESERVED_DEVICE_NAME.test(stemOf(segment));
}

/**
 * 找出段在 Win32 命名上的问题;没有则返回 null。
 *
 * 判定顺序(与用户在界面上最先撞到的问题一致):
 *   控制字符 → Win32 保留字符 → 结尾点/空格 → 保留设备名。
 */
export function findWin32NameProblem(segment: string): Win32NameProblem | null {
  if (hasControlChars(segment)) return 'control-chars';
  if (hasWin32ForbiddenChars(segment)) return 'forbidden-chars';
  if (hasTrailingDotOrSpace(segment)) return 'trailing-dot-or-space';
  if (isReservedDeviceName(segment)) return 'reserved-device-name';
  return null;
}

/** 问题码 → 英文短句(各端拼上自己的前缀;与 rel-path.ts 的 message 风格一致)。 */
export function win32NameProblemMessage(segment: string, problem: Win32NameProblem): string {
  switch (problem) {
    case 'control-chars':
      return `has invalid segment "${segment}" (contains control characters)`;
    case 'forbidden-chars':
      return `has invalid segment "${segment}" (contains characters not allowed on Windows: < > : " | ? *)`;
    case 'trailing-dot-or-space':
      return `has invalid segment "${segment}" (must not end with "." or a space)`;
    case 'reserved-device-name':
      return `has invalid segment "${segment}" (reserved device name on Windows)`;
  }
}
