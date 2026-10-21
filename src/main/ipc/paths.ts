// 共享路径助手:
//   - buildWorkspacePaths(): 渲染层需要的"模块 → 绝对路径"映射
//   - assertInsideAllowedRoot(): shell.open-path / notes 操作的白名单校验
//
// 设计要点:
//   1. 校验用 path.relative 而不是 startsWith —— `/data` 不会误放行 `/data-evil`
//   2. 相对路径解析以 rootPath 为基准,而不是 cwd(避免 cwd 切换导致意外逃逸)
//   3. 不在这里做 fs.stat —— shell.openPath 自己处理;允许打开尚不存在的目录
//      时由上层决定(目前 SHELL_OPEN_PATH 在路径不存在时抛 ENOENT)
//
// audit round 13 (2026-09-15):H-SYM-1 — assertInsideAllowedRoot 加
//   "存在即非 symlink" 二次校验。旧实现只用 path.relative 做字符串比较,
//   路径通过白名单后,protocol.ts / shell.openPath / fs.open 都会 follow
//   symlink → 攻击者把 rootPath/notes/foo.md 替换为指向 /etc/passwd 的
//   symlink,renderer 的 rkms:// iframe 即可读到任意文件。修法:路径
//   存在时 fs.lstat 探一次,见 symlink 抛 EPERM(等价于"出白名单")。
//   不存在时静默放过(白名单已通过,后续 fs.open ENOENT 自然抛)——
//   不阻塞 createNote 之类的"先校验再写"路径。
//
// audit-r56:删 libraryPath 相关白名单逻辑 —— 库整体下线,「库路径 +
//   库父目录 + 额外导入根 + 盘根」这套 importableRoots 也不再有调用方
//   (library import / scanner / import 全部退役)。assertInsideImportableRoot /
//   importableRoots / getDriveRoots / hasDotLeadingSegment /
//   relativeUnderAnyRoot 整段删除。assertInsideAllowedRoot 缩成只判
//   rootPath(notes + workspace 的工作目录根);fs-cache / safe-write 的
//   根判断未来如有需要可直接 reuse 这里的 isInsideAnyRoot。
import { resolve, relative, isAbsolute, posix } from 'path';
import { lstatSync, realpathSync } from 'fs';
import type { WorkspacePaths } from '../../shared/types';
import { deriveFavoritesPath, deriveNotesPath } from '../../shared/path-layout';
import { getRootPath } from '../utils/safe-write';
import { AppError, errnoCode } from '../utils/error';
import { createLogger } from '../utils/logger';
// audit round 26 (2026-09-21):case-insensitive FS dedup —— 复用 utils/platform
//   的 isCaseInsensitiveFs 谓词,与 fs-cache.ts / safe-write.ts 同口径。
import { isCaseInsensitiveFs } from '../utils/platform';

const log = createLogger('paths');

/** path.relative / path.isAbsolute 的最小接口面(便于单测注入 win32 / posix 实现) */
type PathImpl = Pick<typeof posix, 'relative' | 'isAbsolute'>;

/**
 * 唯一一处「路径是否落在给定根集合之内」的判定实现。
 *
 * audit 2026-10-01:此前多处白名单比较各自 inline 同一段
 *   `rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))`
 * —— assertInsideAllowedRoot(读白名单)、assertNotSymlink 的 realpath 链防御、
 * assertInsideImportableRoot(拖入 source 白名单)—— 且**三处都漏了
 * case-insensitive 处理**。
 *
 * 漏了为什么真会出事:Node 的 `path.win32.relative` 内部按小写比较,所以
 * Windows 上无感;但 `path.posix.relative` 是纯词法、**大小写敏感**的。
 * macOS APFS 自 10.13 起默认 case-insensitive,大小写不敏感的 realpath
 * 会让「C:/Users/...」与「c:/users/...」词法上不是同一目录。
 *
 * 这与 safe-write.ts(audit r7)/ fs-cache.ts 是同一类缺陷 —— 那两处已按
 * isCaseInsensitiveFs 修过,本文件漏了。现在三处统一收敛到本函数,口径
 * 与 utils/platform.ts 同源。
 *
 * `impl` 默认是**宿主默认的** path.relative / path.isAbsolute(即本文件顶层
 * 从 'path' 导入的那两个),与改造前的行为逐字符一致。**不要**改成按
 * `process.platform` 在 posix/win32 之间切:测试里会覆写 process.platform 来
 * 模拟跨平台(见 tests/integration/open-path.test.ts 的 ORIGINAL_PLATFORM ——
 * r229 补齐 11 例集成用例),而路径又是用宿主 resolve 算出来的,按 platform
 * 切会让两者错配、把合法路径判成越界。需要显式验证某一套语义时,由单测注入
 * impl(见 tests/unit/main/ipc/paths.test.ts 的 A 组,r229 补齐 31 例)。
 */
export function isInsideAnyRoot(
  roots: readonly string[],
  abs: string,
  opts: { caseInsensitive: boolean; impl?: PathImpl } = { caseInsensitive: false },
): boolean {
  const p = opts.impl ?? { relative, isAbsolute };
  return roots.some((root) => {
    // 先折叠再 relative:大小写不敏感的系统上,两侧统一形态后词法比较才能
    // 得出与磁盘一致的结果。
    const from = opts.caseInsensitive ? root.toLowerCase() : root;
    const to = opts.caseInsensitive ? abs.toLowerCase() : abs;
    const rel = p.relative(from, to);
    // 在内 ⇔ relative 不以 '..' 开头(否则跳出)且不是绝对路径(否则换了根)
    return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel));
  });
}

/** 生产路径用:宿主默认 path 实现 + 平台 FS 的大小写语义 */
function isInsideAnyRootHere(roots: readonly string[], abs: string): boolean {
  return isInsideAnyRoot(roots, abs, { caseInsensitive: isCaseInsensitiveFs });
}

/**
 * 「realpath 后的落点是否在白名单内」——**允许根自身是 symlink / junction**。
 *
 * audit-r229(MEDIUM-HIGH):根自身是 symlink / junction 时(Windows 上数据目录
 *   放在 OneDrive / Dropbox,或用户按 utils/path-check.ts 的指引用 `mklink /J`
 *   绕 MAX_PATH),`realpath(target)` 解析到**物理位置**,而白名单里存的是
 *   **明文根**(resolve() 只做词法归一、不解 symlink)⇒ 两侧口径不一致 ⇒
 *   合法的区内文件被判成「realpath 链逃逸」⇒ 抛 EPERM。
 *
 *   用户现象:shell:open-path 报「路径不允许」、rkms:// 协议对**所有**文件
 *   返 403(文献 / PDF / 图片全打不开),而磁盘上的数据其实好好的 ——
 *   极具迷惑性(与 safe-write.ts 在 2026-10-01(r208/r7 HIGH)修过的
 *   是同一个 bug 类,那边已改成「两侧都 realpath 后再比」,本文件漏了
 *   这次同源修复)。
 *
 * 修法:与 safe-write.ts 同口径 —— 落点只要落在「明文根」**或**「realpath
 *   后的根」之内即放行;两侧都不满足才拒。逃逸场景(把 root/notes 换成指向
 *   /etc 的 symlink)两侧都不满足 ⇒ 仍然被拒,防线不放松。
 */
function isInsideRootsRealpathAware(roots: readonly string[], real: string): boolean {
  if (isInsideAnyRootHere(roots, real)) return true;
  for (const r of roots) {
    let realRoot: string;
    try {
      realRoot = realpathSync(r);
    } catch {
      // 根解析不出来(还没建 / 权限被剥)⇒ 只能用明文根比对(与 safe-write 同口径)
      continue;
    }
    if (isInsideAnyRootHere([realRoot], real)) return true;
  }
  return false;
}

/**
 * 计算所有模块的绝对路径。
 * 注意:这并不创建目录 —— 模块目录是懒加载(各自 service.start() 里 mkdir),
 * 渲染层可能在目录尚未创建时拉到这里的数据。
 *
 * audit-r56:删 library 字段 —— 库整体下线,WorkspacePaths 不再有 library。
 */
export function buildWorkspacePaths(): WorkspacePaths {
  const root = getRootPath();
  return {
    root,
    // audit r44 (2026-10-15):走 shared helper 而不是 path.join,符合
    //   src/shared/path-layout.ts 头部「call sites should derive, not
    //   template-join」的 module pragma。derive*Path 内部用零依赖
    //   joinRootPath,行为与 path.join 在本调用点等价,但走单一真相源。
    notes: deriveNotesPath(root),
    favorites: deriveFavoritesPath(root),
  };
}

/** 当前允许作为 shell.open-path / notes 写路径目标的根路径(已 resolve) */
export function allowedRoots(): string[] {
  return [resolve(getRootPath())];
}

/**
 * 校验 target 是否落在任一允许根之内。
 *   - 相对路径以 rootPath 为基准解析(避免 cwd 漂移)
 *   - 用 path.relative 判断"在不在内",避免 `/data-evil` 通过 `/data` 的前缀检查
 *   - 路径解析结果必须是绝对路径(已经是)
 *   - 路径存在时 fs.lstat 探一次:见 symlink 抛 EPERM —— 防止 protocol.ts /
 *     shell.openPath / fs.open follow symlink 读到 target 内容,导致白名单
 *     之外的 /etc/passwd 之类被 renderer 经 rkms:// iframe 拉到
 *
 * 返回解析后的绝对路径;不在白名单内 / 路径是 symlink 抛 EPERM。
 *
 * audit-r56:白名单从「rootPath + libraryPath」缩到「rootPath」单元素
 *   —— 库已下线,libraryPath 字段不再存在。notes 写 / show-in-folder 仍
 *   走这条防御(notes 是工作目录根的子目录),语义不变。
 */
export function assertInsideAllowedRoot(target: string): string {
  if (typeof target !== 'string' || !target) {
    throw new AppError('EINVAL', 'path required');
  }
  const abs = isAbsolute(target) ? resolve(target) : resolve(getRootPath(), target);
  const roots = allowedRoots();
  if (!isInsideAnyRootHere(roots, abs)) {
    // audit-r244:消息**不回显路径** —— 与 ipc/shell.ts / ipc/library.ts 同源口径
    //   (r229 / r191)。非 INTERNAL 的 code 在 ipc/wrap.ts 里是**原样透传**的
    //   (scrubInternal 只处理 INTERNAL 分支,且它只脱敏 rootPath **之内**的
    //   路径 —— 本条恰恰是 rootPath **之外**的路径,scrub 不到)⇒ 消息里
    //   带绝对路径 ⇒ 家目录 / OneDrive 目录名进 renderer 与 telemetry。
    //   完整路径只留在 main 侧日志。
    log.warn('path outside allowed roots', { abs, roots });
    throw new AppError('EPERM', 'path is outside allowed roots');
  }
  // audit round 13 H-SYM-1:symlink 兜底 —— 路径字符串在白名单内 ≠ 文件就是
  // 白名单内。fs.lstat 不 follow,见 symlink 直接拒。ENOENT / 其它错误
  // 静默放过 —— 不存在路径后续 fs.open 会自己抛 ENOENT,这里多 stat 一次
  // 无意义;权限翻转等"真错误"留给上层 fs.open 报告,免得 assertInsideAllowedRoot
  // 把 "EACCES" 翻译成 "EPERM" 误导用户。
  // 显式传 roots:realpath 链防御必须对照**本调用方**的白名单(allowedRoots),
  // 而不是函数默认值 —— 见 assertNotSymlink 头注里 2026-10-06 那条 HIGH。
  assertNotSymlink(abs, roots);
  return abs;
}

/**
 * 路径若存在且是 symlink 则抛 EPERM。不存在或非 symlink 静默放过。
 * 单一 syscall(fs.lstat 不 follow),与 notes/standalone.ts 共用同一套 fs.lstat 防御。
 *
 * 用 lstatSync 而非 async fs.lstat:assertInsideAllowedRoot 是 shell /
 * protocol 两个 IPC handler 的同步入口,改 async 会拉断所有 caller
 * (包括 shell-ipc.test.ts / protocol.test.ts 等 mock 都要改 await)。lstatSync
 * 在正常 hot path 上 ~0.1ms,同步 vs async 差异不可观察;但保留同步契约让
 * 现有调用方零修改。
 *
 * audit r28 (2026-09-21):realpath 链防御。单纯 lstat(target) 只验末端;
 *   中间任意目录段被换成 symlink 后,target lstat 是「不是 symlink」
 *   通过,但实际 open / read 时跟随 foo/ → /etc。修法:realpathSync 解析
 *   整个链路,比较 root 是否落在任一 allowed root 内 —— 路径不存在
 *   (ENOENT)/ 链上某段不存在(rfc3168 ENOTDIR)/权限翻转(EACCES)静默放过,
 *   后续 fs.open 自己抛真错误,这里不阻断 create 之类的"先校验再写"。
 *   realpath 自身会 follow 末段 symlink,所以末尾 symlink 直接由
 *   lstat 兜底(已存在时 realpath !== resolve(target) 等价于 symlink)。
 *
 * audit 2026-10-06(HIGH):`roots` 参数 —— realpath 链防御必须对照**调用方自己
 *   的白名单**校验,不能把 allowedRoots() 写死在函数体内。
 *   旧实现让 realpath 复查硬编码走 allowedRoots(),而本函数被
 *   assertInsideAllowedRoot 之外的潜在调用方使用不同的根集合时会误杀。
 *   修法:把调用方的根集合传进来(默认值保持 allowedRoots(),读白名单调用点
 *   行为不变),**两道防线都不放松**:lstat 仍拒末段 symlink,realpath 仍拒
 *   「中间段被换成 symlink 导致逃逸出同一套白名单」。
 */
// audit r52 (2026-10-16):realpath 链防御上限 —— 把 realpath 循环跑**多次**
//   直到非 symlink / 落点在白名单内 / 撞深度上限,任一停止条件命中即返。
//
// 取 8:Windows / Linux / macOS 上「合法 + 真实场景」几乎不可能超过 4-5 层
//   (典型就是 rootPath/notes → workspace → 用户自定义重定向,4 层足矣)。
//   8 是 generous 上限 —— 防恶意构造 a → b → c → ... 无限循环把 realpath
//   栈打爆。realpathSync 自身在循环链上抛 ELOOP,所以「链太长」防御
//   实际命中的是 FS 边界 (NTFS junction 嵌套 / 重解析点嵌套) ——
//   这种场景用户即使不是攻击者,也大概率是配置错误,拒掉更安全。
const MAX_CHAIN_DEPTH = 8;

export function assertNotSymlink(abs: string, roots: readonly string[] = allowedRoots()): void {
  // 第一道防线:input 自身的 lstat。symlink 立即拒,这是 r13 H-SYM-1
  //   引入的契约 —— 现有测试 tests/unit/main/ipc/paths.test.ts 锁这条
  //   行为("白名单内但 lstat 是 symlink → EPERM"),保留向后兼容
  //   (r229 补齐 31 例单测)。
  let lst;
  try {
    lst = lstatSync(abs);
  } catch (err: unknown) {
    // audit 2026-09-21 audit-r24:区分 ENOENT(静默放过,符合原契约)与其他错误
    //   (EACCES / EIO / ELOOP / EMFILE) → warn 一行,便于事后排查安全关键
    //   路径上的 syscall 异常。安全检查路径上 swallow 所有错误无 trace 是
    //   defense-in-depth 反模式(见 audit-r24 finding)。
    // audit 2026-09-21 batch-migration C3R50:走 errnoCode() 共享 helper,
    //   不再 inline `(err as NodeJS.ErrnoException)?.code`(类型不安全 +
    //   漏掉非 errno 例外如 LibraryError)。errnoCode 返回 string|undefined,
    //   行为等价。
    const code = errnoCode(err);
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      log.warn('[assertNotSymlink] lstat failed', { abs, code });
    }
    return;
  }
  if (lst.isSymbolicLink()) {
    throw new AppError('EPERM', `path is a symlink (refusing to follow): ${abs}`);
  }
  // 第二道防线:realpath 链检查(单次 realpath 调用,resolve 整条链路)。
  //   这是 r28 / r52 引入的「中间目录被换成 symlink → 跳到 root 外」防御
  //   —— lstat 看末端不是 symlink,realpath 解析链路却发现落点在 root 外。
  //   realpathSync 内部会跟随整条链,所以 a → b → c → outside 一次性就被
  //   解析到 outside,在 single realpath 调用里就被 catch。
  let realAbs: string;
  try {
    realAbs = realpathSync(abs);
  } catch (err: unknown) {
    // audit r28:ENOENT / ENOTDIR 静默放过 —— 不存在路径不在白名单防御范围,
    //   后续 fs.open 自己抛。ELOOP(circular symlink chain)同处理 —— 与
    //   旧行为对齐,避免回归。
    const code = errnoCode(err);
    if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'ELOOP') {
      log.warn('[assertNotSymlink] realpath failed', { abs, code });
    }
    return;
  }
  // 第二道防线的关键判定:realpath 解析后的落点必须在白名单内。
  //   audit-r229:用 realpath-aware 口径 —— 根自身是 symlink/junction 时,
  //   落点落在「realpath 后的根」内也是**合法**(见 isInsideRootsRealpathAware
  //   头注的 bug 复现与同源修法)。
  if (!isInsideRootsRealpathAware(roots, realAbs)) {
    // audit-r244:同 assertInsideAllowedRoot —— 消息不含路径(EPERM 原样透传),
    //   完整链路只进 main 侧日志。
    log.warn('symlink chain resolves outside allowed roots', { abs, realAbs, roots });
    throw new AppError('EPERM', 'path resolves outside allowed roots (symlink chain)');
  }
  // 第三道防线(防御性深度,r52 引入):realpath 返回的路径本身仍可能是 symlink
  //   (罕见 FS 边界场景 —— 部分 NTFS junction 嵌套 / 重解析点嵌套会让 realpath
  //   一次性解析后返回一个相对路径 / 二次 symlink)。这里用 readlink-style
  //   单跳循环跟随,直到非 symlink / 撞深度上限 / 出白名单。MAX_CHAIN_DEPTH=8
  //   是 paranoid bound,绝大多数真实场景 1-2 跳就停。
  let cur = realAbs;
  for (let i = 0; i < MAX_CHAIN_DEPTH; i++) {
    let hopLst;
    try {
      hopLst = lstatSync(cur);
    } catch (err: unknown) {
      const code = errnoCode(err);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        log.warn('[assertNotSymlink] chain lstat failed', { abs: cur, code });
      }
      return;
    }
    if (!hopLst.isSymbolicLink()) return;
    let next: string;
    try {
      next = realpathSync(cur);
    } catch (err: unknown) {
      const code = errnoCode(err);
      if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'ELOOP') {
        log.warn('[assertNotSymlink] chain realpath failed', { abs: cur, code });
      }
      return;
    }
    if (next === cur) return;
    if (!isInsideRootsRealpathAware(roots, next)) {
      // audit-r244:同 assertInsideAllowedRoot —— 消息不含路径。
      log.warn('symlink hop resolves outside allowed roots', { cur, next, roots });
      throw new AppError('EPERM', 'path resolves outside allowed roots (symlink chain)');
    }
    cur = next;
  }
  // 走完 MAX_CHAIN_DEPTH 还没收敛 —— 极少见,但仍按 brief 抛 EPERM。
  //   真实场景下,realpath 已把所有 hop 折叠到 cur,这里的循环大多 0 次
  //   迭代;这条防御只在 FS 边界嵌套场景(罕见)下生效。
  // audit-r244:同 assertInsideAllowedRoot —— 消息不含路径。
  log.warn('symlink chain depth exceeded', { abs, depth: MAX_CHAIN_DEPTH });
  throw new AppError('EPERM', `symlink chain depth > ${MAX_CHAIN_DEPTH}`);
}
