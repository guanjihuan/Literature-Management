// perf(2026-08-24):mtime-keyed parse cache for file reads.
//
// 用途:同一进程内,同一文件多次读 + parse(frontmatter / markdown body / AI JSON)
// 的场景下,缓存 parse 结果,mtime 变了才重 parse。
//   - readStandaloneNote(notes 编辑时高频读)
//
// 实现:Map<absPath, { mtimeMs, size, ino, value }>。读 cache 时若 mtime/size/ino
// 都一致直接返回,不一致或文件不存在则调底层 reader,结果回填。
// 写操作必须 invalidate(否则读到 stale 数据)。
//
// 注意:缓存是 per-process;主进程单实例所以天然安全。
// 估算收益:gray-matter parse 一次 ~5-30ms,缓存命中 <0.1ms,差距 50-300x。
//
// 设计取舍:不做容量上限(bounded LRU)。LibraryService 处理文件 ≤ 10k,
// 缓存键 ≤ 10k,平均每条 ~200B → ~2MB,可控。后期需要 cap 时再加。
//
// audit 2026-09-14:cache 入口(2026-08-24)引入时 close 走 swallow 没补日志,
//   Windows stale handle 让 fd 泄漏信号丢失。补 log.warn 走 createLogger。
import { createLogger } from './logger';

const log = createLogger('fs-cache');
//
// audit round 18 (2026-08-27):
//   1. 缓存键 absPath 在 win32 下统一 lowercase — 否则 C:\x\A.md 与
//      C:\x\a.md 视为两个文件,symlink 链接 / Git checkout 在大小写不敏感
//      的 Windows 上会让 cache hit 但内容是另一文件。
//   2. cache key 加 size + ino — 旧版仅 mtimeMs 时,backup 还原 / git checkout
//      把 mtime 设回原值,fs.open 拿到的内容是新版本,但 cache 命中 stale。
//      size/ino 不同即代表"是另一份内容",安全 reparse。
import { promises as fs } from 'fs';
import { errnoCode } from './error';
import { safeCloseFh } from './safe-write';
import { isCaseInsensitiveFs } from './platform';

interface CacheEntry<T> {
  mtimeMs: number;
  /** 文件 size:加进 cache key 防止 mtime 巧合撞上。 */
  size: number;
  /** inode 号:加进 cache key 防止替换文件。 */
  ino: number;
  /** parser 的返回值(parser 可以主动返 null 作为业务值)。 */
  value: T;
}

// perf(2026-08-28):bounded FIFO —— 旧注释说"LibraryService ≤ 10k,缓存键 ≤ 10k,
// 平均每条 ~200B → ~2MB,可控",但 watcher 推送 + scan 期间 hot reload + 笔记
// 编辑 readNote 都共用同一张 Map,极端场景(chokidar add 风暴 + 用户编辑大
// 笔记)能拉到 30k+ 条 ≈ 6MB,内存里挂着。
// 上限设 20k:典型项目命中大半,异常情况只丢冷条目。FIFO(insertion order
// 由 Map 自身保证)替代 LRU —— 简单 O(1),没有 hit/miss 双向链表维护成本;
// 冷条目重新 read 一次只需一次 stat(命中 fs-cache 缓存逻辑照样生效)。
const FS_CACHE_MAX_ENTRIES = 20_000;

function setWithCap(key: string, entry: CacheEntry<unknown>): void {
  // 删旧值(如已是 cached),避免 set 完 size 异常膨胀
  if (caches.has(key)) caches.delete(key);
  caches.set(key, entry);
  // Map 保留 insertion order,keys() 第一个 = 最老;超 cap 时弹掉一个
  if (caches.size > FS_CACHE_MAX_ENTRIES) {
    const oldest = caches.keys().next().value;
    if (oldest !== undefined) caches.delete(oldest);
  }
}

const caches = new Map<string, CacheEntry<unknown>>();

/** win32 + darwin 下把路径标准化成小写,其他 POSIX (Linux 等) 原样返回。
 * `\\?\` 前缀长路径保留大小写,但本项目所有 caller 都用 resolve() 出来的
 * 普通路径,不走那个前缀;统一 lowercase 即可。macOS APFS 默认 case-insensitive
 * (见 safe-write.ts:resolveInsideDataPath 同款 r7 注释)。
 *
 * audit r33 (2026-09-23):从 module-private 升级到 export —— watcher.ts
 *   dedupe map / settings 等所有需要 case-insensitive 路径 key 的 caller
 *   都走这一份,避免与 fs-cache 内部 map key 不一致导致「fs-cache 命中
 *   但 watcher dedupe miss」 之类的 race。 */
export function caseInsensitiveFsKey(absPath: string): string {
  // audit round 10 (2026-09-15):H5 — 共享 isCaseInsensitiveFs 替代内联谓词。
  return isCaseInsensitiveFs ? absPath.toLowerCase() : absPath;
}

// 内部仍以短名 cacheKey 引用(无外部调用,避免大改内部 helpers)
function cacheKey(absPath: string): string {
  return caseInsensitiveFsKey(absPath);
}

/**
 * 读文件并解析,结果按 (absPath, mtimeMs) 缓存。
 * 解析器 fn 接收原始文件内容,返回任意结构化的解析结果(允许返回 null)。
 *
 * 返回:{ value, mtimeMs } | null
 *   - 文件不存在(ENOENT)→ null(直接返回,**不进缓存** —— 见下方 r197 段)
 *   - 文件存在 + 解析成功 → { value, mtimeMs }
 *   - 其它 IO 错误(EACCES / ELOOP / EIO 等)→ 直接 throw,让 caller 区分
 *
 * 注(2026-08-25 → r197 修订):"missing" 与 "value === null" 曾用两个独立
 *   状态表达,理由是 `() => null` 这种 parser 的 null 不该被当成"文件不存在"。
 *   现在**不需要**两个状态了 —— 文件不存在的情况**根本不进缓存**(返回
 *   null 时不写缓存),于是缓存里只可能有「parser 主动返回的 null」。
 *   旧的负缓存(missing=true)是**死代码**:写进去的条目 mtimeMs/size/ino 全是
 *   -1,而读路径要先 open 成功才查缓存 ⇒ 负缓存条目永远命中不了(且
 *   `cached.missing` 分支恒为 false)⇒ 它只是白占一个缓存槽位、把真正
 *   的热条目挤掉(FIFO cap 20k)。r197 删掉它,并把「负缓存」的实现意图
 *   记录在此:文件可能在下一瞬被创建(用户新建笔记 / 外部工具落盘),真要
 *   缓存「缺失」必须带 TTL,否则新建的文件会被缓存的 missing 吞掉。
 *
 * 注:返回 mtimeMs 让 caller 不必再二次 stat —— 之前 standalone.ts readNote
 * 走 cachedReadParse 后又 fs.stat 一次拿 mtime,在 cachedReadParse 与 stat 之间
 * 存在微弱 TOCTOU 窗口(stat 后文件被替换会让 StandaloneNote.mtime 与缓存里的
 * 旧 value 不一致)。caller 直接用本次 open 拿到的 mtime,杜绝这个 race。
 *
 * audit 2026-08-26:用 fs.open + fh.stat + fh.readFile 单 fd 替代之前的
 * fs.stat + fs.readFile 两步 —— 后者在 stat 与 read 之间存在 TOCTOU 窗口
 * (扫描 / 编辑过程中文件被替换 / 截断),mtime 与内容可能来自不同 inode。
 * 单 fd 把 size check + content 拿到绑到同一 inode。
 */
export async function cachedReadParse<T>(
  absPath: string,
  parser: (raw: string) => T,
): Promise<{ value: T; mtimeMs: number } | null> {
  const key = cacheKey(absPath);
  let fh: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    try {
      fh = await fs.open(absPath, 'r');
    } catch (err: unknown) {
      // 仅 ENOENT 视为"文件不存在" → 直接返 null;EACCES / ELOOP / EIO 等
      // 是真实错误,透出让 caller 决定(典型:library/service.ts indexOneFile
      // 把 EACCES 转 LibraryError 弹给 UI;旧实现所有 stat 失败都吞 → EACCES
      // 永久缓存成 missing,UI 永远看不到权限错)。
      // r197:不再写「负缓存」条目 —— 它永远命中不了(读路径要先 open 成功
      //   才查缓存),只是白占一个 FIFO 槽位把热条目挤掉。详见上方头注。
      if (errnoCode(err) === 'ENOENT') {
        return null;
      }
      throw err;
    }
    const st = await fh.stat();
    const cached = caches.get(key);
    // audit round 18:cache hit 条件加 size + ino — 仅 mtime 时,git checkout
    // / backup restore 会让 mtime 巧合撞上 → 返回 stale parse。
    if (
      cached &&
      cached.mtimeMs === st.mtimeMs &&
      cached.size === st.size &&
      cached.ino === st.ino
    ) {
      return { value: cached.value as T, mtimeMs: st.mtimeMs };
    }
    // miss:读 + parse + 写回缓存
    const raw = await fh.readFile('utf-8');
    const value = parser(raw);
    setWithCap(key, {
      mtimeMs: st.mtimeMs,
      size: st.size,
      ino: st.ino,
      value,
    });
    return { value, mtimeMs: st.mtimeMs };
  } finally {
    // audit 2026-09-14:finally close 改 warn —— Windows stale handle 偶发 EBUSY,
    //   旧 swallow 让 fd 泄漏信号消失。
    // audit round 8 (2026-09-14):走 safeCloseFh helper,统一 close 失败日志形态。
    await safeCloseFh(fh, 'fh.close failed in fs-cache finally', log, { path: absPath });
  }
}

/**
 * 文件被改写或删除后必须 invalidate,否则下次读拿到 stale mtime。
 * 写 writeNote 时调用。
 *
 * audit 2026-08-28:删 invalidateMissing(byte 级重复 invalidateFile) +
 * clearFsCache(声称测试用但无 caller)。单一真相在 invalidateFile。
 */
export function invalidateFile(absPath: string): void {
  caches.delete(cacheKey(absPath));
}
