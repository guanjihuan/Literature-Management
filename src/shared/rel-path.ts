// src/shared/rel-path.ts
// relPath(工作区内的 POSIX 风格相对路径)校验 —— **单一真相源**。
//
// 背景(r186):仓库里曾有**三份**互不相同的 relPath 校验,规则各说各话:
//
//   A. src/main/ipc/folders.ts        `requireRelPath` / `requireParentRelPath`
//      段正则 /^[^\\/.\s][^\\/]*$/ —— 段首不能是空白;`requireFolderName`
//      另用 FOLDER_NAME_RE(1-100 字符、段首不能是空白/点);
//   B. src/main/notes/standalone.ts   `assertTargetRelPath`
//      段首不能是 '.';含 '..'(任意位置)拒;**段长不限**;首尾空白随意;
//   C. src/main/literature/literature-service.ts `assertLitTargetRelPath`
//      与 B 逐字节相同,只把错误类型从 ValidationError 换成 LibraryError。
//
// 后果不是「多写了一份」,而是**三份规则对同一串给出不同答案**,而用户
// 能碰到它们:
//   - 磁盘上有一个名字以空格开头的夹(Explorer 随手就能建),侧栏**列得出来**
//     (listSubdirs 不做名字过滤),点进去 → list-dirs 走 A → A 拒收 →
//     VALIDATION 报错,这个夹**永远进不去**,里面的笔记在夹视图里看不到;
//   - 同一个夹,notes 的 move 走 B → B 放行 → 笔记**搬得进去**;
//     文献的 move 走 C → 也放行。
//   ⇒ 「应用能往一个它自己不承认存在的夹里搬数据」—— 数据在,界面找不到。
//
// 修法:把规则收成一份(本文件),三个 call site 只做「错误类型/消息前缀」
// 的翻译,判定逻辑**只此一处**。差分守卫见
// tests/unit/main/rel-path-validation.test.ts —— 同一串输入喂给四个入口
// (folders.ts 的 requireRelPath / requireParentRelPath / requireFolderName
// + notes / literature 两个 service 的 assert*),判定必须一致。
//
// 本文件在 src/shared/ 下:main / preload / renderer 三端都可能引用,
// 因此**不能** import Node 内置模块(见 path-layout.ts 头注:renderer 的
// Vite 构建不 polyfill `path`,裸 import 会在运行到调用点才炸)。本文件
// 是纯字符串逻辑,零依赖。
//
// ── 规则分两层:核心段规则 + 创建策略 ───────────────────────────────────
//
//  核心(`validateRelPathSegment`,path 与 name **共用**):
//    段非空;不含 '/' 与 '\';不等于 '..';不以 '.' 开头(隐藏项 ——
//    listSubdirs 跳过 dot 项,应用不管理隐藏目录);不含控制字符(含 NUL)。
//
//  策略(只在**创建**语义下生效,path 语义不生效):
//    段长 ≤ MAX_FOLDER_NAME_CHARS(应用自建/改名的策略上限)。
//    之所以把「段长上限」放在 name 而不是 path 上:磁盘上可能存在更长的
//    名字(用户在资源管理器里建的、或旧版本建的),应用必须能**看见并进入**
//    它们,否则就是自己制造看不见的数据 —— 这正是 r186 要修的那类洞。
//
//  路径级附加(`validateRelPath`):
//    - 绝对路径('/foo'、'C:\foo'、'C:/foo')→ 拒;
//    - 空段('a//b'、结尾多余的 '/')→ 拒;
//    - 根目录 = 空串 ''(allowRoot 时合法 —— 根在 relPath 语境里是空串,
//      不是 null)。
//
// ── 两条不变量(本文件存在的全部理由)────────────────────────────────────
//
//  I1「能用 name 建的,一定能用 path 进」—— name 规则 = 核心 + 长度上限,
//     path 规则 = 核心 ⇒ name ⊂ path。这是**结构上**成立的,不是靠
//     两处代码写得一样 —— 之前 A 的 name 入口(FOLDER_NAME_RE)允许
//     'a..b',而 A 的 path 入口却拒收 'a..b' ⇒ 改名能造出一个 path 走不
//     进去的夹,又是一个「列得出来、进不去」的洞。
//
//  I2「列得出来的,一定能进得去」—— 由 listSubdirs 用同一份核心规则
//     过滤实现(safe-write.ts):凡是不满足核心规则的目录名(隐藏项 /
//     含 '\' / 含控制字符)**不列**。Windows 上除了 dot 目录不存在这种
//     名字,所以这条过滤对正常用户是零影响;Linux 上极端目录名从
//     「列出来点进去报错」变成「不列」—— 与 dot 目录一致的处理方式。
//
// ── 三份旧规则的差异,现在的裁决 ─────────────────────────────────────────
//   - 「段首空白」:旧 A 拒 / 旧 B、C 放行 ⇒ 统一**放行**(空白不是路径
//     穿越向量,Explorer 也允许创建这种名字);
//   - 「段长上限」:旧 A 的 name 入口有(100)、path 入口没有;旧 B、C 都没有
//     ⇒ 统一为「name ≤ 100、path 不限」(见上);
//   - 「含 '..'」:三处都按「任意位置含 '..' 即拒」⇒ 统一收窄为
//     **段恰为 '..' 才拒**。理由:路径穿越只发生在「某一段恰为 '..'」;
//     'a..b' / 'a/..b' 是完全正常的目录名(Windows 上合法、Explorer 能建),
//     按旧规则会变成「侧栏列得出来、点进去报错」的夹 —— 与 r186 要修的
//     洞是同一个洞。越界另有**两道独立防线**:notes 侧
//     resolveInsideRootPath、literature 侧 `newAbs.startsWith(root + '/')`,
//     都不依赖本文件的字符串规则。
//   - 「控制字符」:三处都没管 ⇒ 统一拒收(核心段规则)。
// Win32 命名规则的唯一来源(字符集 / 保留设备名 / 结尾点空格)。
import { findWin32NameProblem, win32NameProblemMessage } from './win32-name';

export const MAX_FOLDER_NAME_CHARS = 100;

// audit 2026-10-21(P1-1):文件夹名补上 **Win32 命名规则** —— 判据在
//   shared/win32-name.ts(全仓唯一来源),本文件只做「加策略」。
//
//   为什么是「创建策略」层而不是核心段规则:磁盘上可能存在这类名字
//   (用户用别的工具建的),应用必须能**看见并进入**它们(不变量 I2)
//   —— 核心规则不能收紧。但应用**自己**新建的夹必须合规,否则会造出
//   「自己管不了」的目录:
//
//     'a.'(结尾带点) / 'a '(结尾带空格) / 'CON'(Windows 保留设备名)
//       ⇒ notes 域的**笔记文件名校验**对每一段都拒这些形态 ⇒ 在这个
//         夹里**建不了任何笔记**(createNote 收含目录的 relPath,
//         'a./Untitled 1.md' 的段 'a.' 命中「结尾带点」⇒ ValidationError)
//         ⇒ 「建得出、进不去笔记的死夹」(audit 2026-10-21);
//     'a:b'(Win32 保留字符)⇒ 连 fs.mkdir 都失败 ⇒ 用户看到的是天书级
//         IO 报错,而不是「这个名字不能用」。
//
//   另有一点刻意的差异:核心规则的控制字符口径是 < 0x20(不含 DEL
//   \u007f),而**名字**策略用 win32-name.ts 的口径(含 \u007f)。因为
//   \u007f 是合法目录名(Explorer 能建),核心规则不该因此把磁盘上
//   已有的目录从列表里抹掉(I2);而应用自建的名字不必背这个包袱。


/** 校验失败的原因码。调用方据此翻译成各自的错误类型与消息。 */
export type RelPathProblemCode =
  | 'empty'
  | 'absolute'
  | 'contains-dotdot'
  | 'empty-segment'
  | 'invalid-segment'
  | 'too-long';

export interface RelPathProblem {
  code: RelPathProblemCode;
  /** 出问题的段(仅 empty-segment / invalid-segment / too-long 有值)。 */
  segment?: string;
  /** 英文短句,便于各端拼上自己的前缀(channel 名 / label)。 */
  message: string;
}

function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    if (s.charCodeAt(i) < 0x20) return true;
  }
  return false;
}

/**
 * 核心段规则 —— path 与 name 共用。**这是唯一的规则来源。**
 *
 * 拒收:空段、含 '/' 或 '\'、段恰为 '..'、以 '.' 开头、含控制字符。
 * **不**管段长(长度是创建策略,见 validateFolderName)。
 */
export function validateRelPathSegment(segment: string): RelPathProblem | null {
  if (segment === '') {
    return { code: 'empty-segment', segment, message: 'has empty segment' };
  }
  if (segment.includes('/') || segment.includes('\\')) {
    return {
      code: 'invalid-segment',
      segment,
      message: `has invalid segment "${segment}"`,
    };
  }
  if (segment === '..') {
    // 路径穿越只发生在「某一段恰为 '..'」。'a..b' 这种名字是合法的
    // (Windows 允许、Explorer 能建),按「含 '..' 即拒」会把它变成
    // 「列得出来、点不进去」的夹。
    return { code: 'contains-dotdot', segment, message: 'must not contain ".."' };
  }
  if (segment.startsWith('.')) {
    // 隐藏项:listSubdirs 跳过 dot 项,应用不管理隐藏目录。
    return {
      code: 'invalid-segment',
      segment,
      message: `has invalid segment "${segment}"`,
    };
  }
  if (hasControlChars(segment)) {
    return {
      code: 'invalid-segment',
      segment,
      message: `has invalid segment "${segment}"`,
    };
  }
  return null;
}

/**
 * 校验一整条 relPath(路径语义 —— 磁盘上**已经存在**的东西)。
 * 返回 null = 合法。
 *
 * 注意:path 语义**不限段长** —— 磁盘上可能有更长的目录名(用户在资源
 * 管理器里建的),应用必须能进入它们。段长上限只属于 name 语义。
 *
 * @param options.allowRoot 是否允许空串(根目录)。
 *   - `requireRelPath` 类调用点(指向某个具体资源/目录)传 false;
 *   - `requireParentRelPath` / `assertTargetRelPath` 类(可能是「移到根」)
 *     传 true —— 根目录在 relPath 语境里是**空串**,不是 null。
 */
export function validateRelPath(
  value: string,
  options: { allowRoot?: boolean } = {},
): RelPathProblem | null {
  const allowRoot = options.allowRoot ?? false;
  if (value === '') {
    if (allowRoot) return null;
    return { code: 'empty', message: 'must not be empty' };
  }
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) {
    return { code: 'absolute', message: 'must be a relative path' };
  }
  for (const seg of value.split('/')) {
    const problem = validateRelPathSegment(seg);
    if (problem) return problem;
  }
  return null;
}

/**
 * 校验一个**新建**的名字(文件夹名 —— mkdir 的叶子段 / rename-dir 的
 * newName)。
 *
 * = 核心段规则 + 创建策略:
 *   - 必须是单段(不含 '/');
 *   - 段长 ≤ MAX_FOLDER_NAME_CHARS;
 *   - **Win32 命名规则**(audit 2026-10-21 P1-1):不含 Win32 保留字符
 *     / 控制字符,结尾不含点与空格,词干不是 Windows 保留设备名。
 *
 * 策略方向:比 path 语义**严**(path 不限段长、不管 Win32 命名)。这样
 * 保证不变量 I1 ——「能用 name 建的夹,一定能用 path 走进去」—— 反过来
 * 不成立也没关系 (磁盘上更长的名字是外部造的,path 放行让用户能进)。
 *
 * 追加 Win32 规则的理由(不变量 I3,audit 2026-10-21):
 *   「**能用 name 建的夹,一定能放笔记**」。notes 域的文件名校验对
 *   relPath 的**每一段**都应用 Win32 规则 ⇒ 若夹名 'a.' / 'a ' / 'CON'
 *   能建,这个夹里就**建不了任何笔记**(createNote 收 'a./x.md' ⇒ 段
 *   'a.' 被拒)⇒ 死夹。故夹名规则取 notes 域文件名的**超集**。
 */
export function validateFolderName(name: string): RelPathProblem | null {
  const problem = validateRelPathSegment(name);
  if (problem) return problem;
  if (name.length > MAX_FOLDER_NAME_CHARS) {
    return {
      code: 'too-long',
      segment: name,
      message: `has segment longer than ${MAX_FOLDER_NAME_CHARS} chars`,
    };
  }
  const win32 = findWin32NameProblem(name);
  if (win32) {
    return {
      code: 'invalid-segment',
      segment: name,
      message: win32NameProblemMessage(name, win32),
    };
  }
  return null;
}

/**
 * validateRelPathSegment 的布尔版 —— 给 listSubdirs 用:
 * 凡是不满足核心段规则的目录名**一律不列**(不变量 I2:
 * 「列得出来的,一定能进得去」)。
 */
export function isValidRelPathSegment(segment: string): boolean {
  return validateRelPathSegment(segment) === null;
}
