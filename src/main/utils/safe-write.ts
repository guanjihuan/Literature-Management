// 安全写操作:确保所有写操作目标在数据路径内
// 任何试图写入库路径或外部路径的操作都会抛错
import { promises as fs, realpathSync } from 'fs';
import { randomBytes } from 'crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { shell } from 'electron';
import { AppError, errnoCode, errMsg } from './error';
// r165 (2026-10-19):不再 `import { tr } from '../i18n'` —— 那条边通过
//   settings/store 形成循环依赖。改为从零依赖的 i18n-dict 拿字典,当前
//   语言由 setI18nLangProvider 注册的 getter 解析(未注册前回退 zh-CN,
//   main/index.ts 在 import 顶层做一次注入)。
import { resolveT, type Lang } from '../i18n-dict';
import { createLogger } from './logger';
// audit round 10 (2026-09-15):H5 — 共享 isCaseInsensitiveFs 替代内联
//   `process.platform === 'win32' || process.platform === 'darwin'` 谓词,
//   与 fs-cache.ts / window.ts 同源,新增 CI 平台只改 utils/platform.ts 一处。
import { isCaseInsensitiveFs, needsDirFsyncForRename } from './platform';
const log = createLogger('safe-write');
import { retryOnWindowsTransient } from './retry-transient';
// r161+ disk-folder:共享 DiskFolderNode 类型
// r174:kind → 物理目录名映射的唯一真相 —— WORKSPACE_DATA_LAYOUT。
//   kind 是**逻辑**域('note' / 'literature'),磁盘目录名却是
//   'notes' / 'literature'(note 与 notes 差一个 s)。以前 listSubdirs
//   直接 `join(rootPath, kind, ...)`,notes 域于是去读 <root>/note ——
//   不存在 → readdir ENOENT → 静默返 [] → 笔记侧栏一个文件夹都不显示
//   (文献域侥幸:kind 'literature' 恰好等于目录名)。
//   磁盘目录名一律走本常量,不再散落字面量。
import { WORKSPACE_DATA_LAYOUT, type DiskFolderNode } from '../../shared/types';
// r186:目录名过滤与路径校验**共用同一份**核心规则(shared/rel-path.ts)——
//   不变量 I2「列得出来的,一定能进得去」。判据另写一份就会分叉,分叉
//   的后果就是用户报的「点进去报错」的夹。
import { isValidRelPathSegment } from '../../shared/rel-path';
// audit C3R50 (2026-08-22):safeUnlink 内 inline errno 提取已被本文件上方 import 的
// errnoCode helper 覆盖 — 本 helper 内部仍然用 `(err as { code?: unknown }).code`
// (utils/error.ts 的 helper 自身),不重复迁移。下方 safeUnlink 同步迁移。

// r165 (2026-10-19):langProvider 注册表 —— i18n.ts 通过 setI18nLangProvider
//   注入 safeLang 引用(主进程启动早期调一次),safe-write 的本地 tr() 在抛
//   AppError 走 key 解析时取该 getter 的返回值。未注册前任何调用回退 zh-CN
//   (settings 还没初始化等极端情况下,只发生在 app 还没起来时的 very-early
//   阶段,主进程 index.ts 顶层 import 链已保证注入在所有 IPC handler 之前
//   完成 —— 即 r165 wiring 不变量)。
let langProvider: () => Lang = () => 'zh-CN';
export function setI18nLangProvider(p: () => Lang): void {
  langProvider = p;
}

/** safe-write.ts 本地 tr():与 i18n.ts 的 tr() 等价,但读 langProvider 槽而非
 *  直接调 safeLang()(避免回引 i18n.ts 形成循环)。占位符替换语义同 i18n.ts。 */
function tr(key: string, params?: Record<string, string | number>): string {
  return resolveT(key, langProvider(), params);
}

// audit round 18 (2026-08-27):原子写 tmp 文件名加 8 字符 base64url 随机后缀 + 用
// 'wx'(exclusive create)而不是 'w',两个目的:
//   1. 'w' 模式会 truncate 已存在的同名文件 + 跟随符号链接;预置的
//      <target>.tmp 符号链接能把数据写出 dataPath 外,绕过 resolveInsideDataPath。
//      'wx' 在目标已存在(包括 symlink)时抛 EEXIST,写入被拒。
//   2. 随机后缀让并发写(同一 target 的不同 caller)各自拿独立的 tmp,
//      即使 WriteLock 漏掉的边角场景(sidecar / providers),也不会互相 truncate。
// base64url 8 字符 ≈ 48 bit 熵 — 单用户应用写冲突幂等概率 ~0。

// audit C2R2 (2026-08-22):继承 AppError 而不是裸 Error。
// 之前 UnsafeWriteError extends Error,在 IPC wrap.ts handle() 里
// 只走 `else { new AppError('INTERNAL', ...) }` 兜底,失去"安全拒绝"
// 的语义 — renderer 端无法区分"安全策略阻止" vs "通用内部错误"。
// 继承 AppError 后,wrap.ts 的 `err instanceof AppError` 分支会透传
// code='UNSAFE_WRITE',renderer 可以针对性提示(例如"路径不允许"
// 而非"内部错误")。atomic-file.ts 内的 `err instanceof UnsafeWriteError`
// 检测仍可用(继承链未变)。
export class UnsafeWriteError extends AppError {
  constructor(target: string, dataPath: string) {
    super(
      'UNSAFE_WRITE',
      `Refusing to write outside data path.\n  target: ${target}\n  dataPath: ${dataPath}`,
    );
    this.name = 'UnsafeWriteError';
  }
}

let currentDataPath: string | null = null;

// workspace-unification(2026-09-23 起,2026-10-02 接线完成)
//
//   这对函数的原名是 setDataPath / getDataPath —— 它们把「数据目录」当成一个
//   模块级单例,但 AppSettings 历史上 libraryPath(也是路径、却不是「数据目录」)
//   与它并列。统一到 rootPath 后,notes/ workspace/ library/ settings.json
//   全都归 rootPath 管,`dataPath` 这个名字就偏窄了。
//
//   演进是分两步走的,第二步(2026-10-02)刚完成:
//     1. 2026-09-23 加 setRootPath/getRootPath 作为 @deprecated 转发别名
//     2. 2026-10-02 把**全部 call site** 切到新名字,别名即退休
//   —— 这正是 ADR-0002 说的「接上 caller 之后即可删掉别名」。留着别名会让
//   下一个 contributor 以为两套名字都有语义,又是一次影子实现。
export function setRootPath(p: string): void {
  currentDataPath = resolve(p);
}

export function getRootPath(): string {
  if (!currentDataPath) {
    throw new AppError('INTERNAL', 'Root path not initialized. Call setRootPath() first.');
  }
  return currentDataPath;
}

/**
 * 把 target 解析为绝对路径,并校验其在 rootPath 内
 * 关键: 始终以 rootPath 为基准,避免相对路径被解析到 cwd
 * 返回已解析的绝对路径(供后续 fs.* 直接使用)
 *
 * audit 2026-09-11:Windows 大小写不敏感 —— 之前 `resolved.startsWith(dpWithSep)`
 *   是字面比较,`C:\Users\Foo` 与 `c:\users\foo` 不相等。`app.getPath('userData')`
 *   返回 canonical case (e.g. `C:\Users\…`),而 IPC 注入的 target 可能是 IPC 层
 *   任意来源,大小写不一定一致 → 误判 UnsafeWriteError。
 *   修:Windows 上两侧都 toLowerCase 比对。POSIX 文件系统大小写敏感,不动。
 * audit 2026-09-14 r7:macOS (darwin) 大小写不敏感 —— APFS 自 10.13 默认格式
 *   是 case-insensitive(用户主动格式化时才能选 case-sensitive,99%+ 用户用默认),
 *   与 HFS+ 一致。`safe-write` / `fs-cache` / `window.ts` 之前只 win32 走
 *   lowercase,导致 macOS 上 `~/Documents/ResearchHub/data` 与 IPC 传过来的
 *   `~/documents/researchhub/data` 不匹配 → 误抛 UnsafeWriteError / 缓存
 *   miss 反复 stat。扩到 win32 + darwin。Linux 不动(ext4 走 case-sensitive)。
 */
function resolveInsideDataPath(target: string): string {
  const dp = getRootPath();
  const resolved = isAbsolute(target) ? resolve(target) : resolve(dp, target);
  const dpWithSep = dp.endsWith(sep) ? dp : dp + sep;
  // audit round 10 (2026-09-15):H5 — 走共享 isCaseInsensitiveFs 替代内联
  //   `process.platform === 'win32' || process.platform === 'darwin'` 谓词,
  //   与 fs-cache.ts / window.ts 同一来源。
  const ci = isCaseInsensitiveFs;
  // audit 2026-10-08 (HIGH):fold helper 提到函数顶部 —— 之前定义在 outer try
  //   内,inner catch (ENOENT 父目录 realpath 兜底)看不到。提到顶部,父目录
  //   realpath 比对时也走同一份 case-insensitive 折叠。
  const fold = (p: string): string => (ci ? p.toLowerCase() : p);
  const matchSame = ci ? fold(resolved) === fold(dp) : resolved === dp;
  const matchInside = ci
    ? fold(resolved).startsWith(fold(dpWithSep))
    : resolved.startsWith(dpWithSep);
  if (!matchSame && !matchInside) {
    throw new UnsafeWriteError(resolved, dp);
  }
  // audit r28 (2026-09-21):realpath 防御中间路径 symlink —— path.relative
  //   / startsWith 只比字符串,target 字符串合规 ≠ 实际写到 dataPath 内。
  //   攻击者把 dataPath/notes/foo 替换成指向 /etc 的 symlink,后续
  //   safeWriteFileAtomic 的 tmp.open('wx') 仍写进「dataPath 内」的字符串
  //   路径,但内容落到了 symlink target。把 safeWriteFileAtomic 的 resolved
  //   路径也做一次 realpath 检查 —— 已存在的路径解析真实位置必须仍在
  //   dataPath 内(允许跨大小写),否则走 UNSAFE_WRITE 抛错。ENOENT 等
  //   "路径不存在" 静默放过(create 路径后续 mkdir 兜底 + atomic 写新建)。
  //
  // audit 2026-10-01:HIGH — 修正比较基准,两侧必须同口径 realpath。
  //   旧实现拿 `realpath(target)` 去比**未 realpath 的** dp。Node 的
  //   realpathSync 会把整条链路解析到物理位置,于是只要 data 根路径自身
  //   位于 symlink / junction 之下,real(target) 就与 dp 不在同一棵树上,
  //   relative() 必然产出 '..' 前缀 → 抛 UNSAFE_WRITE。
  //   实测复现(Windows junction,无符号链接逃逸、纯合法写入):
  //     dataPath = C:\...\junction-data  (→ C:\...\real-data)
  //     target   = C:\...\junction-data\notes\a.md
  //     real     = C:\...\real-data\notes\a.md
  //     relative(dp, real) = '..\real-data\notes\a.md'  → REJECT
  //   影响面对这个应用特别大:README 明确建议把数据目录丢 OneDrive /
  //   Dropbox / iCloud,而这些云盘文件夹在 Windows 上**常常是 reparse
  //   point**;`utils/path-check.ts` 更是直接教用户 `mklink /J` 建 junction
  //   绕 MAX_PATH。于是这类用户会遇到「所有保存都报路径不允许」,而磁盘上
  //   的旧数据仍能读(读路径不过本函数),现象极具迷惑性。
  //
  //   修法:两侧都 realpath 后再比。realDp 解析不出来(根还没建 / 权限被剥)
  //   时退回原有的「只比明文 dp」,与下方 target ENOENT 的既有契约一致 ——
  //   「无法验证就不阻断,让上层 fs 报真错误」,而不是把用户锁在门外。
  try {
    const real = realpathSync(resolved);
    let realDp: string | null = null;
    try {
      realDp = realpathSync(dp);
    } catch {
      // 根不可解析 —— 只能退回明文比较(见上方说明)
      realDp = null;
    }
    // 用 path.relative 比 startsWith 更稳:跨平台路径分隔符(Win \  vs POSIX /)
    //   在 memfs / 测试环境下 real 与 dp 可能形态不同(Win32 resolve 把
    //   '/data' 变成 'C:\data',real 仍 '/data/notes/a.md'),但 relative
    //   会把两侧 normalize 成同一形态后再算偏移。case-insensitive FS 上再
    //   两侧 lowercase 折叠 —— 与 startsWith 逻辑同口径。
    const relPlain = relative(fold(dp), fold(real));
    const insidePlain = relPlain === '' || (!relPlain.startsWith('..') && !isAbsolute(relPlain));
    // 目标「同时」在明文根或 realpath 根之内即放行。逃逸场景两侧都不满足
    //   (real 落在两棵树之外),仍然被拒 —— 修正确认不削弱 symlink 防护。
    const insideReal =
      realDp !== null &&
      (() => {
        const relReal = relative(fold(realDp), fold(real));
        return relReal === '' || (!relReal.startsWith('..') && !isAbsolute(relReal));
      })();
    if (!insidePlain && !insideReal) {
      throw new UnsafeWriteError(real, dp);
    }
  } catch (err: unknown) {
    if (err instanceof UnsafeWriteError) throw err;
    // audit 2026-10-08 (HIGH):ENOENT/ENOTDIR 分支必须校验父目录 —— 旧实现
    //   静默放过(target 不存在 → mkdir 兜底 + atomic 写新建)。但攻击者把
    //   `dataPath/notes` 替换为指向 /etc 的 symlink,target 不存在(realpath
    //   抛 ENOENT),旧 catch 直接 return resolved,后续 atomic 写跟着 symlink
    //   把内容写到 dataPath 外 → 绕过所有字符串 + 明文根防御。
    //   修法:ENOENT/ENOTDIR 时单独 realpath 父目录,父目录解析到 dataPath 外
    //   → UnsafeWriteError(走 same 双重根比对)。其它 errno 分桶处理:
    //     ELOOP — symlink 循环,永远不是合法场景,直接拒(不该 warn-and-allow)
    //     EACCES/EPERM/EIO/EMFILE 等 — 仍 warn-and-allow(Defender 瞬态锁、
    //       一次性权限翻转,让上层 fs 抛真错;若硬拒会导致用户被锁在外面)。
    const code = errnoCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      try {
        const realParent = realpathSync(dirname(resolved));
        // 父目录走明文根 + realpath 根双重比对(同上,只是对象换成父目录)。
        // 明文比对防「父目录本身在 dataPath 内,但父目录 → 软链外部」场景;
        // realpath 比对防「父目录就是 dataPath 内某个软链解析后的位置」场景。
        const relPlain = relative(fold(dp), fold(realParent));
        const insidePlain =
          relPlain === '' || (!relPlain.startsWith('..') && !isAbsolute(relPlain));
        let realDp: string | null = null;
        try {
          realDp = realpathSync(dp);
        } catch {
          realDp = null;
        }
        const insideReal =
          realDp !== null &&
          (() => {
            const relReal = relative(fold(realDp), fold(realParent));
            return relReal === '' || (!relReal.startsWith('..') && !isAbsolute(relReal));
          })();
        if (!insidePlain && !insideReal) {
          throw new UnsafeWriteError(realParent, dp);
        }
      } catch (e: unknown) {
        if (e instanceof UnsafeWriteError) throw e;
        // 父目录 realpath 抛错(权限 / 根不可达) —— 与 target realpath 抛错
        // 同口径,放过让上层 fs 报真错,只 log warn(不淹没真正的 IO_ERROR)。
        const parentCode = errnoCode(e);
        // audit-r151:ELOOP 父目录分支必须显式拒,与 target-ELOOP 同口径
        //   (safe-write.ts:211-214)。原实现 parent-ELOOP 走默认 warn-and-allow,
        //   atomicWriteFileInternal 紧随其后的 mkdir recursive 在 symlink 环上
        //   会反复 mkdir 同一个路径直到 ELOOP 触发(撞上 OS hop limit,通常 40)
        //   → 用户得到的是一个迷惑的 fs.mkdir ELOOP 而不是清晰的 UNSAFE_WRITE。
        //   攻击者可构造 `dataPath/notes/sub/loop/.../loop` 让单次写入触发
        //   symlink 环,绕过字符串校验把数据写出 dataPath 外。
        if (parentCode === 'ELOOP') {
          throw new UnsafeWriteError(resolved, dp);
        }
        // audit-r164 N4:ENAMETOOLONG = 路径设计错误(单段 >255 字符 or 总长
        //   >PATH_MAX),不是 Defender 瞬态 / 一次性权限翻转,旧实现走
        //   warn-and-allow 让上层 fs 抛迷惑 ENAMETOOLONG。修:显式 reject
        //   VALIDATION(IPC union 内 code,renderer 走「路径过长」toast 区分
        //   「瞬态 IO」与「用户输入错误」),与 ELOOP 同款「path 形状错误」语义。
        if (parentCode === 'ENAMETOOLONG') {
          throw new AppError(
            'VALIDATION',
            `parent path exceeds OS limit: ${resolved}`,
          );
        }
        if (parentCode !== 'ENOENT' && parentCode !== 'ENOTDIR') {
          log.warn('resolveInsideDataPath: parent realpath failed', {
            resolved,
            code: parentCode,
          });
        }
      }
    } else if (code === 'ELOOP') {
      // ELOOP = symlink 循环。这是攻击/配置错误,不是 Defender 瞬态,直接拒。
      // 不 warn-and-allow,否则攻击者构造 symlink 循环就能绕过。
      throw new UnsafeWriteError(resolved, dp);
    } else if (code !== undefined) {
      // EACCES / EPERM / EIO / EMFILE / ... 仍 warn-and-allow(可能是 Defender /
      // 一次性权限翻转)。但 ELOOP 已在上方分支独立处理,这里不再讨论。
      log.warn('resolveInsideDataPath: realpath failed', { resolved, code });
    }
  }
  return resolved;
}

// audit C3R54 (2026-08-22):删 `safeWriteFile` 死代码 export。
// 安全非原子写这个 API 自从 codebase 全切到 atomic write 后就 0 caller
// (grep 确认 src/ 0 调用,test 文件 7 处全是测试该函数本身)。
// 需要 dataPath 内写入统一走 safeWriteFileAtomic(自带 fsync + EPERM retry + 清理)。
// 需要跨 dataPath / userData / 迁移路径写入走 atomicWriteFileInternal。
// 没有"普通写"需求 —— atomic 写本来就涵盖非 atomic 写的所有场景,
// 且更安全(避免断电/崩溃留半截文件)。
//
// 替代映射:
//   safeWriteFile(target, content) → safeWriteFileAtomic(target, content) // dataPath 内
//   safeWriteFile(target, content) → atomicWriteFileInternal(target, content) // 跨 dataPath

// audit 2026-10-08 (HIGH):导出 resolveInsideDataPath —— 原是 private,仅
//   safeWriteFileAtomic 内部用。notes/standalone.ts 的 createNote / renameNote
//   用裸 `fs.open('wx')`(line 333 / 449)实现「atomic exclusive create」语义,
//   不能换成 safeWriteFileAtomic(后者 tmp+rename 替换语义,丢 DUPLICATE_NAME
//   保证)。但这俩路径之前完全绕过 dataPath / symlink 校验 —— 把
//   resolveInsideDataPath 导出,在 fs.open('wx') 之前调一次,把字符串 +
//   父目录 realpath 防御接上,保留 `wx` 原子独占语义。
export { resolveInsideDataPath as resolveInsideRootPath };

export async function safeWriteFileAtomic(target: string, content: string | Buffer): Promise<void> {
  const resolved = resolveInsideDataPath(target);
  await atomicWriteFileInternal(resolved, content);
}

/**
 * 原子写文件 — 不做 dataPath 校验。
 *
 * audit C3R53 (2026-08-22):抽出此 helper 让 safeWriteFileAtomic 复用,同时也让
 * 之前因为 dataPath 校验拒掉而无法走 safeWriteFileAtomic 的 3 个 callsite
 * 也能拿到 fsync + EPERM retry + 失败清理的全套保护:
 *   - main/location.ts:121(legacy settings.json 复制,直接 fs.writeFile 无原子)
 *   - main/location.ts:159(writeLocation → userData/location.json,userData 在 dataPath 外)
 *   - main/settings/store.ts:135(migrateData → 新路径的 settings.json,旧 dataPath 校验拒掉)
 *
 * 这 3 个 callsite 都明确知道自己在写 userData / 新迁移路径,**必须**绕过 dataPath 校验
 * —— 但仍然需要 fsync + EPERM retry + 清理 tmp 的原子保证。本 helper 提供这两层:
 *   1. fsync tmp before rename → 断电/崩溃不会让 rename 成功但内容为 0 字节
 *   2. EPERM/EBUSY 退避 5 次 + 抖动 → Windows AV/Defender 持句柄导致 MoveFileEx 失败
 *   3. 任意阶段失败清理 .tmp,避免历史失败累积的孤儿文件
 *
 * 调用方责任:确保 `target` 是绝对路径或相对于当前合法的写入位置。
 * 此 helper 不做 safe-write 的 dataPath 边界校验。
 */
export async function atomicWriteFileInternal(
  target: string,
  content: string | Buffer,
): Promise<void> {
  await fs.mkdir(dirname(target), { recursive: true });
  // audit round 18:tmp 文件名加 marker + 8 字符 base64url 随机后缀,见 ATOMIC_TMP_PATTERN。
  const tmp = `${target}.${RKMS_TMP_MARKER}${randomBytes(6).toString('base64url')}.tmp`;
  // open + write + fsync + close:确保 tmp 内容已落盘后再 rename,
  // 否则断电/崩溃可能让 rename 成功但内容为 0 字节,目标文件无声损坏
  // 'wx' 防止 symlink write-through 绕过 resolveInsideDataPath。
  // 任何阶段失败都清理 .tmp,避免历史失败累积的孤儿文件
  let fh;
  try {
    fh = await fs.open(tmp, 'wx');
    await fh.writeFile(content);
    await fh.sync();
  } catch (err) {
    if (fh) {
      // audit 2026-09-14:write error 路径 close 改 warn,保留 throw 上抛 —— 上层
      //   已经 throw 了原 err,close 失败只是诊断信号,不再 swallow。
      // audit round 8 (2026-09-14):走 safeCloseFh helper,统一 close 失败日志形态。
      await safeCloseFh(fh, 'fh.close failed during safeWrite error path', log, { tmp });
    }
    // audit 2026-08-25:unlink 只吞 ENOENT —— 其他错误(权限 / Windows 锁文件)
    // 之前 swallow 会留下孤儿 .tmp,累积占盘。日志保留失败记录供 debug。
    await fs.unlink(tmp).catch((err: unknown) => {
      if (errnoCode(err) !== 'ENOENT') {
        log.warn('Failed to clean tmp on write error', { tmp, err: errMsg(err) });
      }
    });
    throw err;
  }
  // audit round 18:close() 也包到独立 try 里 — 如果 close 自己抛错(Windows
  // 上的 stale handle 等),旧实现 catch 不会触发,tmp 文件会一直留在磁盘上。
  try {
    await fh.close();
  } catch (closeErr) {
    // audit 2026-09-14:close 失败时 unlink 改 warn —— Windows stale handle 时 tmp
    //   残留信号丢失,无法后续清理。closeErr 上抛不变(写路径已经失败)。
    // audit round 8 (2026-09-14):close 失败这里保留 inline throw,不走 helper —
    //   helper 是"吞 close 失败,只 warn",但这里需要 rethrow closeErr。
    await fs
      .unlink(tmp)
      .catch((unlinkErr: unknown) =>
        log.warn('Failed to clean tmp on close error', { tmp, err: errMsg(unlinkErr) }),
      );
    throw closeErr;
  }
  // audit C3R66 (2026-08-22):EPERM/EBUSY transient retry 逻辑抽到
  // utils/retry-transient.ts,与 atomic-file.ts persist() 共享同一份退避策略。
  // C2R1 的 Windows EPERM 修复 + C2R20 的 off-by-one fix 现在由 helper 单一负责。
  await retryOnWindowsTransient(
    () => fs.rename(tmp, target),
    () => fs.unlink(tmp),
  );
  // audit 2026-10-04:rename 之后 fsync 父目录,让 rename 本身也持久化。
  // 见 fsyncParentDir 头注 —— atomic ≠ durability。
  await fsyncParentDir(target);
}

/**
 * 原子写的 tmp 命名约定 —— **两条写路径(safe-write / atomic-file)与本文件
 * 的残留清扫器共用同一份**,否则清扫器会扫不到自己该该扫的东西。
 *
 * 形态:`<target>.<RKMS_TMP_MARKER><8 字符 base64url>.tmp`
 * (`randomBytes(6)` → base64url 恰好 8 字符)。
 *
 * audit 2026-10-05:MEDIUM —— 中间那个 marker 是**必需**的,不是装饰。
 * 旧形态 `<target>.<8 字符>.tmp` 只靠 `[A-Za-z0-9_-]{8}` 匹配随机段,而这个
 * 字符类**没有任何用户文件不会命中**的形态:`实验记录.20250101.tmp`(8 位日期)
 * 完全落在类内 → 清扫器在下次启动把它 unlink 掉,**无 quarantine、无备份、
 * 无提示**。原注释写的「不会误伤用户自己命名的 .tmp 文件」是事实错误。
 * 随机段与用户命名段在字符层面无法区分,只能靠一个显式标记把两类文件名分开。
 *
 * marker 用 `rkms-a` 而不是更长的词:它只出现在本应用写出的 tmp 里,而用户
 * 自己命名时几乎不可能正好落在这个形态;同时保持文件名可读(崩溃后用户
 * 在资源管理器里一眼能看出这是本应用的残留)。
 *
 * 兼容性:旧约定(`<target>.<8 字符>.tmp`)留下的历史残留**不再被清扫**。
 * 这是有意的方向选择 —— 那个形态与用户命名不可区分,宁可不删,也不误删
 * 用户的数据;这类残留只占空间,不会影响功能(见 sweepOrphanTmpFiles 头注)。
 */
export const RKMS_TMP_MARKER = 'rkms-a';
export const ATOMIC_TMP_PATTERN = new RegExp(`\\.${RKMS_TMP_MARKER}[A-Za-z0-9_-]{8}\\.tmp$`);

/**
 * audit 2026-10-04:fsync 父目录 —— rename 本身的持久性。
 *
 * 原有实现只 `fh.sync()`(tmp 的数据块落盘)就 rename。**atomic 性与 durability
 * 是两件事**:POSIX 上 rename 提交要靠目录项落盘,目录不 fsync,断电后
 * rename 可能丢失 —— 现象是「保存时 UI 显示成功,重启后回到上一次的内容」,
 * 比报错更难查。本项目 README 明确建议把数据目录放 OneDrive / Dropbox /
 * iCloud,这些场景下用户对「保存没生效」尤其敏感。
 *
 * 只在 POSIX 生效(见 platform.ts 的 needsDirFsyncForRename 注释:Windows 上
 * 没有这个契约,而不是「尽力而为」)。任何失败都只 warn —— 目录 fsync 失败
 * 不代表内容没落盘,不该让一次成功的保存整体失败。
 */
async function fsyncParentDir(target: string): Promise<void> {
  if (!needsDirFsyncForRename) return;
  const dir = dirname(target);
  let dirFh: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    dirFh = await fs.open(dir, 'r');
    await dirFh.sync();
  } catch (err: unknown) {
    // macOS 上对目录 fs.open('r') 可能直接 EISDIR/EPERM(某些文件系统不支持
    // 目录 fsync)—— 这类平台的 rename 持久性由 FS 自身保证,不阻断写入。
    log.warn('fsync parent dir failed (rename durability not guaranteed)', {
      dir,
      err: errMsg(err),
    });
  } finally {
    await safeCloseFh(dirFh, 'fsync parent dir close failed', log, { path: dir });
  }
}

/**
 * audit 2026-10-04:清扫崩溃残留的原子写 tmp 文件。
 *
 * 背景:`atomicWriteFileInternal` 的流程是 open(wx) → write → fsync → close
 * → rename。进程在 close 与 rename 之间被杀(系统更新 / OOM / 用户强退)时,
 * `<name>.md.<rand>.tmp` 就留在用户的云盘目录里。全仓此前**没有任何清扫器**
 * —— 且这些文件对用户完全不可见:`collectNotePaths` 只收 `.md` 结尾的条目,
 * `.tmp` 既不会被扫描也不会被展示,永远不会自愈,反复断电会持续占盘。
 *
 * 安全性:只删符合 `ATOMIC_TMP_PATTERN` 的**普通文件**(symlink/目录不碰),
 * 文件名形如 `<target>.<8 字符 base64url>.tmp`。刻意**不**按 mtime 加时间窗 —— 那样会
 * 漏掉「刚崩完就启动」的情形,而那正是最需要清的一次。并发写期间的 tmp 呢?
 * 也不会误删:另一个进程正在写的 tmp 在 rename 之前被删,那次写会失败并
 * 走它自己的错误路径(重试/报错),不会产生半截目标文件 —— 目标文件本身
 * 从未被这个清扫器触碰。
 *
 * 返回清扫数量,供调用方记日志。
 */
export async function sweepOrphanTmpFiles(dir: string): Promise<number> {
  // audit-r80 (2026-10-17) LOW:递归清扫 —— 旧实现只 readdir 一层,而
  //   filename-validator 允许 `sub/note.md` 子目录笔记,子目录里的原子写
  //   残留(崩溃时 <name>.md.<rand>.tmp)永远扫不到,反复断电持续占盘。
  //   与 collectNotePaths 同约定:跳过 dot 目录、不跟 symlink(防递归环
  //   与越界),只 unlink 普通文件,目录形态不匹配也绝不 rmdir。
  return sweepDir(dir, 0);
}

// 与 notes watcher 同深度上限思路:子目录笔记实际深度有限,8 层兜底防
// 「非 symlink 的深嵌套」病态目录树拖慢启动。
const SWEEP_MAX_DEPTH = 8;

async function sweepDir(dir: string, depth: number): Promise<number> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err: unknown) {
    if (errnoCode(err) !== 'ENOENT' && errnoCode(err) !== 'ENOTDIR') {
      log.warn('sweepOrphanTmpFiles: readdir failed', { dir, code: errnoCode(err) });
    }
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < SWEEP_MAX_DEPTH) removed += await sweepDir(p, depth + 1);
      continue;
    }
    if (!ATOMIC_TMP_PATTERN.test(entry.name)) continue;
    try {
      // Dirent.isFile 之外再 lstat 确认:只删普通文件,symlink/目录形态不碰。
      const st = await fs.lstat(p);
      if (!st.isFile()) continue;
      await fs.unlink(p);
      removed += 1;
    } catch (err: unknown) {
      if (errnoCode(err) !== 'ENOENT') {
        log.warn('sweepOrphanTmpFiles: unlink failed', { p, code: errnoCode(err) });
      }
    }
  }
  if (removed > 0) log.info('Swept orphan atomic-write tmp files', { dir, removed });
  return removed;
}

/**
 * 2026-10-16 file-manager ops:安全回收站删除 —— 与 safeUnlink 对位,
 * 走 electron shell.trashItem(Win 回收站 / macOS Trash / Linux XDG trash),
 * 用户可从系统回收站恢复。
 *
 * 契约与 safeUnlink 对齐:
 *   - 路径必须解析到 rootPath 内(resolveInsideDataPath,外逃 → UNSAFE_WRITE)
 *   - 文件已不存在(ENOENT)当作成功吞掉 —— 外部 watcher / 用户 / 其他窗口
 *     已删时 IPC 不应失败
 *   - shell.trashItem 自身失败(平台回收站不可用 / 权限)包成 AppError
 *     IO_ERROR 冒泡,不静默
 */
export async function safeTrash(target: string): Promise<void> {
  const resolved = resolveInsideDataPath(target);
  let lst: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    lst = await fs.lstat(resolved);
  } catch (err: unknown) {
    if (errnoCode(err) === 'ENOENT') return;
    throw err;
  }
  // audit-r151:拒收 symlink —— shell.trashItem 在 Windows 上 follow symlink,
  //   resolveInsideDataPath 只校验字符串 + 父目录 realpath,遇到 planted
  //   symlink(dataPath/notes/foo → C:\Users\<user>\.ssh\id_rsa)会让用户
  //   点删除时把 dataPath 外的文件移进回收站。lstat 不 follow,这里拒绝
  //   symlink + 目录(目录走独立删除路径,不属于本 helper 契约)。
  // audit-r155:拆错误码 —— symlink 与目录语义不同,合并抛 UNSAFE_WRITE
  //   会让 UI 看到「unsafe write」误导用户(实际是「目录不能走 trash 入口」)。
  //   symlink 才是越界风险,UNSAFE_WRITE 合适;目录仅是 helper 契约不接,
  //   VALIDATION(可被 wrap.ts 透传 field=null)更准。
  // audit-r160:消息不再含 ${resolved} —— UNSAFE_WRITE / VALIDATION 与 IO_ERROR
  //   一样会被 wrap.ts 原样透传到 IPC wire,绝对路径会把用户家目录 / OneDrive
  //   路径暴露给 renderer / telemetry。改走 tr() 双语固定文案,errMsg(err) 留作
  //   主进程 log(IPC 边界外的诊断信号,不进 wire)。
  if (lst.isSymbolicLink()) {
    throw new AppError('UNSAFE_WRITE', tr('notes.trashRefusedSymlink'));
  }
  if (!lst.isFile()) {
    throw new AppError('VALIDATION', tr('notes.trashRefusedNonRegular'));
  }
  try {
    await shell.trashItem(resolved);
  } catch (err: unknown) {
    // audit-r137:不把 resolved 绝对路径拼到 message —— wrap.ts 非 INTERNAL 分支
    //   原样透传 IPC wire。r160 进一步走 tr() 双语,避免裸英文 `trash failed:` 前缀。
    throw new AppError('IO_ERROR', tr('notes.trashFailed', { reason: errMsg(err) }));
  }
}

export async function safeUnlink(target: string): Promise<void> {
  // 必须用 resolveInsideDataPath 已经解析的绝对路径删除 —— 不再次 resolve,
  // 否则相对路径会基于 process.cwd() 解析,绕过 dataPath 校验
  const resolved = resolveInsideDataPath(target);
  try {
    await fs.unlink(resolved);
  } catch (err: unknown) {
    if (errnoCode(err) !== 'ENOENT') throw err;
  }
}

// r161+ disk-folder —— 真实磁盘文件夹操作,fs 路径必须在 rootPath/<kind>/ 子树内
//   (走 resolveInsideDataPath 二次 realpath 越界 reject)。symlink 一律不 follow
//   (lstat 拒收 + safeTrash/safeRecursiveTrash 不 follow 走 trash),与 r155 safeTrash
//   范式一致,防止 planted symlink 把回收站外文件挪走。

/**
 * 安全创建目录(磁盘文件夹)——「新建文件夹」语义。
 *   target 是绝对路径或相对 rootPath 的路径,自动 resolveInsideDataPath 守门。
 *   行为:
 *     - 路径不存在 → fs.mkdir(..., { recursive: true }) 一次建父 + 自身
 *     - 路径存在且是目录 → no-op 幂等
 *     - 路径存在但不是目录 / 是 symlink → 抛 VALIDATION(与 caller 预期不一致)
 */
export async function safeMkdir(target: string): Promise<void> {
  const resolved = resolveInsideDataPath(target);
  let lst: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    lst = await fs.lstat(resolved);
  } catch (err: unknown) {
    if (errnoCode(err) === 'ENOENT') {
      await fs.mkdir(resolved, { recursive: true });
      return;
    }
    throw err;
  }
  if (lst.isSymbolicLink()) {
    // 与 safeTrash 范式一致:不 follow symlink,防止 planted symlink 越界
    throw new AppError('UNSAFE_WRITE', tr('diskFolder.mkdirRefusedSymlink'));
  }
  if (!lst.isDirectory()) {
    throw new AppError('VALIDATION', tr('diskFolder.mkdirRefusedNonDir'));
  }
  // 已存在的目录:幂等 no-op
}

/**
 * 安全递归删除目录走系统回收站 ——「删除文件夹」语义。
 *   target 是绝对路径或相对 rootPath 的路径,自动 resolveInsideDataPath 守门。
 *   行为:
 *     - 路径不存在(ENOENT) → no-op 成功(并发 watcher / 用户已删时 IPC 不该失败)
 *     - symlink → UNSAFE_WRITE(越界风险,单点拒绝)
 *     - 非目录文件 → VALIDATION(caller 错把它当文件夹丢)
 *     - 目录 → DFS 走深:每个文件走 safeTrash(走 lstat 拒收 symlink),每个
 *       子目录递归 trashDirContents + shell.trashItem 兜底(避免 shell.trashItem
 *       跨平台差异吞子项失败)
 */
export async function safeRecursiveTrash(target: string): Promise<void> {
  const resolved = resolveInsideDataPath(target);
  let lst: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    lst = await fs.lstat(resolved);
  } catch (err: unknown) {
    if (errnoCode(err) === 'ENOENT') return;
    throw err;
  }
  if (lst.isSymbolicLink()) {
    throw new AppError('UNSAFE_WRITE', tr('diskFolder.trashRefusedSymlink'));
  }
  if (!lst.isDirectory()) {
    throw new AppError('VALIDATION', tr('diskFolder.trashRefusedNonDir'));
  }
  await trashDirContents(resolved);
  try {
    await shell.trashItem(resolved);
  } catch (err: unknown) {
    throw new AppError('IO_ERROR', tr('diskFolder.trashFailed', { reason: errMsg(err) }));
  }
}

async function trashDirContents(dir: string): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err: unknown) {
    if (errnoCode(err) !== 'ENOENT') throw err;
    return;
  }
  for (const entry of entries) {
    const child = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      // audit-r243(2026-10-21):**不能**对 symlink 调 shell.trashItem ——
      //   shell.trashItem 在 Windows 上 **follow** symlink(见 safeTrash 头注
      //   r151:planted symlink 会把 dataPath 外的文件移进回收站)。旧实现
      //   这里的注释「lstat 已经挡过 planted 越界」是**错的**:上面 lstat
      //   的是**父目录**,子项 symlink 从没被 lstat 过,越界风险原样存在。
      //   实证后果:用户在 literature/links/ 放一个指向家目录某个 PDF 的
      //   symlink,再「删除文件夹 links/」⇒ **外部那个 PDF 被移进回收站**。
      //   正确做法:**删链接本身**而不是删它的目标 ——
      //     fs.unlink / fs.rm 对 symlink 路径都只摘链接,不 follow(unlink
      //     语义上就是「删目录项」)。
      //   链接指向的目标留在原处(用户没要求删它,也不该被顺手删)。
      //   用 fs.rm 而不是 fs.unlink:Windows 上「指向目录的 symlink」用
      //   unlink 会 EPERM(得用 rmdir),fs.rm 内部按 lstat 判定 ⇒ 两种
      //   symlink 都只摘链接本身。
      try {
        await fs.rm(child, { force: true, recursive: true });
      } catch (err: unknown) {
        if (errnoCode(err) === 'ENOENT') continue;
        throw new AppError('IO_ERROR', tr('diskFolder.trashFailed', { reason: errMsg(err) }));
      }
      continue;
    }
    if (entry.isDirectory()) {
      await trashDirContents(child);
      try {
        await shell.trashItem(child);
      } catch (err: unknown) {
        throw new AppError('IO_ERROR', tr('diskFolder.trashFailed', { reason: errMsg(err) }));
      }
    } else {
      // 单文件走 safeTrash(走 lstat + symlink reject + 回收站)
      await safeTrash(child);
    }
  }
}

/**
 * kind(逻辑域)→ 磁盘目录名(物理布局)。
 *   'note'       → 'notes'
 *   'literature' → 'literature'
 * r174:这是「笔记侧栏不显示文件夹」的唯一根因 —— 以前 listSubdirs 拿 kind
 *   当目录名直接 join,notes 域读的是 <root>/note(不存在),readdir ENOENT
 *   被当「空目录」静默吞掉,UI 侧一个文件夹行都没有,且没有任何报错。
 */
const KIND_DIR_NAME: Record<'note' | 'literature', string> = {
  note: WORKSPACE_DATA_LAYOUT.NOTES_DIR,
  literature: WORKSPACE_DATA_LAYOUT.LITERATURE_DIR,
};

/**
 * 列某 parentRelPath 的直接子目录(一层,非递归)。dot 隐藏 + symlink +
 *   非目录全部跳过;按名字自然序升序。返回 relPath(相对 kind 根)而非
 *   basename,renderer 端直接用于 enter() / 拖入目标 key。
 *   parentRelPath = '' 或 null = kind 树根。
 *   路径必须在 dataPath 内(主进程 callers 传的是绝对根 + 相对子路径,
 *   这里用 join,不做 resolveInsideDataPath 二次 realpath —— 子目录都
 *   是 chokidar / IPC 入口拿到的合法磁盘路径,中间层不需再越界检查)。
 */
export async function listSubdirs(
  rootPath: string,
  kind: 'note' | 'literature',
  parentRelPath: string | null,
): Promise<DiskFolderNode[]> {
  // r174:目录名走 KIND_DIR_NAME —— 逻辑 kind('note')≠ 物理目录('notes')。
  const dirName = KIND_DIR_NAME[kind];
  const target = parentRelPath
    ? join(rootPath, dirName, parentRelPath)
    : join(rootPath, dirName);
  let entries;
  try {
    entries = await fs.readdir(target, { withFileTypes: true });
  } catch (err: unknown) {
    if (errnoCode(err) === 'ENOENT') {
      // r174:目录不存在 → 空列表(合法:kind 根可能还没建)。
      //   但「目录名写错」也是 ENOENT —— r174 之前 notes 域去读 <root>/note
      //   就是这样静默返 [],UI 一个文件夹都不显示且零报错。留一条 debug
      //   日志,下次再出现目录名漂移时能从 main.log 看出来(生产 LOG_LEVEL
      //   默认 info,不会打扰用户)。
      log.debug('listSubdirs: directory not found', { kind, target, parentRelPath });
      return [];
    }
    throw err;
  }
  const out: DiskFolderNode[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isSymbolicLink()) continue;
    if (!entry.isDirectory()) continue;
    // r186 不变量 I2「列得出来的,一定能进得去」:目录名必须满足
    //   shared/rel-path 的核心段规则。否则 list-dirs 的 requireRelPath 会
    //   拒收它 → 用户点进去只得到一个 VALIDATION 报错,而里面的笔记在
    //   夹视图里看不到(列得出来、进不去)。判据与路径校验共用同一份
    //   规则,两边永远不会分叉。
    //   Windows 上除 dot 目录外不存在这种名字(不能含 '\'、控制字符),
    //   对正常用户零影响;Linux 上的极端目录名从「点进去报错」变成
    //   「不列」—— 与 dot 目录同一处理方式。
    if (!isValidRelPathSegment(entry.name)) continue;
    const childRel = parentRelPath ? `${parentRelPath}/${entry.name}` : entry.name;
    out.push({
      relPath: childRel,
      name: entry.name,
      parentRelPath,
    });
  }
  // 名字自然序升序(numeric + base sensitivity 与 folder-view 同款,
  //   共享语义:VS Code 文件管理列表排序)
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return out;
}

/**
 * 安全 rename:源和目标都必须在 dataPath 内。
 * 用途:settings/migration-layout.ts 在启动迁移期把 dataPath 内的老布局
 *   (notes/ workspace/) 一次性搬到 dataPath/data/ 下。
 *   audit 2026-09 (V1.6):头注原写 "notes/ sidecars/ ai/ collections/
 *   workspace/" —— sidecars / ai / collections 三个目录 2026-08-28
 *   整体下线,不在迁移清单中。trash module 2026-08-26 下线,只剩
 *   migration 一处 caller。
 * EXDEV 等跨设备错误向上抛,fs.rename 跨平台行为一致。
 */
export async function safeRename(source: string, target: string): Promise<void> {
  const src = resolveInsideDataPath(source);
  const dst = resolveInsideDataPath(target);
  // audit r35 (2026-10-08):MEDIUM — src === dst 早返。旧实现无脑 fs.rename,
  //   看似无害(同路径 rename 在 POSIX 下 no-op),实则在 Windows 上若中途路径
  //   被替换为 symlink(典型场景:夹在 resolveInsideDataPath 与 fs.rename 之间的
  //   几个 await 给了 attacker / 恶意插件 TOCTOU 窗口),rename 会真的动到
  //   symlink 目标文件,且部分 Windows 版本会报 ERROR_ALREADY_EXISTS 并被
  //   retryOnWindowsTransient 误判为瞬时占用、反复重试。早返后这段 TOCTOU
  //   路径整段消失,且与「重命名到自身」的语义意图一致(就是 no-op)。
  if (src === dst) return;
  await fs.mkdir(dirname(dst), { recursive: true });
  // audit 2026-10-01:MEDIUM — 补退避重试。两条原子写路径
  //   (atomicWriteFileInternal / atomic-file.persist)都走 retryOnWindowsTransient,
  //   唯独这里曾是裸 fs.rename。启动期目录 rename 撞上 Defender / Windows
  //   Search / 云盘同步客户端的瞬时占用(EBUSY/EPERM)是高频场景,而调用方
  //   (settings/migration-layout.ts)把失败降级成 warn + 继续启动 —— 结果是
  //   「源目录没搬过去,应用却已按新布局读空目录」,用户看起来就是笔记凭空消失。
  //   cleanup 传 noop:目录 rename 失败时**绝不能**删源(那是唯一的用户数据)。
  await retryOnWindowsTransient(
    () => fs.rename(src, dst),
    () => Promise.resolve(),
  );
}

/**
 * 兜底 close 文件句柄 + 失败时 warn 一行日志。
 *
 * audit round 8 (2026-09-14):替换全仓 11 处 verbatim 的 `fh?.close().catch((err) =>
 *   log.warn('fh.close failed in <label>', { path, err: errMsg(err) }))` 模板 ———
 *   11 处散落在 notes / ipc / settings / utils,每个 label + meta 字段都不一样,
 *   任何一处漂移(忘了加 tmp / 改了 label 拼写)只能 grep 兜底。集中后:
 *     - close 失败的统一日志形态:{ label, path?, tmp?, err }
 *     - caller 只关心 label,不再复制 errMsg + meta boilerplate
 *     - safe-write.ts 自身 2 处内部 close 也走这个 helper,行为与外部一致
 *
 * 不做 fail-fast:close 失败在 finally / 错误回滚路径里通常是次要信号
 * (主 err 已经 throw 或要 throw),只 warn 不 throw,避免 swallow 主 err。
 */
export async function safeCloseFh(
  fh: Awaited<ReturnType<typeof fs.open>> | null,
  label: string,
  localLog: { warn: (msg: string, meta?: Record<string, unknown>) => void },
  extra?: { path?: string; tmp?: string },
): Promise<void> {
  if (!fh) return;
  await fh
    .close()
    .catch((closeErr: unknown) => localLog.warn(label, { ...extra, err: errMsg(closeErr) }));
}
