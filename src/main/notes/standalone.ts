// 独立笔记:扫描 <dataPath>/notes/ 下的所有 .md(WORKSPACE_DATA_LAYOUT.NOTES_DIR = 'notes')
import { promises as fs } from 'fs';
import matter from 'gray-matter';
import { dirname, join, relative } from 'path';
// audit-r56:library/path-mapping.ts 整体下线;这四个 helper 仍在 notes 中
// 消费,搬到 ./path-mapping(同目录就近)。语义与原实现完全一致 —— 见
// notes/path-mapping.ts 头注。
import { toNotePath, toPosix, computeFileId, filenameOf } from './path-mapping';
// audit C3R77 (2026-08-22):note id 字面 regex + 派生逻辑抽到独立模块,
// scanNotes / readNote 共用同一份 source-of-truth
import { extractNoteId } from './note-id';
import { StandaloneNote, WORKSPACE_DATA_LAYOUT } from '../../shared/types';
import { stripExt, parentDirOfRelPath } from '@shared/path-utils';
import { validateRelPath } from '@shared/rel-path';
import {
  safeWriteFileAtomic,
  safeUnlink,
  safeCloseFh,
  resolveInsideRootPath,
} from '../utils/safe-write';
// r175:Windows 上目录 rename 会因「目录里有文件正被 chokidar 打开读 stat」
//   而抛 EPERM(本机实证:fs.open 子文件持句柄 → rename 目录 → EPERM;
//   句柄释放后同名 rename 成功)。句柄在 awaitWriteFinish 的 stability
//   threshold 之后释放(notes 50ms / literature 200ms),所以退避重试一小段
//   窗口即可 —— 不重试就是「用户刚导入完就改文件夹名 → 弹失败 toast」。
//   cleanup 传 noop:rename 失败时**绝不能**删源(那是唯一的用户数据)。
import { retryOnWindowsTransient } from '../utils/retry-transient';
import { createLogger } from '../utils/logger';
import { AppError, LibraryError, ValidationError, errMsg, errnoCode } from '../utils/error';
import { tr } from '../i18n';
// audit r51 (2026-10-15):writeNote / renameNote 走 readBodyWithCap 取代
//   inline `fs.readFile(var, 'utf-8')` —— 旧实现用变量 first arg 绕过
//   `no-direct-body-read.test.ts` 的字面量 regex 守卫 + 5MB cap,且
//   ODrive 重水合 / 用户 atomic-rename / 直接编辑后,磁盘旧笔记从 4MB
//   涨到 6MB 时 `writeNote`(preserveExisting 读旧 fm merge)或
//   `renameNote`(读旧 body 改 id 重建)会把 6MB 一次性吞进主进程 OOM。
//   readBodyWithCap 是单 fd stat+read + 5MB 硬限,过限抛 AppError(TOO_LARGE)
//   让 IPC handler 翻译给 UI,比 OOM 安全。parseNoteFile(scan hot path,
//   用 fh.read(buf) 块读 + 字节累计 + 早 abort,见 line 156-162 注释)
//   不受影响 — 本文件没有别的 inline `fs.readFile(` 调用。
import { readBodyWithCap } from '../utils/body-cap';

// audit 2026-09-08:从 utils/markdown.ts 内联进来 —— cleanBody 现存唯一 caller
//   就是 standalone.ts(131, 175),且模块仅这一个 export,共享层无意义,删
//   文件省一层间接。语义不变:gray-matter 始终在 body 末尾追加 '\n',
//   这里同时 strip CRLF / LF 收尾的 stray EOL,让 IPC 端拿到的 body 严格
//   等于用户原始输入(round-trip 一致性)。
function cleanBody(content: string): string {
  if (content.endsWith('\r\n')) return content.slice(0, -2);
  if (content.endsWith('\n')) return content.slice(0, -1);
  return content;
}
// audit C3R51 (2026-08-22):用 asFrontmatter helper 收口 gray-matter data 参数的类型 cast
import { asFrontmatter, cleanTags, cleanTitle } from '../utils/frontmatter';
// audit C3R76 (2026-08-22):filename normalize + validate 抽到独立模块,
// createNote / renameNote 共用同一份 regex / 后缀规则 / 错误信息
import { normalizeAndValidateNoteFilename } from './filename-validator';
// perf(2026-08-24):mtime-keyed fs cache — readNote 是 notes 编辑 hot path,
// 编辑器每次 focus / save / content 切换都会触发 read。
import {
  cachedReadParse,
  invalidateFile as invalidateFsCache,
  caseInsensitiveFsKey,
} from '../utils/fs-cache';
// perf(2026-08-28):scanNotes 解析走 runPool —— 串行 readFile 在几百篇笔记时
// 拖到几百 ms,8 并发与 library/scanner 一致,fd 不爆。目录树本身仍串行递归
// (readdir 是 cheap syscall),但 .md 文件的 open + readFile + matter 解析并行。
import { runPool } from '../utils/run-pool';

const log = createLogger('notes');

// 移除 undefined / null / 空字符串字段,避免 gray-matter 序列化噪点
function cleanFm(fm: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) {
    if (v === undefined || v === null || v === '') continue;
    out[k] = v;
  }
  return out;
}

// perf(2026-08-28):notes 解析并发度 = 8 — 与 library scanner 同步(library
// scan 期间 fd 句柄已经吃紧,再高会和 library scan 抢资源)。
// audit 2026-09 (V1.6):头注原写 "sidecar/scan 期间 fd 句柄已经吃紧" —
//   sidecar 概念 2026-08-28 整体下线(sidecar.ts 删除,LibraryFile
//   metadata 走 extractMetadata filename-only,无独立 sidecar 扫描)。
//   仍成立的理由:library scan 期间 notes scan 并发拉高会与 fs watcher
//   event / fd 竞争 fd 上限,实测 8 是 sweet spot。
const NOTES_SCAN_CONCURRENCY = 8;

/**
 * perf r239(2026-10-21):**stat 门控解析缓存** —— 让「全量重扫」变便宜。
 *
 * 背景:scanNotes 是「每个 .md 都 open + read + gray-matter 解析一遍」。
 *   实测(本机,8KB/篇):500 篇 → 124ms;2000 篇 → 410ms。
 *   成本拆解(read-only 373ms vs matter 解析 20.7ms @ N=500)证明瓶颈是
 *   **每文件的 open/read syscall**,不是解析。于是「先 stat,没变就复用
 *   上次解析结果」就是最直接的解法:
 *     500 篇 → readdir+stat 全量 ≈ 15ms;2000 篇 ≈ 60ms。
 *   410ms → 60ms,主进程不再被长时间占住(卡顿的直接来源)。
 *
 * 命中判据(mtime + size + ino 三因子):
 *   - 与 utils/fs-cache.ts 的 readNote 缓存同款口径;
 *   - 与 DB 同步(r220)的双因子口径同源 —— 都是「mtime+size 变了才算变」。
 *   已知盲区:「内容变但 mtime 保留且长度相同」(备份还原 / cp -p / 同步盘
 *   按内容去重)判成「没变」。这是**全项目一致**的有意取舍(要兜只能全文
 *   hash,代价是每次全量读回,正是本轮要消掉的成本)。
 *
 * 缓存**只存对象引用**,不复制正文 ⇒ 缓存里的 StandaloneNote 与
 *   NotesService.byId 里的是**同一个对象**,内存不翻倍。
 *
 * 缓存是 per-process(主进程单实例)+ 按绝对路径 key ⇒ 换 root
 *   (ADR-0003 rootPath 迁移)自然失效,不需要显式清空。
 */
interface NoteParseCacheEntry {
  mtimeMs: number;
  size: number;
  ino: number;
  note: StandaloneNote;
  /**
   * perf r255:`note.body` 的 UTF-8 字节数 —— **解析时算一次,稳态复用**。
   *
   * 背景:body 的字节数被两处消费(notes/service.ts 的 emit 指纹 +
   *   DB 同步的「变了没」判定),两处都是 `Buffer.byteLength(body,'utf8')`
   *   —— 而 byteLength 是**一次全量 UTF-8 扫描**(实测 2000 篇 × 8KB
   *   = 4.3ms/遍)。旧实现每个 reload 付**两遍**(指纹一遍 + DB 判定
   *   一遍)= 4000 次调用 ≈ 8.6ms 的**主线程纯 CPU**(不是 I/O 等待
   *   ⇒ 直接吃 IPC 响应延迟 ⇒ 卡顿)。
   *
   * 修法:字节数跟着解析结果一起缓存 —— 命中 stat 门控缓存时**零计算**
   *   直接取缓存值;未命中(文件真变了)时算一次并写回缓存。
   *   ⇒ 稳态(文件没变)下每轮 reload 的字节数成本 = 0。
   *
   * 为什么可以缓存:字节数是 `note.body` 的**纯函数**,而缓存条目与
   *   `note` 对象是**同一个引用**(缓存不复制正文)⇒ 只要 note 没被
   *   换掉,字节数就不会过期。文件变了 ⇒ stat 门控不命中 ⇒ 重新解析
   *   ⇒ 重新计算 ⇒ 不会拿到陈旧值。
   */
  bodyBytes: number;
}

const noteParseCache = new Map<string, NoteParseCacheEntry>();

// 与 fs-cache 的 FIFO cap 同量级(20k):单条只多一个 map entry(约 100B),
// 正文是共享引用不重复占内存。超限时弹掉最老的一条(冷条目重解析一次即可)。
const NOTE_PARSE_CACHE_MAX_ENTRIES = 20_000;

/** 测试与「换 root」场景的显式清空入口。 */
export function clearNoteParseCache(): void {
  noteParseCache.clear();
}

/** 当前缓存条目数(诊断 / 守卫用)。 */
export function noteParseCacheSize(): number {
  return noteParseCache.size;
}

/**
 * 解析一个笔记文件,命中 stat 门控缓存则直接复用。
 *
 * @returns null = 文件读不了(不存在 / 超大 / 坏内容)。与 parseNoteFile
 *   的契约一致 —— 调用方(scanNotes)对两种「读不出」一视同仁地跳过。
 */
async function parseNoteFileCached(
  notesDir: string,
  full: string,
  bodyBytesOut?: Map<string, number>,
): Promise<StandaloneNote | null> {
  // 1) 先 stat(路径级,一次 syscall):拿 mtime + size + ino 当指纹。
  let st: Awaited<ReturnType<typeof fs.stat>>;
  try {
    st = await fs.stat(full);
  } catch (err: unknown) {
    // 文件没了 / 读不到 → 与 parseNoteFile 的「读不出来」等价,跳过。
    // 注意:**不缓存**这种失败 —— 外部工具可能正在写,下一轮再来。
    if (errnoCode(err) === 'ENOENT') return null;
    log.warn('Cannot stat note', full, errMsg(err));
    return null;
  }
  // 超大文件:parseNoteFile 内部也会判(它用 fh.stat),这里先判一次是为了
  // **不进缓存**(超大文件不占缓存槽)且不必开 fd。
  if (st.size > MAX_NOTE_SCAN_BYTES) {
    log.warn('Skipping oversized note', full, `(${st.size} bytes > ${MAX_NOTE_SCAN_BYTES})`);
    return null;
  }

  const key = caseInsensitiveFsKey(full);
  const cached = noteParseCache.get(key);
  if (
    cached &&
    cached.mtimeMs === st.mtimeMs &&
    cached.size === st.size &&
    cached.ino === st.ino
  ) {
    // perf r255:命中 ⇒ body 字节数直接取缓存值(零计算)。
    bodyBytesOut?.set(cached.note.relPath, cached.bodyBytes);
    return cached.note;
  }

  // 2) 未命中 → 真解析(parseNoteFile 自己 open + fh.stat + read + matter)。
  const note = await parseNoteFile(notesDir, full);
  if (!note) return null;

  // perf r255:body 的 UTF-8 字节数 —— 解析时算一次,写进缓存条目。
  //   缓存命中时复用(见上),⇒ 稳态 reload 的字节数成本 = 0。
  const bodyBytes = Buffer.byteLength(note.body, 'utf8');

  // 3) 回填缓存。存的是 **path-stat 的指纹**而非 fh 的指纹:
  //    若 stat 与 open 之间文件变了,这一轮存的是「旧指纹 + 新内容」——
  //    下一轮 stat 拿到新指纹 → 不匹配 → 重新解析。**不会**命中出陈旧内容。
  if (noteParseCache.has(key)) noteParseCache.delete(key);
  noteParseCache.set(key, {
    mtimeMs: st.mtimeMs,
    size: st.size,
    ino: st.ino,
    note,
    bodyBytes,
  });
  bodyBytesOut?.set(note.relPath, bodyBytes);
  if (noteParseCache.size > NOTE_PARSE_CACHE_MAX_ENTRIES) {
    const oldest = noteParseCache.keys().next().value;
    if (oldest !== undefined) noteParseCache.delete(oldest);
  }
  return note;
}

// audit-r223:可选 dirsOut —— 调用方(service.reload 的 emit 指纹)需要
//   「这轮扫描看到了哪些目录」:空文件夹的增/删/改名不改变任何**文件行**,
//   文件指纹不变 ⇒ 不 emit ⇒ 左侧栏文件夹树与磁盘对不上(literature r215
//   踩过的同款坑)。walk 本来就要访问每个目录,顺手收集边际成本为零。
//
// perf r255:scanNotes 的可选出参收成一个 options 对象 —— 出参从一个
//   (dirsOut)变成三个(dirsOut / bodyBytesOut / pathsOut),位置参数已经
//   分不清谁是谁。三个出参的共同点:**本轮扫描顺手就能拿到的东西**,不该
//   让调用方再走一遍目录树 / 再算一遍正文。
export interface ScanNotesOpts {
  /** 本轮扫描看到的目录(绝对路径)。 */
  dirsOut?: string[];
  /**
   * 每篇笔记 body 的 UTF-8 字节数(relPath → 字节数)。
   * perf r255:由解析缓存提供 ⇒ 稳态零计算(见 NoteParseCacheEntry.bodyBytes)。
   */
  bodyBytesOut?: Map<string, number>;
  /**
   * 本轮收集到的 .md 文件绝对路径。
   * perf r255:调用方(service.syncDbWithDisk)原先**又走了一遍**目录树
   *   来算「磁盘侧权威路径集」—— 同一轮里走两遍同样的树是纯浪费
   *   (实测 2000 篇 / 20 子目录:readdir 树 ≈ 4.4ms 一遍)。
   */
  pathsOut?: string[];
}
export async function scanNotes(
  dataPath: string,
  opts?: ScanNotesOpts,
): Promise<StandaloneNote[]> {
  const notesDir = join(dataPath, WORKSPACE_DATA_LAYOUT.NOTES_DIR);
  await fs.mkdir(notesDir, { recursive: true });
  // perf(2026-08-28):两阶段 —— 先递归收 .md 路径(cheap fs.readdir,可串行),
  // 再 runPool 解析。旧实现单函数 walk 串行 open+readFile+parse,500 篇
  // 笔记 8ms/file ≈ 4s;8 并发后 ≈ 0.5s。
  const filePaths: string[] = [];
  await collectNotePaths(notesDir, notesDir, filePaths, 0, opts?.dirsOut);
  // perf r255:把本轮的路径集交给调用方(免得它再走一遍树)。
  if (opts?.pathsOut) {
    for (const p of filePaths) opts.pathsOut.push(p);
  }
  const results: StandaloneNote[] = [];
  await runPool(filePaths, NOTES_SCAN_CONCURRENCY, async (full) => {
    const note = await parseNoteFileCached(notesDir, full, opts?.bodyBytesOut);
    if (note) results.push(note);
  });
  // perf r239:剪掉本轮没看到的缓存条目(文件已被删 / 换 root)——
  //   否则 noteParseCache 会一直攥着已删除笔记的正文引用(内存泄漏形状:
  //   用户删了 2000 篇笔记,缓存里 2000 条还在)。剪枝用**本轮路径集**,
  //   跨 root 的旧条目也一并清掉(生产只有单 root)。
  if (noteParseCache.size > 0) {
    const alive = new Set(filePaths.map((p) => caseInsensitiveFsKey(p)));
    for (const key of noteParseCache.keys()) {
      if (!alive.has(key)) noteParseCache.delete(key);
    }
  }
  dedupeNoteIds(results);
  return results;
}

/**
 * audit-r80 (2026-10-17) HIGH:外部复制笔记导致的 id 碰撞消解。
 *
 * 应用写盘时会把 `id: computeFileId(relPath)` 烧进 frontmatter
 * (standalone.ts 写路径),extractNoteId 又优先采信 fm.id。用户在资源
 * 管理器 / OneDrive / git 里复制笔记文件时 fm.id 原样带走 → 两个文件
 * 同一 id → service.byId Map 互相覆盖只剩一篇,DB upsert ON CONFLICT
 * 同样只剩一行:另一篇从列表/搜索里静默消失(实证:r80 repro,byId
 * size=1 < 磁盘文件数=2)。
 *
 * 消解规则(确定性,跨 scan 稳定):
 *   1. 同 id 组内按 relPath 字典序排序;
 *   2. 「computeFileId(relPath) === id」的文件(即应用原始文件)保留 id;
 *      组内没有匹配则字典序第一个保留(两个都是外来手写 id 的极端情形);
 *   3. 其余文件重映射为自己的 computeFileId(relPath) —— 它们本就是副本,
 *      与「无 fm.id 的新文件」行为一致;首次经应用保存后 fm.id 会被重写
 *      成自己的派生 id,碰撞永久自愈。
 * 顺带的好性质:原文件被删后,幸存副本下次 scan 重新独占 fm.id —— 收藏
 * 等按 id 引用自然指向内容相同的那一份。
 */
function dedupeNoteIds(notes: StandaloneNote[]): void {
  const groups = new Map<string, StandaloneNote[]>();
  for (const n of notes) {
    const g = groups.get(n.id);
    if (g) g.push(n);
    else groups.set(n.id, [n]);
  }
  for (const [id, group] of groups) {
    if (group.length < 2) continue;
    group.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
    const owner = group.find((n) => computeFileId(n.relPath) === id) ?? group[0];
    for (const n of group) {
      if (n === owner) continue;
      const reassigned = computeFileId(n.relPath);
      log.warn(
        'Note id collision: reassigning duplicate',
        n.relPath,
        `(${id} -> ${reassigned}; owner: ${owner.relPath})`,
      );
      n.id = reassigned;
    }
  }
}

// audit 2026-08-25:scan 阶段硬上限 5MB / .md —— DoS 防御。
// 用户 / 同步冲突 / 误操作放进一个 1GB 的 .md 会让 fs.readFile 一次性把堆吃满,
// 整个 main 进程卡死直到 GC 回收不到。readNote 入口已有 5MB 限制,scan 路径
// 此前没有,用户能透过"放个大文件 + 重启"绕过 → 启动死锁。统一上限与 readNote 对齐。
//
// audit round 9 (2026-09-15):与 ipc/notes.ts / notes/import.ts 同款 5MB 上限
//   全部统一到 ipc/path-limits.ts:MAX_NOTE_BODY_BYTES 共享常量,防止任一路径
//   漂移(写入口 5MB 但扫描入口 6MB 会让攻击者放 6MB .md 绕过扫描层)。
import { MAX_NOTE_BODY_BYTES as MAX_NOTE_SCAN_BYTES } from '../ipc/path-limits';

// perf(2026-08-28):从 walk 拆出"收集路径"子任务 —— readdir 是 cheap syscall
// 但每次都 spawn readdir+Dirent 实例;递归收集所有 .md 路径后,parse 阶段全
// 并行,scan 总耗时从 Σopen+read 降到 max(open+read) / 并发。
// audit 2026-09-14 r7:递归改并发 —— 之前 for-await 串行递归,典型 5 层深 +
//   每层 5-10 子目录 = 数十次串行 readdir,可达 50-200ms。改成同层 Promise.all
//   并发,典型研究库 ~5ms。BFS-style 用 recursion + Promise.all 即可。
// audit r50 (2026-10-15) M6:export collectNotePaths —— service.ts.resyncIfNeeded
//   需要在不做 matter parse 的前提下收集 disk 上 .md 文件全路径(再由 caller 做
//   toPosix(relative(notesDir, full)) 转 relPath)。scanNotes 内部仍走它。
// audit-r160:深度上限 MAX_COLLECT_DEPTH = 16,与 service.ts chokidar depth cap
//   对齐。chokidar depth 0-based 上限 16 = 顶层 + 16 层,再深 chokidar 看不见
//   (永远不会被 reload 索引),collectNotePaths 走上去也是浪费 + 栈递归风险。
//   双向对齐后:超出深度的目录被两处都跳过,语义一致,无「收集了但 chokidar
//   不监听」的孤儿 + 无「chokidar 看到但 collectNotePaths 漏」的漏索引。
const MAX_COLLECT_DEPTH = 16;

/**
 * 笔记文件后缀白名单 —— `.md` / `.markdown`(case-insensitive)。
 *
 * perf r239(2026-10-21):**单一真相源** —— 此前同一份 regex 在三处各写一遍:
 *   - 本文件 collectNotePaths(收集哪些文件算笔记)
 *   - notes/filename-validator.ts(改名 / 新建时补后缀)
 *   - notes/service.ts 的 watcher 事件过滤(perf r239 新增的第三处)
 * 三处必须同口径:watcher 若按更宽的口径触发 reload,会白跑全库重扫;
 * 按更窄的口径则漏索引。抽成导出常量让三处引用同一份。
 */
export const NOTE_FILE_EXT_RE = /\.m(?:d|arkdown)$/i;

export async function collectNotePaths(
  notesDir: string,
  dir: string,
  out: string[],
  currentDepth = 0,
  // audit-r223:可选 —— 收集所有(非 symlink、非点开头)子目录的绝对路径,
  //   供 emit 指纹的目录维度使用;深度上限与文件收集同一把尺
  //   (MAX_COLLECT_DEPTH,深层目录 watcher 也看不到,盲区一致)。
  dirsOut?: string[],
): Promise<void> {
  if (currentDepth > MAX_COLLECT_DEPTH) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err: unknown) {
    log.warn('Cannot read notes dir', dir, errMsg(err));
    return;
  }
  const subdirs: typeof entries = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // audit C3R32 (2026-08-22):跳过 symlink 目录 — 与 library/scanner.ts 同款防御。
      // Dirent.isDirectory() 对 symlink-to-dir 也返回 true,若不挡会进入递归环
      // (例如 notes/loop → ../notes),扫描永远不返回 → watch + reload 任务挂死。
      // 跨边界泄漏也是同样问题(notes/secret → /etc),把 symlink 视为不在本目录。
      if (entry.isSymbolicLink()) continue;
      subdirs.push(entry);
    } else if (entry.isFile() && NOTE_FILE_EXT_RE.test(entry.name)) {
      // 同款:symlink 文件也跳过,避免 readFile follow 到 target 后读到与笔记无关的内容
      // audit-r155:接受 .markdown —— notes/import.ts 第 75 行已接受两个后缀
      //   (`.md` / `.markdown`),但 scanNotes 只认 .md,用户在 notes/ 手动
      //   丢入 / 从 Obsidian/Joplin/Bear 同步进 .markdown 时,chokidar 'add'
      //   触发 scheduleReload → scanNotes 静默跳过,byId 永远不收,UI 不可见
      //   且 search 不可达。regex 用 `(?:d|arkdown)` 非捕获组 + case-
      //   insensitive 与 filename-validator 端的 'md'/'markdown' 枚举对齐。
      if (entry.isSymbolicLink()) continue;
      out.push(full);
    }
  }
  // audit round 8 (2026-09-14):per-branch try/catch —— 之前 `Promise.all`
  //   把 N 个递归调用合并成单一 Promise,任一 reject 直接整体 reject,
  //   父级 collectNotePaths 也走 reject 路径,最终调用方(例如 loadNotes /
  //   startWatching → rescan)catch 兜底 log warn 但这一分支的所有兄弟
  //   目录都没机会 collect。典型触发:某个子目录被 Windows Defender 暂时
  //   锁住 / OneDrive 同步中的 placeholder / 权限翻转 — 整 notes 树扫描
  //   半途挂掉,用户看到"笔记全空",debug 只能从 log warn 倒推。
  //   改成每个分支独立 try/catch,失败只丢这一支,其他兄弟目录 + 父级
  //   收集完整。log warn 形态不变,只是把"全空"降级成"少数目录缺"。
  await Promise.all(
    subdirs.map((entry) => {
      // audit-r223:目录本身也收集(在递归之前 —— 即使这一支递归失败,
      //   目录存在这个事实不丢;per-branch catch 只丢这一支的内容)
      dirsOut?.push(join(dir, entry.name));
      return collectNotePaths(notesDir, join(dir, entry.name), out, currentDepth + 1, dirsOut).catch(
        (err: unknown) => {
          log.warn('collectNotePaths branch failed', join(dir, entry.name), errMsg(err));
        },
      );
    }),
  );
}

// audit 2026-08-26:fs.open + fh.stat/fh.readFile 单 fd 拿 size + content,
// 替代 fs.stat + fs.readFile 两步走法 —— 后者在 stat/read 间存在 TOCTOU
// 窗口(扫描过程中文件被替换/截断),size 检查就可能跑在错误 inode 上。
// audit 2026-09-10:read 阶段硬限 + 块读 + 后置 size 校验 —— 之前
//   `fh.readFile('utf-8')` 在 stat 之后一次性把整文件读进内存,与 stat
//   之间有 TOCTOU 窗口:AV 隔离 / OneDrive 重水合 / 用户 atomic-rename
//   都可能在 stat 之后把文件换成 1GB+ 大文件,5MB 上限失效,主进程 OOM。
//   改用 fh.read(buf) 块读,逐块累加字节数,达到 MAX_NOTE_SCAN_BYTES
//   立即关闭 fd 抛错(下层 catch 转 log warn + skip),不再读取更多字节。
// audit r47 (2026-10-15) M5:本函数故意不走 utils/body-cap.ts:readBodyWithCap。
//   通用 readBodyWithCap 是单 fd stat + readFile 一次性,与 stat 之间仍存
//   在 TOCTOU 窗口;scan 路径调用频次高(全库每个 .md 都过),块读 + 字节
//   累计 + 早 abort 能在 stat 失真时仍守住内存上限,所以保留为 scan hot
//   path 特化。grep 守卫 tests/unit/main/lint/no-direct-body-read.test.ts
//   把本文件 + body-cap.ts 列为 .md 路径读白名单,其余 src/main/** 走
//   readBodyWithCap 单一入口。
// audit r51 (2026-10-15):export —— service.ts watch reload 路径直接调
//   parseNoteFile 处理单文件(不经过 writeLock 串行化)。
export async function parseNoteFile(
  notesDir: string,
  full: string,
): Promise<StandaloneNote | null> {
  let fh: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    fh = await fs.open(full, 'r');
    const stat = await fh.stat();
    if (stat.size > MAX_NOTE_SCAN_BYTES) {
      // 不抛 — 让 scan 继续;这条笔记在 UI 缺失但用户至少能进应用,
      // log.warn 留 trace 提示有超大文件需要清理。
      log.warn('Skipping oversized note', full, `(${stat.size} bytes > ${MAX_NOTE_SCAN_BYTES})`);
      return null;
    }
    const relPath = toPosix(relative(notesDir, full));
    // 块读 + 字节累计,达到 MAX 立即 abort。READ_CHUNK_SIZE = 64KB 是
    // fs.read 的常规 sweet spot(大块 = 少 syscall,小块 = 早 abort)。
    const READ_CHUNK_SIZE = 64 * 1024;
    const buf = Buffer.allocUnsafe(READ_CHUNK_SIZE);
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let pos = 0;
    // 读 0 字节 = EOF。maxBytes 兜底:即便 stat 失真(TOCTOU)文件实际
    // 比 stat 报告大,读到 MAX_NOTE_SCAN_BYTES + 1 字节立刻停,不 OOM。
    const maxBytes = MAX_NOTE_SCAN_BYTES + 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { bytesRead } = await fh.read(buf, 0, READ_CHUNK_SIZE, pos);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > maxBytes) {
        log.warn(
          'Skipping oversized note (post-read check)',
          full,
          `(${totalBytes} bytes > ${MAX_NOTE_SCAN_BYTES})`,
        );
        return null;
      }
      // 拷贝本块内容(Buffer 是 mutable,fd 复用下次 read 会被覆盖)
      chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
      pos += bytesRead;
    }
    const raw = Buffer.concat(chunks, totalBytes).toString('utf-8');
    const parsed = matter(raw);
    const fm = parsed.data as Record<string, unknown>;
    // C3R77: 派生 ID 走 extractNoteId(优先 frontmatter.id 旧兼容,否则 relPath SHA-256)
    const id = extractNoteId(fm, relPath);
    // audit 2026-09-14:防御 pop() 空串 —— library/service.ts:467-468 同款。
    //   full = join(dir, entry.name),entry.name 由 readdir 给出,正常不可能
    //   为空,但 root 'D:\\' / '' 之类异常事件下 pop() 可能返 ''。空 filename
    //   会让 stripExt(filename) 走到 'unknown' 分支 / DB 写入空字符串,
    //   后端 listNotes 把这条笔记的 filename 渲染成空 — UI 显示「· 」诡异。
    //   抛 ValidationError(不写 DB、不返回 StandaloneNote)。
    //   r197 勘误:旧注释写「抛 ValidationError 让 caller 决定 bail」—— 但本函数
    //   自己的 catch 会把 ValidationError 一并吞掉(转 warn + 返 null),caller
    //   根本看不到它。实际语义是「**静默跳过这条笔记**」(scan 时跳过一条坏笔记
    //   比整轮扫描失败好)。这里保留 throw(让类型收窄 + 留下可诊断的日志),
    //   但把注释改成实际行为,别再骗后来的人。
    const filename = full.split(/[\\/]/).pop();
    if (!filename) {
      throw new ValidationError(`Cannot derive filename from note path: ${full}`, 'relPath');
    }
    return {
      id,
      relPath,
      filename,
      title: cleanTitle(fm) ?? stripExt(filename),
      tags: cleanTags(fm),
      mtime: stat.mtimeMs,
      body: cleanBody(parsed.content),
    };
  } catch (err: unknown) {
    log.warn('Cannot read note', full, errMsg(err));
    return null;
  } finally {
    // audit 2026-09-14:fh.close swallow 改 warn —— 与 reader / atomic-file / fs-cache /
    //   settings 同模式,Windows stale handle 偶发 EBUSY 时 fd 泄漏信号不再消失。
    // audit round 8 (2026-09-14):走 safeCloseFh helper,统一 close 失败日志形态。
    await safeCloseFh(fh, 'fh.close failed in readNoteHeader finally', log, { path: full });
  }
}

export async function readNote(dataPath: string, relPath: string): Promise<StandaloneNote | null> {
  const full = toNotePath(dataPath, relPath);
  // perf(2026-08-24):fs-cache 路径 — cachedReadParse 内部做 stat + readFile + parse,
  // 缓存命中时跳过 readFile + matter,只 1 次 stat。readNote 在 notes 编辑器里
  // 是高频 read(mount + focus + save),缓存命中从 5-30ms → 0.1ms。
  // audit 2026-08-26:cachedReadParse 现在返回 mtimeMs,直接用 —— 删了原先的
  // 二次 fs.stat,杜绝 cachedReadParse 与 extra stat 之间的微弱 TOCTOU 窗口
  // (stat 后文件被替换会让 StandaloneNote.mtime 与缓存里的旧 value 不一致)。
  const cached = await cachedReadParse(full, (raw) => {
    try {
      const parsed = matter(raw);
      return parsed;
    } catch (err: unknown) {
      throw new LibraryError(
        'IO_ERROR',
        tr('notes.frontmatterParseFailed', { path: relPath, reason: errMsg(err) }),
      );
    }
  });
  if (cached === null) return null;
  const parsed = cached.value;
  const fm = parsed.data as Record<string, unknown>;
  // C3R77: 与 scanNotes 共享 extractNoteId — 同文件同一份 frontmatter 必须
  // 派生同一个 id,否则 list 和 read 视图对同一笔记给出 2 个 id
  const id = extractNoteId(fm, relPath);
  return {
    id,
    relPath,
    filename: filenameOf(relPath),
    title: cleanTitle(fm),
    tags: cleanTags(fm),
    mtime: cached.mtimeMs,
    body: cleanBody(parsed.content),
  };
}

// audit 2026-10-08 (HIGH):readNoteMtime —— NotesService.write 用 expectedMtime
//   做冲突检测时(防止外部修改被静默覆盖,OneDrive sync / Vim 等),只 stat 一次
//   拿磁盘 mtime,不读 body。cachedReadParse 会触发 matter 解析 + body 字符串
//   构造(可能 5-30ms 大量 KB 内容),save hot path 没必要。ENOENT → null 让
//   caller 走 NOT_FOUND(与 readNote 不返 null 的契约不同,这里语义是「stat 失败」
//   而不是「读失败」,更接近 fs.access 语义)。
export async function readNoteMtime(dataPath: string, relPath: string): Promise<number | null> {
  const full = toNotePath(dataPath, relPath);
  try {
    const st = await fs.stat(full);
    return st.mtimeMs;
  } catch (err: unknown) {
    if (errnoCode(err) === 'ENOENT') return null;
    throw err;
  }
}

// writeNote:接收完整 frontmatter 字段,自动写 `updated` 时间戳。
// 保留旧笔记文件里 `created`(如存在),作为单源真相。
export async function writeNote(
  dataPath: string,
  relPath: string,
  body: string,
  frontmatter: Record<string, unknown> = {},
  options: { preserveExisting?: boolean } = {},
): Promise<StandaloneNote> {
  const full = toNotePath(dataPath, relPath);
  let existingFm: Record<string, unknown> = {};
  if (options.preserveExisting) {
    try {
      const raw = await readBodyWithCap(full);
      existingFm = (matter(raw).data as Record<string, unknown>) ?? {};
    } catch (err: unknown) {
      // audit-r137:readBodyWithCap 对超大文件抛 AppError('TOO_LARGE', ...) —
      //   errnoCode 拿不到 AppError 的 code,所以 TOO_LARGE 之前会透到外层,
      //   走 wrap.ts fallback INTERNAL → scrubInternal 漏的旧路径(
      //   bug-2 的同根)。把 TOO_LARGE 当作空 frontmatter 兜底,保留标题
      //   / tags 的回退语义(避免大文件保存时整条路径炸出家目录)。
      if (err instanceof AppError && err.code === 'TOO_LARGE') {
        existingFm = {};
      } else if (errnoCode(err) !== 'ENOENT') {
        throw err;
      }
    }
  }
  const now = new Date().toISOString();
  // audit 2026-10-04 (P0 数据丢失):原实现只展开 `...frontmatter`,而
  // preserveExisting 分支读出来的 existingFm **只被取用 title / tags / created
  // 三个键** —— 其余键从未 merge 回去。真实调用链上 renderer 只传 { title }
  // (store/notes.ts:264 → service.ts:273),于是用户自己手写的 citekey / doi /
  // status / year 等字段在**每次保存**时被静默删除。1.5s autosave 意味着「打开
  // 笔记就丢」,且走原子覆盖不留 .bak,无法恢复。
  //
  // 修法:existingFm 垫底、frontmatter 覆盖,再由下面几行显式字段收口。
  //   - preserveExisting=false 时 existingFm 恒为 {} ⇒ 展开是 no-op,新建路径
  //     的行为逐字不变(有对照用例锁住)。
  //   - preserveExisting=true 且 frontmatter 只传 title ⇒ 旧字段全部留存。
  //   - frontmatter 显式传值 ⇒ 覆盖旧值(新值优先,不是被 existingFm 反压)。
  //   - frontmatter['x'] 为 undefined 时,spread 会把 existingFm 的值覆盖成
  //     undefined,但下面 title / tags / created 三行用 `?? existingFm[...]`
  //     兜回;cleanFm 最终也会剔除 undefined,不留 YAML 空键。
  const fm = cleanFm({
    ...existingFm,
    ...frontmatter,
    id: computeFileId(relPath),
    title: frontmatter['title'] ?? existingFm['title'],
    tags: frontmatter['tags'] ?? existingFm['tags'],
    created: existingFm['created'] ?? frontmatter['created'] ?? now,
    updated: now,
  });
  const content = matter.stringify(body, asFrontmatter(fm));
  await safeWriteFileAtomic(full, content);
  // perf(2026-08-24):fs-cache invalidate — 下次 readNote 看到新 mtime 走 cache miss
  invalidateFsCache(full);
  // perf r239:stat 门控解析缓存也失效 ——
  //   原子写会换 inode,指纹(ino)本就会变 ⇒ 缓存自然 miss;这里**显式**
  //   删掉是双保险(万一某平台 ino 不稳定 / 时间戳粒度粗),
  //   避免「新正文被旧指纹挡住」这类难以复现的 stale。
  noteParseCache.delete(caseInsensitiveFsKey(full));
  const updated = await readNote(dataPath, relPath);
  if (!updated) {
    throw new LibraryError('IO_ERROR', tr('notes.writeReadbackFailed'));
  }
  return updated;
}

// createNote:filename 必须非空,自动补 .md 后缀,做去重检查。
export async function createNote(dataPath: string, filename: string): Promise<StandaloneNote> {
  // C3R76: filename normalize + validate 抽到 filename-validator.ts,
  // 与 renameNote 共享同一份 regex / 后缀规则 / 错误信息
  const fn = normalizeAndValidateNoteFilename(filename, 'filename');
  // 去重:已存在则抛错,避免覆盖
  // audit C3R13 (2026-08-22):用专用 DUPLICATE_NAME code 替代 IO_ERROR。
  // 原来用 IO_ERROR 是因为 fs.access 抛 ENOENT 时归类为 IO 系列,
  // 但"用户输入撞已有文件"本质上是用户输入错误,语义上更接近 VALIDATION。
  // 用 code 区分后 IPC handler 可以精准翻译(create / rename 都有),
  // 不用依赖字符串匹配(message 改文案会无声破)。
  // audit 2026-08-25:删 fs.access TOCTOU 预检 — 用 fs.open(O_EXCL|'w') 单一 syscall
  // 原子地"只有不存在时才创建",撞名直接抛 EEXIST,语义比 access + write 二段更紧。
  // access 成功后 write 前被人/watcher race 创建同名文件,会让 createNote 覆盖别人的内容。
  const targetPath = toNotePath(dataPath, fn);
  // audit 2026-10-08 (HIGH):resolveInsideRootPath 校验 dataPath + symlink 防御。
  //   旧实现裸 fs.open('wx') 绕过 resolveInsideDataPath 的字符串 + realpath 链
  //   校验 —— 与 safeWriteFileAtomic 行为割裂(后者已修,见 safe-write.ts:130)。
  //   不能直接换成 safeWriteFileAtomic(后者 tmp+rename 替换语义,丢 DUPLICATE_NAME),
  //   所以在 fs.open 之前 explicit 调一次,让 UnsafeWriteError 在 symlink/junction
  //   逃逸场景里及时抛。target 路径上中间目录是 symlink 时,realpath 解析会在
  //   catch 内走父目录 realpath 兜底(见 safe-write.ts audit 2026-10-08)。
  resolveInsideRootPath(targetPath);
  // audit 2026-09-14:mkdir -p parent —— 与 renameNote:412 / safeWriteFileAtomic:120
  //   同款。NotesService.start() 启动期会 mkdir notes/,但首次创建前 user 已
  //   经把目录手动删了 / OneDrive sync 把目录搬走 / 全新 dataPath 没经过
  //   service start 路径时,这里 fs.open('wx') 会因 ENOENT 父目录不存在而失败
  //   → 用户看到「无法创建笔记 1.md: ENOENT」而无法恢复。mkdir recursive 兜底
  //   比让用户去手动重建目录更友好。
  await fs.mkdir(dirname(targetPath), { recursive: true });
  let fh: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    fh = await fs.open(targetPath, 'wx');
  } catch (err: unknown) {
    if (errnoCode(err) === 'EEXIST') {
      throw new LibraryError('DUPLICATE_NAME', tr('notes.duplicateName', { name: fn }));
    }
    throw new LibraryError('IO_ERROR', tr('notes.createFailed', { name: fn, reason: errMsg(err) }));
  }
  // O_EXCL 创建的空 fd 留着,等下写入 frontmatter 内容 + fsync,再 close。
  // 这条路径写入空笔记,没有"半截内容"风险,fsync 仍保留(断电保护)。
  const now = new Date().toISOString();
  // audit-r214:标题只取**文件名**部分 —— fn 是含目录前缀的 relPath
  //   (在子文件夹里点「新建」时形如 'sub/Untitled 1.md'),stripExt(fn) 会把
  //   目录前缀一起当标题('sub/Untitled 1'),列表 / 编辑器标题框 / FTS 都带
  //   路径。用 filenameOf 先取末段(与下方 944 行 rename 回退、:314 扫描回退
  //   的口径一致 —— 三处都是 stripExt(filenameOf(relPath)))。
  const title = stripExt(filenameOf(fn));
  const relPath = fn;
  const fm = cleanFm({
    id: computeFileId(relPath),
    title,
    created: now,
    updated: now,
  });
  const content = matter.stringify('', asFrontmatter(fm));
  // 沿用上面 O_EXCL 创建的 fd 直接 write + fsync + close,避免再走 tmp+rename
  // (tmp+rename 会和已存在的 fd 冲突,这里只有一个文件,直接写更直白)。
  // audit 2026-09-10:writeFile / sync 抛错时清理刚创建的 0-byte 文件 ——
  //   'wx' 模式已成功创建文件(fd 拿到了),但写入失败意味着磁盘上留下 0 字节
  //   残文件。下次同名 create 会 EEXIST → DUPLICATE_NAME,用户必须手动删才能
  //   重建同笔记。catch 走 safeUnlink 清理后 throw 让 UI 看到真错。
  try {
    await fh.writeFile(content, 'utf-8');
    await fh.sync();
  } catch (err: unknown) {
    // audit 2026-09-14:close 在 error 路径曾 swallow,Windows AV 锁文件时 fd 泄漏
    //   信号被吞,日志不可见。降级 warn,不 throw —— 这是 cleanup 路径,失败不阻断上层 throw。
    // audit round 8 (2026-09-14):走 safeCloseFh helper。
    await safeCloseFh(fh, 'fh.close failed during createNote rollback', log, { path: targetPath });
    await safeUnlink(targetPath).catch((unlinkErr: unknown) =>
      log.warn('safeUnlink failed during createNote rollback', {
        path: targetPath,
        err: errMsg(unlinkErr),
      }),
    );
    throw new LibraryError('IO_ERROR', tr('notes.createFailed', { name: fn, reason: errMsg(err) }));
  }
  // audit round 8 (2026-09-14):走 safeCloseFh helper,set fh = null 保留(append-only
  //   写法避免下面再读到 stale handle)。
  await safeCloseFh(fh, 'fh.close failed on createNote success path', log, { path: targetPath });
  // perf(2026-08-24):fs-cache invalidate
  invalidateFsCache(toNotePath(dataPath, relPath));
  const created = await readNote(dataPath, relPath);
  if (!created) {
    throw new LibraryError('IO_ERROR', tr('notes.createReadbackFailed'));
  }
  return created;
}

// audit 2026-09:deleteNote 已下线 —— NotesService.trash() 走 safeTrash
// (shell.trashItem 回收站,2026-10-16 起)+ byId.delete,IPC.NOTES_TRASH 走
// onAfterTrash 同步清 DB + FTS。standalone 层
// 无 caller,保留 createNote/readNote/writeNote/renameNote 四件套对称。

// renameNote:把旧笔记文件 move 到新文件名,ID 因为基于 relPath 所以会改变.
// 旧笔记文件的 id 随之失效,任何依赖旧 ID 的引用(收藏夹 items、搜索 FTS)将不再匹配。
// 调用方需自行更新引用方。
export async function renameNote(
  dataPath: string,
  oldRelPath: string,
  newFilename: string,
): Promise<StandaloneNote> {
  // C3R76: 与 createNote 共享 normalizeAndValidateNoteFilename,
  // 单一 regex + 后缀规则,避免 silent drift
  const fn = normalizeAndValidateNoteFilename(newFilename, 'newFilename');
  // audit-r175 (2026-10-19) —— 重命名只改**文件名**,保留所在目录。
  //
  // 旧实现 `const newRelPath = fn;` 把整条 relPath 直接换成新文件名,
  // 于是:
  //   - 'sub/a.md' 重命名成 'b.md' → 文件被搬到 notes 根('sub' 里那条
  //     笔记凭空消失,用户以为只是改了个名)。renderer 侧 sidebar 的
  //     visibleItemRows 按 dirname(relPath) === currentRelPath 过滤,
  //     文件一挪到根,当前文件夹视图里就再也看不到它 —— 与用户诉求
  //     「左侧列表和对应文件夹完全一致」直接冲突。
  //   - 同款 bug 还顺手打死了子目录内的**仅大小写重命名**
  //     ('sub/a.md' → 'A.md'):旧代码算出的 newRelPath='A.md' 与
  //     oldRelPath='sub/a.md' 大小写不等,进不了下方 case-only 分支,
  //     落到 fs.open('wx') 撞 EEXIST → 误报「已存在同名笔记」。
  // 现在按「父目录 + 新文件名」重拼,目录归属不动。
  const parentDir = parentDirOfRelPath(oldRelPath);
  const newRelPath = parentDir ? `${parentDir}/${fn}` : fn;
  if (newRelPath === oldRelPath) {
    const cur = await readNote(dataPath, oldRelPath);
    if (cur) return cur;
    throw new LibraryError('IO_ERROR', tr('notes.notFoundPath', { path: oldRelPath }));
  }
  // 检查新文件名未被占用
  // audit C3R13 (2026-08-22):与 createNote 对齐,改用 DUPLICATE_NAME code。
  // 之前 renameNote 与 createNote 抛同款 IO_ERROR 但 IPC handler 只翻译
  // create(create/rename 行为不一致),rename 撞名会让 UI 弹出
  // "IO_ERROR: 已存在同名笔记..." 误导用户以为是系统问题。
  // audit 2026-08-25:删 fs.access TOCTOU 预检 —— 新路径是否被占用的判断,留到
  // 下面 fs.open(O_EXCL|'wx') 单 syscall 直接撞;access 之后到 write 之间
  // 仍可能被 watcher race 创建同名文件覆盖别人内容。把 EEXIST 翻译成 DUPLICATE_NAME。
  const oldFull = toNotePath(dataPath, oldRelPath);
  const newFull = toNotePath(dataPath, newRelPath);
  let raw: string;
  try {
    raw = await readBodyWithCap(oldFull);
  } catch (err: unknown) {
    if (errnoCode(err) === 'ENOENT') {
      throw new LibraryError('NOT_FOUND', tr('notes.notFoundPath', { path: oldRelPath }));
    }
    throw err;
  }
  const parsed = matter(raw);
  const fm = parsed.data as Record<string, unknown>;
  const now = new Date().toISOString();
  const newFm = cleanFm({
    ...fm,
    id: computeFileId(newRelPath),
    // audit C2R14 (2026-08-22):rename 应当保留既有 title — 原实现 `title: fn.replace(/\.md$/, '')`
    // 总是用新文件名覆盖,导致 'My Note.md' 重命名为 'renamed.md' 后 title 从 'My Note'
    // 变成 'renamed'。rename 只改文件名,不该改 frontmatter 内容;若没有 title 才
    // 回退用文件名(与 createNote 行为一致)。
    title: typeof fm['title'] === 'string' ? fm['title'] : stripExt(fn),
    updated: now,
  });
  const content = matter.stringify(parsed.content, asFrontmatter(newFm));
  // audit 2026-10-08 (HIGH):resolveInsideRootPath 校验 dataPath + symlink 防御。
  //   旧实现裸 fs.open('wx') 绕过 resolveInsideDataPath,与 createNote:333 同根问题。
  //   不能直接换 safeWriteFileAtomic(后者替换语义,丢 DUPLICATE_NAME),
  //   在 fs.open 之前 explicit 调一次接上校验。详见 createNote 注释。
  resolveInsideRootPath(newFull);
  await fs.mkdir(dirname(newFull), { recursive: true });
  // audit-r80 (2026-10-17) MEDIUM:仅大小写差异的重命名(Note.md → note.md)。
  //   NTFS / 默认 APFS 大小写不敏感:目标「已存在」,下面 'wx' 必抛 EEXIST
  //   → 误报 DUPLICATE_NAME,用户看到「已存在同名笔记」且仅改大小写永远
  //   失败(本机实证:fs.open('note.md','wx') → EEXIST,而 fs.rename 成功)。
  //   检测:字面不等(上面早返已排)但 ignore-case 相等 → 先 stat 确认新旧
  //   是同一文件(Linux 大小写敏感 fs 上 note.md 可能是**另一个**文件,
  //   那种情形仍走 'wx'/DUPLICATE_NAME 正常路径),是则 fs.rename 换位 +
  //   atomic 重写烧新 fm(id 由 relPath 派生,大小写变则 id 变)。
  if (newRelPath.toLowerCase() === oldRelPath.toLowerCase()) {
    const newStat = await fs.stat(newFull).catch(() => null);
    if (newStat) {
      const oldStat = await fs.stat(oldFull);
      if (oldStat.dev === newStat.dev && oldStat.ino === newStat.ino) {
        // r175:退避重试(Windows 瞬时占用 / chokidar 持句柄 → EPERM)
        await retryOnWindowsTransient(
          () => fs.rename(oldFull, newFull),
          () => Promise.resolve(),
        );
        await safeWriteFileAtomic(newFull, content);
        invalidateFsCache(newFull);
        invalidateFsCache(oldFull);
        const renamed = await readNote(dataPath, newRelPath);
        if (!renamed) {
          throw new LibraryError('IO_ERROR', tr('notes.renameReadbackFailed'));
        }
        return renamed;
      }
      // 不同文件(大小写敏感 fs 上的真撞名)→ 落到下方 'wx' 拿 DUPLICATE_NAME
    }
  }
  // O_EXCL 'wx' 原子地"只有不存在时才创建 + 写入"。EEXIST 直接翻译成 DUPLICATE_NAME,
  // 比 pre-access 更窄,且拿到 fd 后能 fsync(断电保护)再 close。
  // audit 2026-09-10:writeFile / sync 抛错时清理刚创建的 0-byte / 半截内容文件 ——
  //   'wx' 模式已成功创建文件(fd 拿到了),写入失败 → 磁盘上留下残文件,用户重试同
  //   名 rename 直接 EEXIST 被永久卡住。catch 走 safeUnlink 清理后 throw IO_ERROR
  //   让 UI 看到真错(open 阶段 EEXIST 走 DUPLICATE_NAME,不 unlink 旧文件)。
  let renameFh: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    renameFh = await fs.open(newFull, 'wx');
    await renameFh.writeFile(content, 'utf-8');
    await renameFh.sync();
  } catch (err: unknown) {
    const hadFh = renameFh !== null;
    if (hadFh) {
      // audit 2026-09-14:rename 失败路径 fd close / safeUnlink 改 warn —— Windows
      //   上 .md 文件被 AV 进程短暂持有时 close/unlink 会偶发 EBUSY,日志可观察。
      // audit round 8 (2026-09-14):走 safeCloseFh helper。
      await safeCloseFh(renameFh, 'renameFh.close failed during rename rollback', log, {
        path: newFull,
      });
    }
    if (errnoCode(err) === 'EEXIST') {
      throw new LibraryError('DUPLICATE_NAME', tr('notes.duplicateName', { name: newRelPath }));
    }
    // open 阶段就抛 EEXIST → 没创建文件;写阶段抛错 → 我们刚创建了,清掉
    // (无法区分 errnoCode,统一走 safeUnlink 兜底 ENOENT,反正失败也无副作用)
    await safeUnlink(newFull).catch((unlinkErr: unknown) =>
      log.warn('safeUnlink failed during rename rollback', {
        path: newFull,
        err: errMsg(unlinkErr),
      }),
    );
    throw new LibraryError(
      'IO_ERROR',
      tr('notes.renameNewFailed', { path: newRelPath, reason: errMsg(err) }),
    );
  }
  // audit 2026-10-04 (P0):close() 原先落在 try/catch **之外**。Windows 上
  //   Defender / OneDrive / 杀毒软件短暂持有新文件句柄时它抛 EBUSY,此刻新文件
  //   已完整落盘(含 fsync)而旧文件仍在磁盘上,函数抛裸 fs 错误 →
  //   NotesService.renameFile 在 byId.delete/set 之前就抛出,内存索引仍指向旧 id,
  //   下次 chokidar 重扫把同一份内容索引两遍(UI 重复条目 + notes_fts 重复行)。
  //   这正是紧邻其下的 unlink rollback 注释里警告过的后果,只是漏了上面这一行。
  //   修法:与下方 unlink 失败同款 —— 回滚刚写的新文件,恢复「磁盘恰好一份」不变式。
  try {
    await renameFh.close();
  } catch (closeErr: unknown) {
    log.warn('[standalone] renameNote: close new file failed, rolling back new file', {
      oldFull,
      newFull,
      err: errMsg(closeErr),
    });
    try {
      await safeUnlink(newFull);
      invalidateFsCache(newFull);
    } catch (rollbackErr: unknown) {
      log.error(
        '[standalone] renameNote close rollback also failed — both files may exist on disk',
        {
          oldFull,
          newFull,
          rollbackErr: errMsg(rollbackErr),
        },
      );
    }
    throw new LibraryError(
      'IO_ERROR',
      tr('notes.renameNewFailed', { path: newRelPath, reason: errMsg(closeErr) }),
    );
  }
  // perf(2026-08-24):fs-cache invalidate 新旧两条路径
  invalidateFsCache(newFull);
  try {
    await safeUnlink(oldFull);
    invalidateFsCache(oldFull);
  } catch (err: unknown) {
    // audit C3R38 (2026-08-22):renameNote 之前 write-then-unlink 不是原子的 —
    // safeUnlink 在 Windows 上偶尔抛 EPERM/EBUSY(杀毒软件 / OneDrive sync / 文件
    // 句柄未释放),如果失败就会留下两个文件:新路径 + 旧路径都有同一份内容。
    // NotesService 已经更新了 in-memory 索引指向新 id,但 disk 上旧文件还在 →
    // 下次 scan 索引两份内容相同的笔记,UI 列出重复条目、notes_fts 重复行、
    // 收藏夹命中两个不同 id 但内容相同。
    // 修复:unlink 失败时回滚刚写的新文件(尝试 unlink newFull)。若 rollback 也失败,
    // log error 留 trace 但仍 throw IO_ERROR — 用户至少能看到错误,运维可以从 log 恢复。
    log.warn('[standalone] renameNote: unlink old file failed, rolling back new file', {
      oldFull,
      newFull,
      err: errMsg(err),
    });
    try {
      await safeUnlink(newFull);
    } catch (rollbackErr: unknown) {
      log.error('[standalone] renameNote rollback also failed — both files may exist on disk', {
        oldFull,
        newFull,
        rollbackErr: errMsg(rollbackErr),
      });
    }
    throw new LibraryError(
      'IO_ERROR',
      tr('notes.deleteOldFailed', { path: oldRelPath, reason: errMsg(err) }),
    );
  }
  const updated = await readNote(dataPath, newRelPath);
  if (!updated) {
    throw new LibraryError('IO_ERROR', tr('notes.renameReadbackFailed'));
  }
  return updated;
}

// r161+ disk-folder Phase 2b:跨文件夹移动笔记(物理 fs.rename + frontmatter
//   id 重写)。与 renameNote 的区别:
//     * `targetRelPath` 是「目标目录」相对路径('' = 根,'foo','foo/bar'),不
//       含文件名;newRelPath 自动拼 `${targetRelPath}/${basename(oldRelPath)}`
//     * 不调 readBodyWithCap 重写整个 body —— fs.rename 保内容,只需 fsync
//       一下 frontmatter 烧新 id(id = hash(relPath),relPath 变则 id 变)
//     * 同 writeLock 串行化由 NotesService.moveFile 提供(IPC handler 调
//       svc.moveFile,不走 helper 自身)
//
// 边界:
//   * targetRelPath 不允许绝对 / 含 '..' / 空段 —— ValidationError(field='targetRelPath')
//   * newRelPath === oldRelPath → no-op(返回当前态)
//   * 旧文件不存在 → NOT_FOUND
//   * 目标已被占用 → DUPLICATE_NAME
//   * 父目录不存在自动 fs.mkdir({recursive: true}) 创建
//
// 旧实现(2026-10-18 之前):用户「移入文件夹」= DB 列更新(folder_id),物理
//   文件位置不动,与「文件管理」直觉不符(用户预期 VS Code / Finder 语义)。
//   新实现:真实 fs.rename 跨目录,跨文件管理语义对齐。
export async function moveNoteAcrossFolders(
  dataPath: string,
  oldRelPath: string,
  targetRelPath: string,
): Promise<StandaloneNote> {
  // targetRelPath 段校验(同 folders IPC 的 requireRelPath,但在这里走纯函数
  //   不依赖 IPC 通道名)。空字符串是「根」合法形态(targetRelPath = '' → 拼
  //   ${''}/basename = basename,等同于移到根)
  assertTargetRelPath(targetRelPath, 'moveNoteAcrossFolders');
  const basename = oldRelPath.split('/').pop()!;
  if (!basename) {
    throw new ValidationError('moveNoteAcrossFolders: oldRelPath has no basename', 'oldRelPath');
  }
  const newRelPath = targetRelPath ? `${targetRelPath}/${basename}` : basename;
  if (newRelPath === oldRelPath) {
    // 同位置 → no-op,读现状返
    const cur = await readNote(dataPath, oldRelPath);
    if (cur) return cur;
    throw new LibraryError('NOT_FOUND', tr('notes.notFoundPath', { path: oldRelPath }));
  }
  // resolveInsideRootPath 守门越界(r155 safeTrash 范式,audit-r80 重申)
  const oldFull = toNotePath(dataPath, oldRelPath);
  const newFull = toNotePath(dataPath, newRelPath);
  resolveInsideRootPath(oldFull);
  resolveInsideRootPath(newFull);
  // 父目录自动创建(notes 域子目录可能未 chokidar 创建)
  await fs.mkdir(dirname(newFull), { recursive: true });
  // audit-r175 (2026-10-19) —— 目标已存在必须**提前拦下**,不能靠 rename 报错。
  //
  // 旧注释「fs.rename 保内容;新位置已存在(外部 race)→ EEXIST 翻译
  // DUPLICATE_NAME」是错的:文件级 rename **从不**返回 EEXIST ——
  // Windows libuv 走 MoveFileExW(MOVEFILE_REPLACE_EXISTING),POSIX 是
  // rename(2),两者都会**静默替换**已存在的目标文件。后果:把 A/b.md
  // 拖进 B/(B 里已有 b.md)→ B/b.md 的内容被直接销毁,源文件也消失,
  // **无报错、无 toast、UI 显示成功**。这是真实的数据丢失路径。
  // 现在先 lstat 预检:目标存在 → DUPLICATE_NAME,不碰任何文件。
  const targetExists = await fs.lstat(newFull).then(
    () => true,
    () => false,
  );
  if (targetExists) {
    throw new LibraryError('DUPLICATE_NAME', tr('notes.duplicateName', { name: newRelPath }));
  }
  // fs.rename 保内容;新位置已存在(外部 race)→ EEXIST 翻译 DUPLICATE_NAME
  try {
    // r175:退避重试(Windows 瞬时占用 / chokidar 持句柄 → EPERM)
    await retryOnWindowsTransient(
      () => fs.rename(oldFull, newFull),
      () => Promise.resolve(),
    );
  } catch (err: unknown) {
    const code = errnoCode(err);
    if (code === 'ENOENT') {
      throw new LibraryError('NOT_FOUND', tr('notes.notFoundPath', { path: oldRelPath }));
    }
    if (code === 'EEXIST' || code === 'ENOTEMPTY') {
      throw new LibraryError('DUPLICATE_NAME', tr('notes.duplicateName', { name: newRelPath }));
    }
    throw new LibraryError(
      'IO_ERROR',
      tr('notes.moveFailed', { path: oldRelPath, reason: errMsg(err) }),
    );
  }
  // fs-cache invalidate
  invalidateFsCache(oldFull);
  invalidateFsCache(newFull);
  // fs.rename 不改内容 → frontmatter id 仍写的是旧 relPath 的 id,需重写烧新
  //   id(id = computeFileId(newRelPath))。读新位置 + parse + 改 id + 原子写回。
  return repinNoteId(dataPath, newRelPath);
}

/**
 * audit-r175:笔记文件夹**改名**(basename 变,父目录不变)。
 *
 * 与 moveNoteDirAcrossFolders 的差别:那边的新 relPath 由
 * `targetRelPath + '/' + basename` 推导(搬移语义),这边由 caller
 * 直接给(改名语义 —— 名字本身要变)。
 *
 * 为什么必须有这个入口:重命名文件夹后,子树里每个 .md 的 relPath 都变了
 * ⇒ 笔记 id(= SHA-256(relPath))全变。旧实现(IPC 层裸 fs.rename)只搬
 * 目录、**不重钉 frontmatter id、也不更新 DB 的 rel_path** ⇒
 *   - 文件里的 fm.id 还是旧路径的哈希,下一次写盘会突变 id(renderer
 *     没跟上 → 之后每次保存都 NOT_FOUND,新敲的字困在死 id 草稿里);
 *   - DB 的 rel_path 停在旧路径,搜索命中的路径信息是旧的。
 * 物理搬家这一层与 moveNoteDirAcrossFolders 同款(目标存在 → 拒)。
 */
export async function renameNoteDir(
  dataPath: string,
  oldRelPath: string,
  newRelPath: string,
): Promise<string> {
  if (newRelPath === oldRelPath) return oldRelPath;
  if (newRelPath.startsWith(`${oldRelPath}/`)) {
    throw new ValidationError(
      'renameNoteDir: cannot rename a folder into its own subtree',
      'newRelPath',
    );
  }
  const oldFull = toNotePath(dataPath, oldRelPath);
  const newFull = toNotePath(dataPath, newRelPath);
  resolveInsideRootPath(oldFull);
  resolveInsideRootPath(newFull);
  await fs.mkdir(dirname(newFull), { recursive: true });
  // 目标已存在 → 拒(POSIX 上目录 rename 会把**空**目标目录静默替换掉)
  const targetExists = await fs.lstat(newFull).then(
    () => true,
    () => false,
  );
  if (targetExists) {
    throw new LibraryError('DUPLICATE_NAME', tr('notes.duplicateName', { name: newRelPath }));
  }
  try {
    // r175:退避重试(Windows 瞬时占用 / chokidar 持句柄 → EPERM)
    await retryOnWindowsTransient(
      () => fs.rename(oldFull, newFull),
      () => Promise.resolve(),
    );
  } catch (err: unknown) {
    const code = errnoCode(err);
    if (code === 'ENOENT') {
      throw new LibraryError('NOT_FOUND', tr('notes.notFoundPath', { path: oldRelPath }));
    }
    if (code === 'EEXIST' || code === 'ENOTEMPTY') {
      throw new LibraryError('DUPLICATE_NAME', tr('notes.duplicateName', { name: newRelPath }));
    }
    throw new LibraryError(
      'IO_ERROR',
      tr('notes.moveFailed', { path: oldRelPath, reason: errMsg(err) }),
    );
  }
  invalidateFsCache(oldFull);
  invalidateFsCache(newFull);
  return newRelPath;
}

/**
 * r186:relPath 校验委托 shared/rel-path.ts —— 本函数原先是**第二份**手写
 *   规则(与 ipc/folders.ts 的第三份不一致),两份对同一串给出不同答案:
 *   本函数放行「首字符是空白」的段,folders.ts 拒收 ⇒ 磁盘上名字以空格
 *   开头的夹,笔记搬得进去,侧栏却点不进去。详见 shared/rel-path.ts 头注。
 *
 * 根目录语义不变:targetRelPath === '' 是合法的「根」(不是 null)。
 */
export function assertTargetRelPath(targetRelPath: string, label: string): void {
  const problem = validateRelPath(targetRelPath, { allowRoot: true });
  if (problem) {
    throw new ValidationError(`${label}: targetRelPath ${problem.message}`, 'targetRelPath');
  }
}

/**
 * 把 relPath 上的笔记 frontmatter id 重钉到 computeFileId(relPath)。
 *
 * 笔记 id 与路径强绑定(frontmatter.id = SHA-256(relPath) 前 16 位),路径
 * 一变 id 就必须跟着变 —— 否则 byId 索引 / DB 行 / 文件内容三处指向不同
 * 的 id,「打开刚搬过去的笔记」必然 NOT_FOUND。
 *
 * 单独抽出来的原因:整目录搬移(r173)里,目录 fs.rename 之后子树里每个
 * .md 的路径都变了,需要逐个重钉;单文件搬移走同一条路(只是它自带
 * fs.rename)。两条路共用本函数 = 规则只有一份。
 */
export async function repinNoteId(dataPath: string, relPath: string): Promise<StandaloneNote> {
  const full = toNotePath(dataPath, relPath);
  const current = await readNote(dataPath, relPath);
  if (!current) {
    throw new LibraryError('IO_ERROR', tr('notes.moveReadbackFailed', { path: relPath }));
  }
  const expectedId = computeFileId(relPath);
  if (current.id === expectedId) return current;
  // 改 frontmatter id,title 保留(同 renameNote 范式)
  const rawContent = await readBodyWithCap(full);
  const parsed = matter(rawContent);
  const fm = (parsed.data ?? {}) as Record<string, unknown>;
  const now = new Date().toISOString();
  const newFm = asFrontmatter({
    ...fm,
    id: expectedId,
    title: typeof fm['title'] === 'string' ? fm['title'] : stripExt(filenameOf(relPath)),
    updated: now,
  });
  const newContent = matter.stringify(parsed.content, newFm);
  // safeWriteFileAtomic 内部走 resolveInsideRootPath,无需二次校验
  await safeWriteFileAtomic(full, newContent);
  invalidateFsCache(full);
  // perf r239:同 writeNote —— stat 门控解析缓存显式失效(见 writeNote 注释)
  noteParseCache.delete(caseInsensitiveFsKey(full));
  // 重读一遍返最新态
  const updated = await readNote(dataPath, relPath);
  if (!updated) {
    throw new LibraryError('IO_ERROR', tr('notes.moveReadbackFailed', { path: relPath }));
  }
  return updated;
}

/**
 * 跨父目录搬移整个笔记目录(子树)。
 *
 * 与 moveNoteAcrossFolders(单文件)同款校验 + fs.rename,差异:
 *   - 搬的是目录(整棵子树跟着走,非 .md 的文件也带走 —— 用户在目录里
 *     放的东西不该被静默丢弃);
 *   - **不重钉 frontmatter id** —— 子树里每个 .md 的 id 重钉由 service
 *     层逐个调 repinNoteId 完成(需要 byId 索引 + DB 事务配合,纯 fs 层
 *     做不了)。本函数只负责「路径搬家」。
 *
 * 边界:
 *   - 不能搬进自己的子树(newRelPath 以 oldRelPath + '/' 开头)—— 那是
 *     自我嵌套,fs.rename 会 EINVAL,而且用户也表达不了这个意图;
 *   - 旧目录不存在 → NOT_FOUND;目标已被占用 → DUPLICATE_NAME;
 *   - 父目录不存在自动 fs.mkdir({recursive: true}) 创建。
 */
export async function moveNoteDirAcrossFolders(
  dataPath: string,
  oldRelPath: string,
  targetRelPath: string,
): Promise<string> {
  assertTargetRelPath(targetRelPath, 'moveNoteDirAcrossFolders');
  const basename = oldRelPath.split('/').pop()!;
  if (!basename) {
    throw new ValidationError(
      'moveNoteDirAcrossFolders: oldRelPath has no basename',
      'oldRelPath',
    );
  }
  const newRelPath = targetRelPath ? `${targetRelPath}/${basename}` : basename;
  if (newRelPath === oldRelPath) {
    // 同位置 → no-op(目录已在目标处,什么都不搬)
    return oldRelPath;
  }
  if (newRelPath.startsWith(`${oldRelPath}/`)) {
    throw new ValidationError(
      'moveNoteDirAcrossFolders: cannot move a folder into its own subtree',
      'targetRelPath',
    );
  }
  const oldFull = toNotePath(dataPath, oldRelPath);
  const newFull = toNotePath(dataPath, newRelPath);
  resolveInsideRootPath(oldFull);
  resolveInsideRootPath(newFull);
  await fs.mkdir(dirname(newFull), { recursive: true });
  // r175:目标目录已存在 → 提前拒(目录级 rename 在 POSIX 上会把**空**目标
  //   目录静默替换掉,Windows 上抛 EPERM —— 跨平台行为不一致,必须自己拦)。
  const targetDirExists = await fs.lstat(newFull).then(
    () => true,
    () => false,
  );
  if (targetDirExists) {
    throw new LibraryError('DUPLICATE_NAME', tr('notes.duplicateName', { name: newRelPath }));
  }
  try {
    // r175:退避重试(Windows 瞬时占用 / chokidar 持句柄 → EPERM)
    await retryOnWindowsTransient(
      () => fs.rename(oldFull, newFull),
      () => Promise.resolve(),
    );
  } catch (err: unknown) {
    const code = errnoCode(err);
    if (code === 'ENOENT') {
      throw new LibraryError('NOT_FOUND', tr('notes.notFoundPath', { path: oldRelPath }));
    }
    if (code === 'EEXIST' || code === 'ENOTEMPTY') {
      throw new LibraryError('DUPLICATE_NAME', tr('notes.duplicateName', { name: newRelPath }));
    }
    throw new LibraryError(
      'IO_ERROR',
      tr('notes.moveFailed', { path: oldRelPath, reason: errMsg(err) }),
    );
  }
  invalidateFsCache(oldFull);
  invalidateFsCache(newFull);
  return newRelPath;
}
