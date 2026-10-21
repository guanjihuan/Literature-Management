// 文献服务(audit-r136)—— 内存索引 + chokidar 监听 + writeLock 串行化
// + disk↔DB diff 重载(与 NotesService 1:1 镜像,差异点见下文)。
//
// 触发动机:用户报「在 OS 资源管理器里直接放进 library 目录后,UI 不刷新」。
// 根因是 literature 域只有 import/delete 写路径,reload 路径仅在写后被
// store 主动 force 触发,OS 拖入 / 外部修改完全感知不到 → chokidar 加
// 监听 + active disk↔DB diff 双向补齐。
//
// 镜像 NotesService 的部分(同形不改):
//   - chokidar.watch 同款:ignoreInitial / awaitWriteFinish / depth /
//     异步 'error' 2s 退避重启 / MAX 重启上限
//   - writeLock 串行化所有 reload 与 mutation
//   - reload 走 scheduleReload 防抖 100ms
//   - stop() 顺序:started=false → 清 timer → close watcher → writeLock.drain
//     → byId.clear
//
// 与 NotesService 的差异(本域无 body、无编辑路径):
//   - awaitWriteFinish.stabilityThreshold: 200(500MB PDF 拷贝要数秒,notes
//     50ms 太短,mid-copy 触发 change 会让 stat 拿到 partial size 错位)
//   - 无 create / write / renameFile / trash(无编辑路径);r170 起 import /
//     remove / move 也收进 service(importFile / remove / moveFile),IPC
//     handler 只做参数校验 + 透传
//   - 无 resyncIfNeeded(audit-r124 收敛到 reload 内就地 diff,无 db-only
//     决策 modal 链路):reload() 本身就是 disk↔DB diff,见下方 reload body
//   - byId key 是 litResourceId(toPosix(absPath))(POSIX 化,见
//     resources-repo.ts:212 litRelPath 把 rel_path 写成 absPath 自身,0004
//     列 NOT NULL 兜底,id 也用 absPath 的 POSIX 形态 → 双向一致)
//
// 核心 reload 逻辑(active disk↔DB diff,NotesService 无):
//   1. **递归**扫 <rootPath>/literature/ 子树,过滤 symlink + dot +
//      非 file → diskPaths(audit-r172:旧实现只 readdir 顶层,而 literature
//      域有真实子目录 —— 子目录里的文件既扫不到也监听不到)
//   2. diskIds = diskPaths.map(litResourceId(toPosix(absPath)))
//   3. dbRows = listResources('literature');diskIdSet 与 dbIdSet 互比
//   4. **disk-only**(磁盘有 DB 无):stat 后 upsert(filename-only +
//      indexedAt=0 + folderId=null,新行默认根归属)+ 入 next
//   5. **db-only**(磁盘无 DB 有):deleteResource + 不入 next(自然丢弃)
//   6. byId = next;emit('changed')(订阅端 self-write 抑制窗口兜底,无
//      副作用频次问题)
//
// 与 0005 迁移行的关系(保守保留策略,audit-r136 H1):迁移行 rel_path 是
//   '<oldRoot>/...',id 是 'lit:'+rel POSIX 形态,新行 id 是
//   'lit:'+toPosix(newAbsPath)。新 rootPath/literature/ 子树扫不到旧 root,
//   迁移行 absPath 也不在 diskIdSet 里,直观看就是「db-only」。
// 修法(db-only 分支):删行前先 `isReallyGone(r.absPath)`(r219 起;
//   旧实现用裸 existsSync,把「读不到」压成「没了」⇒ Defender/同步盘
//   一次瞬时 EACCES/EPERM 就把还在磁盘上的文献从索引里删掉):
//   - 文件还在磁盘(用户升级场景:旧库路径里还有 PDF;或读不到 ⇒
//     fail-safe 当还在)→ 重生成一行
//     litResourceId(toPosix(r.absPath)) 新 id + 抄 folderId + deleteResource 旧
//     行。后续 reload 磁盘↔DB diff 把这行收敛成「in-disk」分支,再不会被
//     当 ghost 清掉;
//   - 文件确实没了(ENOENT)→ 真 deleteResource(ghost row 收敛语义保留,
//     audit-r124 notes 同款「磁盘文件已外部消失 → 就地清理」)。
// 为什么不无条件保留:用户从旧库手动搬走 / 删了所有文件,ghost row 必须清;
// 不 why-not 重迁 0005:迁移通道是单次性的(utils/migrate-old-userdata.ts
//   一次性读 files 表,2026-10-02 后该表已 drop,跑不动);r136 起保留策略
//   替代重迁,旧行原地升级成新 id。

import { EventEmitter } from 'events';
import chokidar, { FSWatcher } from 'chokidar';
import { promises as fs } from 'fs';
import type { Dirent, Stats } from 'fs';
import { basename, dirname, extname, join, relative } from 'path';
import type { LiteratureResource, Resource, ResourceId } from '@shared/types';
import type { FolderMoveResult } from '@shared/types';
import { WORKSPACE_DATA_LAYOUT } from '@shared/types';
import { litResourceId } from '@shared/resource-id';
import { validateRelPath } from '@shared/rel-path';
import { toPosix } from '../notes/path-mapping';
import {
  deleteResource,
  listResources,
  renameResource,
  updateResourceStat,
  upsertResource,
} from '../db/resources-repo';
import { getRootPath } from '../utils/safe-write';
// r175:Windows 上目录/文件 rename 会因「chokidar 正打开该文件读 stat」
//   而抛 EPERM(本机实证:持句柄时 rename 父目录 → EPERM,句柄释放后成功)。
//   退避重试一小段窗口即可;cleanup 传 noop —— rename 失败时绝不能删源。
import { retryOnWindowsTransient } from '../utils/retry-transient';
import { errMsg, LibraryError } from '../utils/error';
import { isReallyGone } from '../utils/file-check';
import { createLogger } from '../utils/logger';
import { WriteLock } from '../utils/write-lock';
import { runPool } from '../utils/run-pool';
import { closeWatcherQuietly, withWatcherReleased } from '../utils/watcher-release';
import { tr } from '../i18n';
import { importLiteratureFile, removeLiteratureFile } from './import';
import { performLiteratureRename, planLiteratureRename } from './rename-file';
import type { LiteratureImportResult } from '@shared/api-types';

const log = createLogger('literature-service');

const RELOAD_DEBOUNCE_MS = 100;
// audit-r172:literature 域**不再**是扁平布局 —— UI 有真实的 literature
//   文件夹树(litMkdir / litListDirs / litMove 都能在 literature/ 下建子目录
//   并把文件搬进去),但本 watcher 的 depth 一直是 0(头注「物理布局扁平」),
//   于是:
//     - 子目录里的文件既不被监听也不被扫描发现(OS 直接丢进子目录的 PDF
//       完全不可见);
//     - 手动扫描 readdir 只看顶层,子目录里的文件永远不进 diskPaths。
//   与 notes 侧对齐:depth 16(chokidar depth 0-based = 顶层 + 16 层),
//   扫描侧同深度上限 —— 双向对齐后不存在「监听到了但扫描漏」/「扫描到了
//   但没监听」的孤儿(notes 同款约定见 notes/standalone.ts MAX_COLLECT_DEPTH)。
const MAX_LITERATURE_WATCH_DEPTH = 16;
// 递归扫描深度上限(与 watcher depth 对齐)。
const MAX_LITERATURE_SCAN_DEPTH = 16;
// 与 notes 同款:防永久坏路径触发 2s 一轮 log 风暴。
const MAX_LITERATURE_AUTO_RESTARTS = 5;
const LITERATURE_WATCHER_RESTART_DELAY_MS = 2000;
/** watcher「健康期」窗口(与 notes 同款):重启后这段时间内不再报错 ⇒ 上一次
 *  失败是孤立事件,连续失败计数可以清零。 */
const LITERATURE_WATCHER_HEALTHY_MS = 30_000;
// audit-r162 H1:0005 迁移行 absPath 落在旧库路径(如 `D:\old-lib\paper.pdf`),
//   新 rootPath 的 chokidar 不 watch 旧库 —— 用户从资源管理器删旧库 PDF 时
//   chokidar 'unlink' 不触发,byId 永久保留已死文件,UI 列表展示「已不存在
//   的 PDF」误导。60s 周期 isReallyGone 检测旧库行,**确定**不在(ENOENT)
//   才 deleteResource + byId.delete 收敛;「读不到」fail-safe 当还在(r219)。
const LITERATURE_EXTERNAL_RESYNC_INTERVAL_MS = 60_000;
/**
 * r211:刷 stat 的并发上限 —— reload 每次都要给**已在索引里**的每个文件
 *   stat 一次(见 refreshDiskStats)。串行 stat 几千个文件要几百 ms,
 *   并发跑池把并发钉在 16(与 notes 侧读文件同量级),单次 stat ~0.1ms ⇒
 *   几千个文件也只有几十 ms,盖在 reload 本来就要做的整棵子树 readdir 上。
 */
const LITERATURE_STAT_CONCURRENCY = 16;

/**
 * perf r254:扫描期拿到的文件 stat 信息 —— 复用 collectLiteratureFiles 里
 *   那次 lstat 的结果,省掉 reload 后半段「每个文件再 stat 一遍」。
 *
 * 背景(实测,2000 个文献文件 / 20 个子目录):
 *   旧实现每轮 reload 做**两遍**stat:
 *     ① 扫描期 collectLiteratureFiles:每文件一次 lstat(只为 symlink 防御),
 *        拿到的 mtimeMs / size 被**直接丢掉**;
 *     ② 刷新期 refreshDiskStats:对每个已在库的文件再来一次 fs.stat。
 *   实测 ①≈40ms + ②≈35ms = 75ms/轮;reload 是 chokidar 100ms 防抖的
 *   高频路径(用户往库里丢一批 PDF / 同步盘落一批文件 = 连续几轮),
 *   75ms 全是纯 I/O 等待,而 ① 的结果本来就在手上。
 *
 * 语义等价性:lstat 与 stat 对**同一个普通文件**返回同一个 inode 的
 *   mtimeMs / size(逐字相同)。而进入扫描分支的必然是普通文件 ——
 *   Dirent.isFile() 对 symlink 返 false(symlink 文件进不来),且分支内
 *   还有 st.isSymbolicLink() 二次拦截「readdir→stat 之间被换成 symlink」
 *   的 race。⇒ 用 lstat 的值替代 stat 的值不改变任何可观察行为。
 *
 * 「拿不到 stat」的处置口径不变(r211 契约):扫描期 lstat 失败 ⇒ 该文件
 *   **不进 diskPaths** ⇒ 落进 db-only 分支 ⇒ isReallyGone 只在 ENOENT
 *   时才判「没了」,其余(EPERM / EBUSY)fail-safe 当「还在」⇒ 行保留旧值。
 */
export interface LitDiskStat {
  mtimeMs: number;
  size: number;
}

/**
 * audit-r172:文献行的「文件夹归属」—— absPath 相对 literature 根的 POSIX 路径。
 *
 * 为什么放在 service 而不是 DB 层:rel_path 列对 literature 行退化成 absPath
 * 本身(0004 列 NOT NULL 兜底,见 db/resources-repo.ts litRelPath),DB 行自己
 * 不知道 literature 根在哪;service 知道(join(rootPath, 'literature'))。
 *
 * 越界(文件不在 literature 子树内 —— 典型是 0005 迁移行指向旧库路径)返回
 * '':renderer 侧 dirnameOfRelPath('') = '' ⇒ 该行归到根视图,与迁移行的
 * 既有语义一致(旧库里没有可导航的子目录)。
 */
export function litRelPathOf(litDir: string, absPath: string): string {
  const rel = relative(litDir, absPath);
  if (!rel) return '';
  // 越界(relative 返 '..' 开头)或绝对路径 → 不属于 literature 子树
  if (rel.startsWith('..') || rel.includes(':') || rel.startsWith('/')) return '';
  return toPosix(rel);
}

/**
 * perf r257:两轮扫描的 per-file 状态是否**完全相同**(emit 幂等判定)。
 *
 * 判定语义与旧的「`${id}|${mtime}|${size}` 排序 join 后比字符串」**一字
 * 不差**:集合相同(条数一致)且每条的 (mtime, size) 一致 ⇒「没变」。
 * 差别只在代价:旧实现每次 reload 要拼 N 个字符串 + 排序 + join
 * (实测 ≈ 0.8ms/2000 行 @108 字符 id,纯主线程 CPU;顺带每轮多分配
 * ≈ 250KB 字符串),这里只做 O(n) 逐项比对(≈ 0.13ms)。
 *
 * 「同长不同文 + mtime 保留」判成「没变」—— 这是 r211 双因子口径一直接
 * 受的盲区(备份还原 / cp -p / 同步盘按内容去重),不是本函数引入的。
 * 与 notes 侧 r255 的 sameNoteState 同款(孪生实现口径要对齐)。
 */
function sameLitState(
  a: Map<ResourceId, { mtime: number; size: number }> | null,
  b: Map<ResourceId, { mtime: number; size: number }>,
): boolean {
  if (!a) return false; // 首轮:必 emit
  if (a.size !== b.size) return false;
  for (const [id, v] of b) {
    const prev = a.get(id);
    if (prev === undefined) return false;
    if (prev.mtime !== v.mtime || prev.size !== v.size) return false;
  }
  return true;
}

/**
 * audit-r172:递归收集 literature 子树下的普通文件(跳过 dot 隐藏项 /
 * symlink / junction,防止 symlink 环把扫描挂死 —— notes 侧同款防御见
 * notes/standalone.ts collectNotePaths)。
 *
 * per-branch try/catch:某个子目录被 Defender 瞬态锁住时只丢这一支,
 * 兄弟目录与父级照常收集(整树扫描半途挂掉 = 用户看到「文献全空」)。
 */
// audit-r215:dirsOut 可选 —— reload 的 emit 指纹需要「目录集」参与
//   (空文件夹的增删不改变任何文件行,只看文件行的指纹会把目录结构变化
//   判成「没变」而不 emit)。收集的口径与遍历口径一致:symlink/junction
//   目录跳过(树里也不显示)。
async function collectLiteratureFiles(
  dir: string,
  out: string[],
  depth: number,
  dirsOut?: string[],
  // perf r254:扫描期顺手带出每个文件的 stat 信息 —— 复用同一次 lstat 的
  //   mtimeMs / size,给后续的「刷 stat」轮省掉一整遍 fs.stat。
  //   为什么可以复用:这里的 lstat 只作用在**普通文件**上(Dirent.isFile()
  //   对 symlink 返 false ⇒ symlink 文件根本进不来;进了分支的还额外用
  //   st.isSymbolicLink() 挡掉「readdir→stat 之间被换成 symlink」的
  //   race)。对普通文件,lstat 与 stat 指向**同一个 inode** ⇒ mtimeMs /
  //   size 逐字相同 ⇒ 用 lstat 的值替代 stat 的值不改变任何语义。
  statsOut?: Map<string, LitDiskStat>,
): Promise<void> {
  if (depth > MAX_LITERATURE_SCAN_DEPTH) return;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err: unknown) {
    log.warn('Cannot read literature dir', dir, errMsg(err));
    return;
  }
  const subdirs: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // symlink / junction 目录跳过 —— 跟进去可能成环(notes/loop → ../notes)
      if (entry.isSymbolicLink()) continue;
      subdirs.push(full);
      dirsOut?.push(full);
    } else if (entry.isFile()) {
      // Dirent.isFile() 对 symlink 返 false(readdir 不 follow)→ symlink
      // 文件天然被排除;再补一次 lstat 防 readdir→stat 之间的替换 race。
      // perf r254:这次 lstat 的结果**留下来复用**(mtimeMs / size)——
      //   旧实现在这里把 st 丢掉,随后 refreshDiskStats 再对每个文件
      //   fs.stat 一遍(实测 2000 篇 = 扫描 40ms + 二次 stat 35ms)。
      let st: Stats;
      try {
        st = await fs.lstat(full);
      } catch (err: unknown) {
        log.warn('lstat failed during literature scan', full, errMsg(err));
        continue;
      }
      if (st.isSymbolicLink()) continue;
      statsOut?.set(full, { mtimeMs: st.mtimeMs, size: st.size });
      out.push(full);
    }
  }
  await Promise.all(
    subdirs.map((sub) =>
      collectLiteratureFiles(sub, out, depth + 1, dirsOut, statsOut).catch((err: unknown) => {
        log.warn('collectLiteratureFiles branch failed', sub, errMsg(err));
      }),
    ),
  );
}

/**
 * 目标目录 relPath 段校验 —— 单文件搬移(moveFile)与目录搬移(moveDir)
 * 共用一份规则,避免两处漂移。
 *
 * 合法形态:''
 *   (根)/'foo'/'foo/bar'。拒收:含 '..' / 绝对路径 / 空段 / 以 '.' 开头的段。
 */
/**
 * r186:relPath 校验委托 shared/rel-path.ts —— 本函数原先是**第三份**手写
 *   规则(与 notes/standalone.ts 的那份逐字节相同,与 ipc/folders.ts 的那份
 *   不一致)。三份规则对同一串给出不同答案,用户能碰到:侧栏建不出 / 进不去
 *   的夹,笔记却搬得进去。详见 shared/rel-path.ts 头注。
 *
 * 错误类型保持 LibraryError(与本文件其余错误一致),只换判定来源。
 */
export function assertLitTargetRelPath(targetRelPath: string, label: string): void {
  const problem = validateRelPath(targetRelPath, { allowRoot: true });
  if (problem) {
    throw new LibraryError('VALIDATION', `${label}: targetRelPath ${problem.message}`);
  }
}

/**
 * audit-r175:文献文件夹**改名**(basename 变,父目录不变)—— fs.rename
 * 整棵子树,返回新目录 relPath。
 *
 * 与 moveLitDir 的差别:那边的新 relPath 由
 * `targetRelPath + '/' + basename` 推导(搬移语义),这边由 caller 直接给
 * (改名语义 —— 名字本身要变)。
 *
 * 物理搬家这一层与 moveLitDir 同款(目标存在 → 提前拒;越界 → 拒);
 * id 重算同样不在这里做 —— 目录里每个文献行的 id 都随 absPath 变,
 * 需要 byId 索引 + DB 同步配合,由 service.renameDir 逐个处理。
 */
async function renameLitDir(
  litDir: string,
  oldRelPath: string,
  newRelPath: string,
): Promise<string> {
  if (newRelPath === oldRelPath) {
    // 同名 → no-op(大小写不同的改名仍会走到下面,因为字符串比较区分大小写)
    return oldRelPath;
  }
  if (newRelPath.startsWith(`${oldRelPath}/`)) {
    throw new LibraryError(
      'VALIDATION',
      'renameDir: cannot rename a folder into its own subtree',
    );
  }
  const oldAbs = join(litDir, oldRelPath);
  const newAbs = join(litDir, newRelPath);
  if (!toPosix(newAbs).startsWith(toPosix(litDir) + '/')) {
    throw new LibraryError(
      'VALIDATION',
      `renameDir: new path "${newRelPath}" escapes literature root`,
    );
  }
  await fs.mkdir(dirname(newAbs), { recursive: true });
  // 目标已存在 → 提前拒(POSIX 上目录 rename 会把**空**目标目录静默替换掉)
  const targetExists = await fs.lstat(newAbs).then(
    () => true,
    () => false,
  );
  if (targetExists) {
    throw new LibraryError(
      'VALIDATION',
      tr('literature.moveTargetExists', { name: newRelPath.split('/').pop() ?? newRelPath }),
    );
  }
  try {
    // r175:退避重试(Windows 瞬时占用 / chokidar 持句柄 → EPERM;
    //   本机实证:子文件被打开时 rename 父目录 → EPERM,句柄释放后成功)
    await retryOnWindowsTransient(
      () => fs.rename(oldAbs, newAbs),
      () => Promise.resolve(),
    );
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT') {
      throw new LibraryError('NOT_FOUND', tr('literature.notFound', { id: oldRelPath }));
    }
    if (code === 'EEXIST' || code === 'ENOTEMPTY') {
      throw new LibraryError(
        'VALIDATION',
        tr('literature.moveTargetExists', { name: newRelPath.split('/').pop() ?? newRelPath }),
      );
    }
    throw new LibraryError(
      'IO_ERROR',
      tr('literature.moveFailed', {
        name: newRelPath.split('/').pop() ?? newRelPath,
        reason: errMsg(err),
      }),
    );
  }
  return newRelPath;
}

/**
 * audit-r173:目录(子树)搬移 —— fs.rename 整棵子树,返回新目录 relPath。
 *
 * 与 moveFile(单文件)的差异:搬的是目录(非 .md / 非文献的文件也一起
 * 带走,不静默丢弃用户文件)。id 重算不在这里做 —— 目录里每个文献行的
 * id 都随 absPath 变,需要 byId 索引 + DB 同步配合,由 service.moveDir
 * 逐个处理。
 */
async function moveLitDir(
  litDir: string,
  oldRelPath: string,
  targetRelPath: string,
): Promise<string> {
  assertLitTargetRelPath(targetRelPath, 'moveDir');
  const basename = oldRelPath.split('/').pop()!;
  if (!basename) {
    throw new LibraryError('VALIDATION', 'moveDir: oldRelPath has no basename');
  }
  const newRelPath = targetRelPath ? `${targetRelPath}/${basename}` : basename;
  if (newRelPath === oldRelPath) {
    // 同位置 → no-op
    return oldRelPath;
  }
  if (newRelPath.startsWith(`${oldRelPath}/`)) {
    throw new LibraryError(
      'VALIDATION',
      'moveDir: cannot move a folder into its own subtree',
    );
  }
  const oldAbs = join(litDir, oldRelPath);
  const newAbs = join(litDir, newRelPath);
  // 越界防御(允许 litDir 子树内任意位置)
  if (!toPosix(newAbs).startsWith(toPosix(litDir) + '/')) {
    throw new LibraryError(
      'VALIDATION',
      `moveDir: new path "${newRelPath}" escapes literature root`,
    );
  }
  // 父目录自动创建
  await fs.mkdir(dirname(newAbs), { recursive: true });
  // audit-r175 (2026-10-19) —— 目标已存在必须**提前拦下**。
  //   旧实现假设「fs.rename 目标已存在 → EEXIST」,并据此翻译
  //   VALIDATION。文件级 rename **从不**返回 EEXIST —— Windows libuv 走
  //   MoveFileExW(MOVEFILE_REPLACE_EXISTING),POSIX 是 rename(2),两者都
  //   **静默替换**已存在的目标文件。后果:把根目录的 x.pdf 拖进 A/(A 里
  //   已有 x.pdf)→ A/x.pdf 的旧内容被直接销毁,源文件也消失,无报错、
  //   无 toast、UI 显示成功。真实数据丢失路径,必须自己预检。
  const targetExists = await fs.lstat(newAbs).then(
    () => true,
    () => false,
  );
  if (targetExists) {
    throw new LibraryError('VALIDATION', tr('literature.moveTargetExists', { name: basename }));
  }
  try {
    // r175:退避重试(Windows 瞬时占用 / chokidar 持句柄 → EPERM;
    //   本机实证:子文件被打开时 rename 父目录 → EPERM,句柄释放后成功)
    await retryOnWindowsTransient(
      () => fs.rename(oldAbs, newAbs),
      () => Promise.resolve(),
    );
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT') {
      throw new LibraryError('NOT_FOUND', tr('literature.notFound', { id: oldRelPath }));
    }
    if (code === 'EEXIST' || code === 'ENOTEMPTY') {
      throw new LibraryError(
        'VALIDATION',
        tr('literature.moveTargetExists', { name: basename }),
      );
    }
    throw new LibraryError(
      'IO_ERROR',
      tr('literature.moveFailed', { name: basename, reason: errMsg(err) }),
    );
  }
  return newRelPath;
}

export class LiteratureService extends EventEmitter {
  private byId = new Map<ResourceId, LiteratureResource>();
  private watcher: FSWatcher | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private started = false;
  // audit-r136:与 notes 同款 watcher 自动重启状态机 —— 旧 watcher 异步
  //   'error' 只 log 不重建,this.watcher 仍指死实例,事件流静默断;修法
  //   2s 退避重启 + 上限防 log 风暴 + stop() 清 timer。
  private watcherRestartTimer: NodeJS.Timeout | null = null;
  private watcherRestartAttempts = 0;
  // r197:健康期计时器(与 notes 同款)—— 重启后一段时间内不再报错 ⇒
  //   连续失败计数清零(详见 scheduleWatcherRestart)
  private watcherHealthTimer: NodeJS.Timeout | null = null;
  private writeLock = new WriteLock();
  // audit-r162 H1:60s 周期 resync timer,start 启 / stop 清。fire-after-stop
  //   守卫:已 started=false 守卫防 byId 重建(同 reloadTimer 模式)。
  private resyncTimer: NodeJS.Timeout | null = null;
  // audit-r136 M1:emit('changed') 幂等保护 —— chokidar 触发的 reload
  //   可能因外部 change / disk file mtime 不变(no-op 写)而 byId 内容
  //   没变,但仍 emit → renderer load() 走全量拉(IPC roundtrip + set
  //   items = [...同数组])。防:reload 收尾算一次指纹(byId 内容没变就
  //   不 emit)。初始 null —— 第一次 reload 必 emit 触发首推。
  // perf r257:指纹的**表示**从「一根大字符串」换成「每行状态 Map」——
  //   旧实现每次 reload 要把 N 行拼成 N 个 `${id}|${mtime}|${size}`
  //   字符串 + 排序 + join(lit id 是**绝对路径**,平均 108 字符 ⇒ 每轮
  //   额外分配 ≈ 250KB 字符串;实测 ≈ 0.8ms/2000 行,纯主线程 CPU);
  //   新实现只做 O(n) 逐项比对(≈ 0.13ms)。判定语义**一字不改**
  //   (见 sameLitState 头注)。
  private lastEmitRows: Map<ResourceId, { mtime: number; size: number }> | null = null;
  //   目录维度(r215)独立存:空文件夹增删不改任何文件行。
  private lastEmitDirs = '';

  async start(opts: { skipInitialLoad?: boolean } = {}): Promise<void> {
    if (this.started) return;
    try {
      const litDir = join(getRootPath(), WORKSPACE_DATA_LAYOUT.LITERATURE_DIR);
      await fs.mkdir(litDir, { recursive: true });
    } catch (err: unknown) {
      // audit-r136 H4:不再 throw + dialog —— mkdir recursive 在以下场景
      //   会失败,但都不是「应用不能继续」的硬错:
      //     - 父目录被 Defender 瞬态锁(EPERM/EBUSY,retry 后大多自愈)
      //     - 用户从旧版本升级,旧 dataPath 内已有 literature 目录但
      //       当前进程对路径暂时无写权(EACCES,可能 session boundary)
      //     - 云盘客户端(OneDrive/Dropbox/iCloud)的 reparse point
      //       还没解析完(EROFS/EACCES)
      //   旧 throw 路径把「文献面板空白」升级成 showErrorBox 弹窗,
      //   其它面板(favorites / notes)仍可用,体验割裂。降级为 warn +
      //   return:chokidar.watch 拿非存在路径会立即 emit 'error' →
      //   走 scheduleWatcherRestart(2s 后重建) → watcher restart 5 次
      //   失败后由 'watcher-failed' 事件 → index.ts 推 toast 告诉用户
      //   「文献监听失败」。导入路径(importLiteratureFile)写失败会
      //   在用户主动操作时即时返回 IO_ERROR,不需要提前 fail-loud。
      //   注意:started 必须仍置 true(下面),让 watcher 重启 + 后续
      //   reload 路径合法;若 mkdir 永久失败,restart 上限后 toast
      //   兜底。
      log.warn('Failed to ensure literature dir (continuing; watcher will retry)', errMsg(err));
    }
    // started=true 必须先置再调 reload() —— 理由同 notes/service.ts:88
    this.started = true;
    if (!opts.skipInitialLoad) {
      await this.reload();
    }
    this.watcherRestartAttempts = 0;
    this.startWatcher();
    this.startResyncTimer();
  }

  /** 建立 literature 目录的 chokidar watcher —— start() 与自动重启共用 */
  private startWatcher(): void {
    try {
      const litDir = join(getRootPath(), WORKSPACE_DATA_LAYOUT.LITERATURE_DIR);
      const w = chokidar.watch(litDir, {
        ignoreInitial: true,
        // audit-r136:stabilityThreshold 200(notes 50ms 太短,500MB PDF 拷贝
        //   中途触发 change → stat 拿到 partial size → upsert 错位)
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
        depth: MAX_LITERATURE_WATCH_DEPTH,
      });
      this.watcher = w;
      const schedule = () => this.scheduleReload();
      w.on('add', schedule);
      w.on('change', schedule);
      w.on('unlink', schedule);
      // audit-r215:目录**结构**变化也要触发 reload(与 notes 域 r184 同口径
      //   —— 又是「孪生实现漏一边」:notes 在 r184 补了 addDir/unlinkDir,
      //   literature 漏了)。只监听文件级事件时,用户在资源管理器里
      //   **建/删/改一个空文件夹**主进程一个事件都收不到 ⇒ 左侧栏文件夹树
      //   与磁盘永久对不上(外部建的夹不出现、外部删的夹还在),要等下次启动。
      //   ⚠ 光接事件不够:reload 的 emit 指纹(r136 M1)原来只看**文件行**
      //   ⇒ 空文件夹增删不改变任何文件行 ⇒ 指纹恒定 ⇒ 不 emit ⇒ 树照样
      //   不刷新。目录集必须进指纹(见 reload 尾部 diskDirs 段)。
      w.on('addDir', schedule);
      w.on('unlinkDir', schedule);
      w.on('error', (err: unknown) => {
        // 不再裸 emit('error'):无 listener 时抛 unhandledError 同步崩主进程
        log.warn('Literature watcher error', errMsg(err));
        if (this.listenerCount('error') > 0) {
          this.emit('error', err);
        }
        // 闭包 w(不是 this.watcher)判断「自己是否已被替换」,避免旧实例
        // 迟到 error 误伤新 watcher(notes 同款死实例复活 bug,audit-r124
        // 修过)。
        if (this.watcher === w) {
          // 重启前必须先关掉+摘监听 —— 同 notes/service.ts:120
          w.removeAllListeners();
          // closeWatcherQuietly(r216):裸 close 后晚到的 awaitWriteFinish
          // 轮询 stat 报错(Windows EPERM)⇒ emit('error') 无监听者 ⇒ 同步 throw
          void closeWatcherQuietly(w).catch((closeErr: unknown) =>
            log.warn('Literature watcher close during restart threw', errMsg(closeErr)),
          );
          this.watcher = null;
          this.scheduleWatcherRestart(err);
        }
      });
    } catch (err: unknown) {
      log.warn('Failed to start literature watcher (scheduling restart)', errMsg(err));
      this.watcher = null;
      this.scheduleWatcherRestart(err);
    }
  }

  /**
   * r188:物理搬动**目录**前临时释放 chokidar 的目录句柄,搬完重建。
   *
   * 根因见 utils/watcher-release.ts 的头注:chokidar 对每个被监听的目录
   *   持一个 OS 句柄,而 Windows 拒绝重命名「内部存在打开句柄」的目录
   *   ⇒ 含子目录的文件夹**改名 / 搬移必 EPERM**(notes 与 literature
   *   两侧同病)。退避重试救不了(句柄是长期的,不是瞬时占用)。
   */
  private async withWatcherReleased<T>(fn: () => Promise<T>): Promise<T> {
    return withWatcherReleased(
      {
        get: () => this.watcher,
        clear: () => {
          this.watcher = null;
        },
        // 服务已 stop(退出期)时不重建 —— 否则 stop 之后又拉起一个 watcher,
        // 拖住 event loop 不退出
        restart: () => {
          if (this.started) this.startWatcher();
        },
      },
      fn,
    );
  }

  /**
   * 排一次 watcher 重启(2s 退避),超上限放弃并 emit 'watcher-failed'。
   * 重启成功后 reload() 补回死亡窗口漏的外部增删改(目录级 scan,轻)
   */
  private scheduleWatcherRestart(cause: unknown): void {
    if (!this.started) return;
    if (this.watcherRestartTimer) return;
    // r197:刚又报错 ⇒ 上一次的「健康期」判定作废(健康期计时器必须撤,
    //   否则它会在 30s 后把计数清零,而 watcher 其实一直坏着 —— 计数清零
    //   ⇒ 2s 退避变成无限重试,正是本上限要防的 log 风暴)。
    if (this.watcherHealthTimer) {
      clearTimeout(this.watcherHealthTimer);
      this.watcherHealthTimer = null;
    }
    if (this.watcherRestartAttempts >= MAX_LITERATURE_AUTO_RESTARTS) {
      log.error('Literature watcher restart limit reached — giving up until next app start', {
        attempts: this.watcherRestartAttempts,
      });
      this.emit('watcher-failed', cause);
      return;
    }
    this.watcherRestartAttempts++;
    this.watcherRestartTimer = setTimeout(() => {
      this.watcherRestartTimer = null;
      if (!this.started) return;
      log.info('Restarting literature watcher', { attempt: this.watcherRestartAttempts });
      this.startWatcher();
      // r197:重启成功 ⇒ 排「健康期」计时器,健康期内不再报错 ⇒ 计数清零。
      //   旧实现只在 start()/stop() 清计数,于是「连续失败上限」实际是**终身**
      //   预算:一次长会话里攒够 5 次瞬时 watcher 错误就把 watcher 永久放弃
      //   —— 之后所有外部改动都不再被感知(用户看到「改了文件,应用不更新」,
      //   没有任何报错提示)。计数清零必须延后到健康期结束,不能在
      //   startWatcher() 之后立刻清:watcher 起来后马上再 error 的话,
      //   计数归零 ⇒ 无限重试。
      this.watcherHealthTimer = setTimeout(() => {
        this.watcherHealthTimer = null;
        if (!this.started) return;
        this.watcherRestartAttempts = 0;
      }, LITERATURE_WATCHER_HEALTHY_MS);
      void this.reload().catch((err: unknown) => {
        log.warn('Literature reload after watcher restart failed', errMsg(err));
      });
    }, LITERATURE_WATCHER_RESTART_DELAY_MS);
  }

  /** 显式触发一次全量重扫 */
  async load(): Promise<void> {
    await this.reload();
  }

  async stop(): Promise<void> {
    // 同 notes/service.ts:178 — 先标 started=false 防 timer fire-after-stop
    // 重建 byId。
    this.started = false;
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    if (this.watcherRestartTimer) {
      clearTimeout(this.watcherRestartTimer);
      this.watcherRestartTimer = null;
    }
    // r197:健康期计时器也要清 —— 它持 30s 句柄,拖 event loop 阻退出
    if (this.watcherHealthTimer) {
      clearTimeout(this.watcherHealthTimer);
      this.watcherHealthTimer = null;
    }
    this.watcherRestartAttempts = 0;
    if (this.resyncTimer) {
      clearInterval(this.resyncTimer);
      this.resyncTimer = null;
    }
    if (this.watcher) {
      try {
        // closeWatcherQuietly(r216):同 notes stop() —— 退出期晚到的
        // awaitWriteFinish 轮询错误不能变成 uncaught exception
        await closeWatcherQuietly(this.watcher);
      } catch (err: unknown) {
        log.warn('Literature watcher close failed during shutdown', errMsg(err));
      }
      this.watcher = null;
    }
    // 先等 in-flight writeLock 结束再清 byId —— 避免 stop() 之后的写入落
    // 到内存被清空(同 notes/service.ts:202)。
    await this.writeLock.drain();
    this.byId.clear();
  }

  /** 全量列表(mtime 倒序)—— IPC handler 直返此结构 */
  list(): LiteratureResource[] {
    return Array.from(this.byId.values()).sort((a, b) => b.mtime - a.mtime);
  }

  findById(id: string): LiteratureResource | null {
    return this.byId.get(id as ResourceId) ?? null;
  }

  /**
   * audit-r160:删除一条文献 —— 走 writeLock 串行化(防与 reload 互踩),
   *   顺序:移文件进系统回收站 → deleteResource(持久层)→ byId.delete(内存索引)。
   *   删完 emit('changed') 触发 renderer 重新拉取,与 import 走同一通道。
   *   旧 IPC handler 直调 removeLiteratureFile + deleteResource,绕开 writeLock
   *   —— chokidar 'unlink' 触发 scheduleReload + reload 走 ~50ms 间,LITERATURE_LIST
   *   走 byId 返回已删文件,UI 短暂闪老条目。
   * audit-r175:文件删除从 fs.unlink(硬删,不可恢复)改成 safeTrash(系统回收站),
   *   与笔记域一致 —— 文献往往是用户手里唯一一份 PDF,误删必须可找回。
   * @throws LibraryError(NOT_FOUND):byId 找不到此 id(IPC handler 已先 requireString)
   */
  async remove(id: ResourceId): Promise<void> {
    await this.writeLock.run(async () => {
      const r = this.byId.get(id);
      if (!r) {
        throw new LibraryError('NOT_FOUND', tr('literature.notFound', { id }));
      }
      // 1. 移文件进系统回收站(ENOENT 容忍,目标已达成)
      await removeLiteratureFile(r.absPath, getRootPath());
      // 2. DB 删行(必须在文件删除之后,反过来删行而文件移不走会留 orphan)
      deleteResource(id);
      // 3. 内存索引 byId 清 entry
      this.byId.delete(id);
    });
    this.emit('changed');
  }

  /**
   * 导入一个外部文件到 literature 根目录 —— 文件拷贝 + DB 行 + 内存索引三件套。
   *
   * audit-r170:旧实现在 IPC handler 里直调 importLiteratureFile + upsertResource,
   *   **没更新 svc.byId** —— 导入后紧跟的 svc.moveFile(id, target) 走
   *   byId.get(id) 必 miss → NOT_FOUND。后果:「复制粘贴进文件夹」与
   *   「OS 拖文件进文件夹」两条路径的搬移全部失败,文件停在 literature 根
   *   (用户看到「导入成功、但没进文件夹」,而 UI 又只在根目录列得出文献行
   *   —— 文献行没有 relPath,子目录里的行在侧栏永远不显示)。
   *   修法:导入收进 service,DB 行与 byId 在同一次 writeLock 内落地,
   *   搬移立刻可见(与 remove / moveFile 同一形态)。
   *
   * importLiteratureFile 落的是 literature **根**(无 target 参数,主进程
   *   侧导入不带目录语义),要进子目录由 caller 紧接着调 moveFile。
   */
  async importFile(sourcePath: string): Promise<LiteratureImportResult> {
    const root = getRootPath();
    const imported = await importLiteratureFile(sourcePath, root);
    // lit 行的 rel_path 在 repo 层退化为 absPath 本身(0004 列 NOT NULL 兜底),
    // root 概念 R63 未落地),id = litResourceId(absPath) 与 0005 迁移行
    // 'lit:'+旧rel 两套后缀形态互斥不碰撞。
    // indexedAt=0 + extractStatus 'filename-only':FTS body 未填,只有 title
    // 可搜 —— 与迁移行语义一致,诚实标注。
    const row: LiteratureResource = {
      id: imported.id,
      kind: 'literature',
      title: basename(imported.absPath, extname(imported.absPath)),
      mtime: imported.mtime,
      size: imported.size,
      indexedAt: 0,
      absPath: imported.absPath,
      // audit-r172:导入落在 literature 根 → 归属是文件名本身。
      relPath: litRelPathOf(join(root, WORKSPACE_DATA_LAYOUT.LITERATURE_DIR), imported.absPath),
      rootId: null,
      extractStatus: 'filename-only',
    };
    // audit-r243(2026-10-21):DB 写失败 ⇒ **回收刚拷进来的文件**。
    //   拷贝在 writeLock **之外**先落盘(importLiteratureFile),DB 行在锁内
    //   写。旧实现:DB 写失败(SQLITE_BUSY / 磁盘满)⇒ 抛错给用户,那份
    //   **已经拷进 literature/ 的文件**却留在盘上,既没有 DB 行也没有
    //   byId 条目 ⇒ 用户重试一次 → 多出「name (1).ext」,列表里出现
    //   一堆「导入了但搜不到、也不在收藏里」的孤儿文件。
    //   修法:DB 写失败就把那份拷贝删掉(回滚到「没导过」的状态);
    //   用户重试得到干净的一次导入,不会留下重复文件。
    //   注意:删的是**这一份刚拷出来的** absPath,不是用户原有文件。
    try {
      await this.writeLock.run(async () => {
        upsertResource(
          row as unknown as Parameters<typeof upsertResource>[0],
          '',
          row.absPath,
        );
        // 内存索引同步 —— 这是 r170 的关键:byId 缺这一行,紧跟的 moveFile
        // 必然 NOT_FOUND。
        this.byId.set(row.id, row);
      });
    } catch (err: unknown) {
      await fs.rm(imported.absPath, { force: true }).catch(() => {
        /* 回滚失败:残留文件会被 reload 收进索引(用户手动删即可),
           不为此把导入改判成「成功」—— 错误照常抛给用户 */
      });
      throw err;
    }
    this.emit('changed');
    return imported;
  }

  // r161+ disk-folder Phase 2b:跨文件夹移动文献。结构与 remove 同款
  //   (writeLock 串行化),差异:不删行,改 unlink → fs.rename,DB 走
  //   deleteResource(旧 id) + upsertResource(新 id) —— lit id 是
  //   'lit:'+toPosix(absPath),跨级移动 absPath 变 → id 必变。
  //
  // 时序不变量(承 r155 H1 / r151 配方):disk rename → DB tx(双:旧删 + 新
  //   增,同 transaction 由 resources-repo 承担)→ emit('changed') 触发
  //   scheduleReload → byId 重建把新 id 行入索引。失败 throw IO_ERROR +
  //   byId 保持原状,chokidar 'unlink'(old) + 'add'(new) 在 writeLock
  //   释放后排队 → scheduleReload → reload 走 disk↔DB diff 自愈。
  //
  // targetRelPath 是「目标目录」相对路径('' = 根 / 'foo' / 'foo/bar'),
  //   不含文件名;newAbsPath 自动拼
  //   `<rootPath>/literature/${targetRelPath}/${basename(oldAbsPath)}`。
  async moveFile(
    id: ResourceId,
    targetRelPath: string,
  ): Promise<{ absPath: string; id: ResourceId }> {
    return this.writeLock.run(async () => {
      const r = this.byId.get(id);
      if (!r) {
        throw new LibraryError('NOT_FOUND', tr('literature.notFound', { id }));
      }
      // 段校验(同 notes 范式,纯函数,无 IPC 通道依赖;r173 与 moveDir 共用)
      assertLitTargetRelPath(targetRelPath, 'moveFile');
      const root = getRootPath();
      const litDir = join(root, WORKSPACE_DATA_LAYOUT.LITERATURE_DIR);
      const oldAbs = r.absPath;
      // r197:用 path.basename 取文件名 —— 旧实现 `oldAbs.split(/[\\/]/).pop()!`
      //   有两个坑:(a) `!` 掩盖了 pop() 可能返回 undefined;(b) 路径以分隔符
      //   结尾时 pop() 得到空串 ⇒ 目标路径退化成「目标目录本身」⇒
      //   后续 mkdir 建目录、rename 把文件搬进它自己所在的目录。
      //   path.basename 对两种分隔符都正确,且不会返回空串。
      const fileName = basename(oldAbs);
      const newRelAbs = targetRelPath
        ? join(litDir, targetRelPath, fileName)
        : join(litDir, fileName);
      const newAbs = toPosix(newRelAbs);
      // 同位置 → no-op
      if (newAbs === toPosix(oldAbs)) {
        return { absPath: oldAbs, id };
      }
      // 越界防御(允许 litDir 子树内任意位置)
      if (!newAbs.startsWith(toPosix(litDir) + '/')) {
        throw new LibraryError(
          'VALIDATION',
          `moveFile: new absPath "${newAbs}" escapes literature root`,
        );
      }
      // 父目录自动创建
      // r197:用 path.dirname 取父目录 —— 旧实现是正则 `replace(/[\\/][^\\/]+$/, '')`,
      //   语义脆弱(只替换第一个匹配;路径含换行等特殊字符时行为未定义)。
      //   path.dirname 对 POSIX / Win32 两种形态都给出同形态的父目录。
      await fs.mkdir(dirname(newAbs), { recursive: true });
      // r175:目标已存在 → 提前拦下(**不覆盖**)。
      //   fs.rename 在目标已存在时**从不**抛 EEXIST —— Windows libuv 走
      //   MoveFileExW(MOVEFILE_REPLACE_EXISTING),POSIX 是 rename(2),两者
      //   都静默替换目标文件。旧代码「靠 EEXIST 拦下」的注释与实现都不
      //   成立:把 x.pdf 拖进已有 x.pdf 的目录 → 目标被静默销毁(数据丢失),
      //   UI 还显示搬移成功。现在先 lstat 预检,存在即 VALIDATION。
      const targetExists = await fs.lstat(newAbs).then(
        () => true,
        () => false,
      );
      if (targetExists) {
        throw new LibraryError(
          'VALIDATION',
          tr('literature.moveTargetExists', { name: fileName }),
        );
      }
      // fs.rename:目标已存在 → EEXIST,翻译 VALIDATION(不抛 IO_ERROR 误导)
      try {
        // r175:退避重试(Windows 瞬时占用 / chokidar 持句柄 → EPERM;
        //   本机实证:子文件被打开时 rename 父目录 → EPERM,句柄释放后成功)
        await retryOnWindowsTransient(
          () => fs.rename(oldAbs, newAbs),
          () => Promise.resolve(),
        );
      } catch (err: unknown) {
        const code = (err as { code?: string }).code;
        if (code === 'ENOENT') {
          throw new LibraryError('NOT_FOUND', tr('literature.notFound', { id }));
        }
        if (code === 'EEXIST' || code === 'ENOTEMPTY') {
          throw new LibraryError(
            'VALIDATION',
            tr('literature.moveTargetExists', { name: fileName }),
          );
        }
        throw new LibraryError(
          'IO_ERROR',
          tr('literature.moveFailed', { name: fileName, reason: errMsg(err) }),
        );
      }
      // DB 同步:旧 id 行 + 新 id 行必须**同事务**。
      //   r196:旧实现是 `deleteResource(旧 id)` + `upsertResource(新行)`
      //   —— 两个**独立事务**。中间任何失败(DB 忙 / 磁盘满 / FTS 报错 /
      //   进程被杀)都会留下「DB 里这行没了、磁盘上文件还在、byId 还指着
      //   旧 id」的三态漂移 ⇒ 这条文献从列表和搜索里**凭空消失**,而磁盘
      //   没动 ⇒ **没有任何 watcher 事件能触发自愈**,要等下次启动 resync
      //   差集才回来。旧注释「先删后增,避免 FTS 侧同内容行撞唯一约束」
      //   也不成立:resources_fts 是**普通 standalone FTS5 表**
      //   (migrations/0004_resources.sql 头注),除了隐式 rowid 没有任何
      //   唯一约束,不存在「同内容行」冲突。
      //   renameResource 正是「upsert 新行 + 删旧行」的**单事务**版本
      //   (笔记侧一直用它),改用它 ⇒ 两侧事务语义一致 + 失败自动回滚。
      const newId = litResourceId(toPosix(newAbs));
      const newResource: LiteratureResource = {
        ...r,
        id: newId,
        absPath: newAbs,
        // audit-r172:搬进子目录后归属变了 —— relPath 必须跟着更新,否则
        //   renderer 仍把它算在旧目录(粘贴进文件夹后文件「还在原地」的
        //   直接原因之一)。
        relPath: litRelPathOf(litDir, newAbs),
        // r175:搬移**不改**文件 mtime(rename 不碰内容)—— 旧实现写
        //   Date.now(),把「2 小时前」变成「刚刚」,还因为列表按 mtime 倒序
        //   而让这条文献跳到顶部;DB 里的 mtime 永久错(reload 只信 DB 的值,
        //   不会用文件真实 mtime 修正)。保留原 mtime。
        mtime: r.mtime,
      };
      // body 字段不适用(literature 无正文),走空串占位
      renameResource(r.id, newResource, '', newAbs);
      // byId 立刻更新(不等 chokidar);后续 scheduleReload 重建的 next
      //   会以新 id 形态入 byId,内容一致无副作用
      this.byId.delete(id);
      this.byId.set(newId, newResource);
      this.emit('changed');
      return { absPath: newAbs, id: newId };
    });
  }

  /**
   * r187:文献**单文件**重命名 —— 只改文件名,保留所在目录。
   *
   * 场景:左侧文献列表右键「重命名」—— 此前 literature 域根本没有这条
   *   通道(只有 notes 有 notes:rename-file),两侧操作集不对应:笔记能改名,
   *   文献不能(用户只能在资源管理器里改,改完 app 里还是旧名直到手动刷新)。
   *
   * 与 moveFile 同构:fs.rename → id 变(lit id = 'lit:'+posix absPath)
   *   → deleteResource(旧 id) + upsertResource(新行) → byId 换键。
   *   区别只在「目标路径 = 原目录 + 新文件名」(不换目录)。
   *
   * 时序不变量(同 moveFile):disk rename → DB 同步 → byId mutation 三步
   *   全在 writeLock 内;失败 throw 且 byId 保持原状,chokidar 事件触发
   *   的 reload 自愈。
   *
   * 目标已存在 ⇒ VALIDATION,**不覆盖**(Windows fs.rename 静默替换目标)。
   */
  async renameFile(
    id: ResourceId,
    newFilename: string,
  ): Promise<{ absPath: string; oldAbsPath: string; id: ResourceId }> {
    return this.writeLock.run(async () => {
      const r = this.byId.get(id);
      if (!r) {
        throw new LibraryError('NOT_FOUND', tr('literature.notFound', { id }));
      }
      // 校验 + 拼路径(纯函数,不碰磁盘)
      const plan = planLiteratureRename(r.absPath, newFilename);
      if (plan.newAbs === r.absPath) {
        // 完全同名 → no-op,id 不变
        return { absPath: r.absPath, oldAbsPath: r.absPath, id };
      }
      // 落盘(预检目标不存在 + fs.rename)
      await performLiteratureRename(plan);
      const root = getRootPath();
      const litDir = join(root, WORKSPACE_DATA_LAYOUT.LITERATURE_DIR);
      const newId = litResourceId(toPosix(plan.newAbs));
      // DB 同步:旧 id 行 + 新 id 行**同事务**(upsert 新行 + 删旧行)。
      //   r196:旧实现是 deleteResource + upsertResource 两个独立事务 ——
      //   中途失败 ⇒ 这条文献从列表/搜索里凭空消失且磁盘没动 ⇒ 无
      //   watcher 事件自愈(详见 moveFile 同款说明)。renameResource 是
      //   单事务版本(笔记侧一直用它)。
      const newRow: LiteratureResource = {
        ...r,
        id: newId,
        // title 跟着新文件名走 —— 列表虽然显示 filenameOf(absPath),
        //   但 title 进搜索 haystack,不同步会让「改名后搜旧名/新名」错位。
        title: basename(plan.newAbs, extname(plan.newAbs)),
        absPath: plan.newAbs,
        relPath: litRelPathOf(litDir, plan.newAbs),
        // r175:改名不改文件内容 —— 保留原 mtime / size(同 moveFile)。
        mtime: r.mtime,
        size: r.size,
      };
      renameResource(r.id, newRow, '', plan.newAbs);
      this.byId.delete(r.id);
      this.byId.set(newId, newRow);
      this.emit('changed');
      return { absPath: plan.newAbs, oldAbsPath: r.absPath, id: newId };
    });
  }

  /**
   * r173:跨父目录搬移整个文献文件夹(子树)。
   *
   * 场景:侧栏「剪切文件夹 → 粘贴到别的目录」「把文件夹拖到别的目录」
   *   「移到根目录」—— 此前全是 throw「not yet supported」的占位。
   *
   * 与 moveFile(单文件)同构:fs.rename 整棵子树 → 每个文件的 id 变
   *   (lit id = 'lit:'+toPosix(absPath),路径变 → id 变)→ 逐个
   *   deleteResource(旧 id) + upsertResource(新行) + byId 换键。
   *   返回 idRemap(oldId → newId)给 renderer 把选中态跟到新 id。
   *
   * 时序不变量(同 moveFile):disk rename → DB 同步 → byId mutation 三步
   *   全在 writeLock 内;失败 throw 且 byId 保持原状,chokidar 事件触发
   *   的 reload 自愈。
   */
  async moveDir(
    oldRelPath: string,
    targetRelPath: string,
  ): Promise<FolderMoveResult> {
    return this.writeLock.run(async () => {
      const root = getRootPath();
      const litDir = join(root, WORKSPACE_DATA_LAYOUT.LITERATURE_DIR);
      // 子树里的文献行(relPath 相对 literature 根,r172 起有值)——
      // 必须在 fs 搬家**之前**取快照(搬完之后 relPath 已是新路径)。
      const affected = this.subtreeRows(oldRelPath);
      const newRelPath = await this.withWatcherReleased(() =>
        moveLitDir(litDir, oldRelPath, targetRelPath),
      );
      if (newRelPath === oldRelPath) {
        // 同位置 → no-op,没有 id 变化
        return { relPath: newRelPath, idRemap: [] };
      }
      const idRemap = this.remapSubtreeRowsGuarded(affected, oldRelPath, newRelPath, litDir);
      this.emit('changed');
      return { relPath: newRelPath, idRemap };
    });
  }

  /**
   * r175:重命名文献文件夹(子树)—— 目录内每个文献的 id 都变
   *   (lit id = 'lit:'+toPosix(absPath),路径变 → id 变)⇒ 逐个
   *   deleteResource(旧 id) + upsertResource(新行) + byId 换键。
   *   返回 idRemap(oldId → newId)给 renderer 把选中态跟到新 id。
   *
   * 为什么必须走 service(而不是 IPC 层裸 fs.rename):
   *   旧实现(IPC 层 fs.rename)只搬目录 —— DB 的 rel_path / absPath 与
   *   磁盘脱节,byId 里那一堆旧 id 变成幽灵;renderer 手里的选中 id
   *   指向磁盘上已经不存在的路径 ⇒ 后续任何对该文献的操作 NOT_FOUND。
   *   文献 id 与路径强绑定(同 notes 的 fm.id),路径变 → id 必须跟着变。
   *
   * 时序不变量(同 moveDir):disk rename → DB 同步 → byId mutation 三步
   *   全在 writeLock 内;失败 throw 且 byId 保持原状,chokidar 事件触发
   *   的 reload 自愈。
   */
  async renameDir(
    oldRelPath: string,
    newRelPath: string,
  ): Promise<FolderMoveResult> {
    return this.writeLock.run(async () => {
      const root = getRootPath();
      const litDir = join(root, WORKSPACE_DATA_LAYOUT.LITERATURE_DIR);
      // 同 moveDir:先取子树快照,再动磁盘。
      const affected = this.subtreeRows(oldRelPath);
      const finalRelPath = await this.withWatcherReleased(() =>
        renameLitDir(litDir, oldRelPath, newRelPath),
      );
      if (finalRelPath === oldRelPath) {
        // 同名 → no-op,没有 id 变化
        return { relPath: finalRelPath, idRemap: [] };
      }
      const idRemap = this.remapSubtreeRowsGuarded(affected, oldRelPath, finalRelPath, litDir);
      this.emit('changed');
      return { relPath: finalRelPath, idRemap };
    });
  }

  /**
   * r196:子树里的文献行(relPath 相对 literature 根,r172 起有值)——
   * relPath 以 `oldRelPath/` 开头。
   */
  private subtreeRows(oldRelPath: string): LiteratureResource[] {
    const prefix = `${oldRelPath}/`;
    return Array.from(this.byId.values()).filter((r) => (r.relPath ?? '').startsWith(prefix));
  }

  /**
   * r196:子树 id 重映射 —— 目录搬移 / 改名后,子树里每个文献的 absPath 变了
   * ⇒ lit id(= 'lit:' + toPosix(absPath))全变 ⇒ 逐个:
   *   renameResource(旧 id → 新行,**同事务**) + byId 换键。
   *
   * moveDir / renameDir 共用这一份 —— 原来两个方法把这 20 行逐字抄了两遍,
   * 只差 log/注释;改一边漏另一边 = 「搬移改了 DB、改名没改」⇒ 子树里的
   * 文献 id 变成幽灵(renderer 手里全是死 id)。
   *
   * @param affected 搬家**之前**取好的子树快照(旧 relPath)
   */
  /**
   * remapSubtreeRows 的**带自愈**外壳(moveDir / renameDir 专用)。
   *
   * audit-r243(2026-10-21):这两处的方法头注释都写着「失败 throw 且 byId
   *   保持原状,chokidar 事件触发的 reload 自愈」—— 但**这个自愈事件不会来**:
   *   目录搬移 / 改名走 withWatcherReleased(Windows 上 chokidar 持目录句柄
   *   ⇒ 改名必 EPERM,见 utils/watcher-release.ts 头注),watcher 在
   *   fs.rename 期间是**关着的**,重启时又带 ignoreInitial: true ⇒ 搬移
   *   产生的 unlink / add 事件一个都收不到。
   *   ⇒ remapSubtreeRows 中途抛(SQLITE_BUSY / 磁盘满)时:磁盘已搬到新
   *     位置,DB 里一半行还是旧 absPath/id,byId 也停在旧键 —— 三态漂移
   *     且**没有自愈触发器**。60s 的 resyncExternal 只清 literature/ 之外的
   *     孤儿行,不会修这批(它们仍在 literature/ 里,只是路径错了)。
   *     用户看到的是:文献还在列表里(旧 id),点开 NOT_FOUND。
   *
   * 修法:失败时**显式**排一次 reload —— reload 按磁盘真值重建 byId 并做
   *   disk↔DB 差集(旧 id 行被清、新路径行被补),把漂移收回来。
   *   错误照常抛给用户(这次搬移确实失败了),只是不留三态漂移。
   */
  private remapSubtreeRowsGuarded(
    affected: LiteratureResource[],
    oldRelPath: string,
    newRelPath: string,
    litDir: string,
  ): FolderMoveResult['idRemap'] {
    try {
      return this.remapSubtreeRows(affected, oldRelPath, newRelPath, litDir);
    } catch (err: unknown) {
      log.error('subtree remap failed, scheduling self-heal reload', {
        oldRelPath,
        newRelPath,
        err: errMsg(err),
      });
      this.scheduleReload();
      throw err;
    }
  }

  private remapSubtreeRows(
    affected: LiteratureResource[],
    oldRelPath: string,
    newRelPath: string,
    litDir: string,
  ): FolderMoveResult['idRemap'] {
    const idRemap: FolderMoveResult['idRemap'] = [];
    for (const r of affected) {
      // 'a/b/x.pdf' 搬到 'x/a' → 'x/a/b/x.pdf'(保留目录内层级)
      const suffix = (r.relPath ?? '').slice(oldRelPath.length);
      const newAbs = toPosix(join(litDir, `${newRelPath}${suffix}`));
      const newId = litResourceId(newAbs);
      const newRow: LiteratureResource = {
        ...r,
        id: newId,
        absPath: newAbs,
        relPath: `${newRelPath}${suffix}`,
        // r175:改名/搬移都不改文件内容 —— 保留原 mtime(同 moveFile)。
        mtime: r.mtime,
      };
      // r196:单事务「upsert 新行 + 删旧行」(旧实现是 delete + upsert 两个
      //   独立事务,中途失败 ⇒ 这条文献从列表/搜索里凭空消失且无自愈事件)。
      renameResource(r.id, newRow, '', newAbs);
      this.byId.delete(r.id);
      this.byId.set(newId, newRow);
      idRemap.push({
        oldId: r.id,
        newId,
        relPath: newRow.relPath,
        absPath: newAbs,
      });
    }
    return idRemap;
  }

  private scheduleReload(): void {
    if (!this.started) return;
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      if (!this.started) return;
      this.reload().catch((err: unknown) => {
        log.warn('Reload failed', errMsg(err));
        if (this.listenerCount('reload-failed') > 0) {
          this.emit('reload-failed', err);
        }
      });
    }, RELOAD_DEBOUNCE_MS);
  }

  /**
   * 全量 reload:readdir litDir + 读 DB → 算 disk-only / db-only →
   * upsert filename-only 行 / deleteResource ghost 行 → byId = next →
   * emit('changed')。
   *
   * audit-r136:这是 literature 域 v2 区别 v1 的关键 —— v1 只在 import/delete
   *   写后 force 重拉(主进程不感知 OS 拖入 / 外部删),v2 加 disk↔DB diff
   *   让双向同步。
   */
  private async reload(): Promise<void> {
    if (!this.started) return;
    return this.writeLock.run(async () => {
      if (!this.started) return;
      const root = getRootPath();
      const litDir = join(root, WORKSPACE_DATA_LAYOUT.LITERATURE_DIR);
      await fs.mkdir(litDir, { recursive: true });

      // 1. 递归扫描 literature 子树:dot 隐藏 + symlink/junction + 非 file
      //    全部跳过;lstat 不 follow 防止 symlink 指向 root 外大文件被 stat。
      //    audit-r172:旧实现只 readdir 顶层 —— literature 域有真实子目录
      //    (UI 能建目录 + 搬文件进去),顶层外的文件既扫不到也监听不到。
      const diskPaths: string[] = [];
      // audit-r215:目录集一并收 —— 尾部 emit 指纹要让它参与(空文件夹
      //   增删不改文件行,只看文件行的指纹会漏掉目录结构变化)。
      const diskDirs: string[] = [];
      // perf r254:扫描期 stat 信息(见 LitDiskStat 头注)—— 后面的
      //   disk-only upsert / refreshDiskStats / byId 回填都从这里取,
      //   不再对每个文件另起一遍 fs.stat。
      const diskStats = new Map<string, LitDiskStat>();
      await collectLiteratureFiles(litDir, diskPaths, 0, diskDirs, diskStats);

      // 2. diskIds(id 用 litResourceId(toPosix(absPath)) 与 0005 迁移行
      //    形态互斥不碰撞 —— 迁移行 rel 是旧 root 路径,新 litDir 是
      //    <rootPath>/literature/ 子树,自然落在 db-only 分支被清。
      //    POSIX 化是必须:Windows 原生 `\\` 与 litResourceId 的 `/` 形态
      //    拼不上,后续 lookup 全 miss)。
      const diskIdSet = new Set<ResourceId>(diskPaths.map((p) => litResourceId(toPosix(p))));

      // 3. dbRows(SQL 已带 kind 过滤,folderId 自动带出,0007 兼容)
      const dbRows = listResources('literature');

      // 4. 算 disk-only = 磁盘有但 DB 无 → upsert(filename-only + indexedAt:0)
      //    r197:dbIds 预建 Set —— 旧实现在**磁盘文件循环内**跑
      //    `dbRows.some(r => r.id === id)`,N 个文件 × M 条 DB 行 = O(N×M)。
      //    reload 是 chokidar 100ms 防抖的高频路径,文献几千条时每次
      //    reload 做几百万次比较(纯浪费)。同函数下面 step 6 已有
      //    diskIdSet 的同款范式,这里对齐。
      const dbIds = new Set<ResourceId>(dbRows.map((r) => r.id));
      const diskOnlyIds = new Set<ResourceId>();
      let inserted = 0;
      for (const p of diskPaths) {
        const id = litResourceId(toPosix(p));
        if (dbIds.has(id)) continue;
        diskOnlyIds.add(id);
        // perf r254:stat 取扫描期那一份(见 LitDiskStat 头注)—— 旧实现这里
        //   又 fs.stat 一次(扫描期那次 lstat 的结果被丢掉了)。
        const st = diskStats.get(p);
        if (!st) {
          log.warn('disk-only upsert skipped (no scan stat)', p);
          continue;
        }
        try {
          // 新行的 folderId=null(磁盘直放 PDF 无用户主动归属);若用户
          // 后续把它移入文件夹,走 folders:move-resources 改归属。
          // indexedAt=0 标记「FTS body 未填」,与 IPC 导入路径同形
          // (literature.ts:62),0005 迁移行也是 0;未来正文抽取流水线
          // 批量回填时一并处理。
          const r: LiteratureResource = {
            id,
            kind: 'literature',
            title: basename(p, extname(p)),
            mtime: st.mtimeMs,
            size: st.size,
            indexedAt: 0,
            absPath: p,
            // audit-r172:文件夹归属(相对 literature 根)—— 递归扫描能拿到
            //   子目录里的文件,归属必须一并算出来,否则 renderer 分不出
            //   「根」和「子目录」。
            relPath: litRelPathOf(litDir, p),
            rootId: null,
            extractStatus: 'filename-only',
          };
          upsertResource(r, '', p);
          inserted++;
        } catch (err: unknown) {
          log.warn('disk-only upsert failed for literature', p, errMsg(err));
        }
      }
      if (inserted > 0) {
        log.info('Literature reload: disk-only inserted', { inserted });
      }

      // 4.5 刷 stat(已在索引里的文件)—— r211
      //    旧实现只 stat disk-only 文件(上面 step 4),已经在库里的行
      //    **一次都不 stat** ⇒ 行上的 mtime/size 永远停在导入那一刻。
      //    连带三处用户可见的错:列表里的「2.3 MB · 2h ago」是假的;
      //    列表按 mtime 倒序 ⇒ 顺序也停在导入那一刻;emit 指纹恒定 ⇒
      //    连 'changed' 都不发 ⇒ 渲染层永远收不到刷新通知。
      //    笔记侧没有这个问题(syncDbWithDisk 每次都重读文件)。
      const refreshed = await this.refreshDiskStats(diskPaths, dbRows, diskIdSet, diskStats);

      // 5. 算 db-only = DB 有但磁盘无 → 保守保留策略(见头部注释):
      //    删行前 isReallyGone(r.absPath)(r219;只有 ENOENT 才算没了):
      //    - 文件还在磁盘(典型 0005 迁移行 absPath 指向旧库路径;或读不到
      //      ⇒ fail-safe 当还在)→
      //      重生成新 id 行(litResourceId(toPosix(absPath))),folderId 抄
      //      旧行,然后 deleteResource 旧行。**不入 dbOnlyIds** 集合
      //      (落到 next 的逻辑由下方 step 6 的 in-disk 复用,这里只算
      //      「保留」不计 drop)。
      //    - 文件确实没了(ENOENT)→ 真 deleteResource(ghost row 收敛语义保留)。
      let dropped = 0;
      let preserved = 0;
      const preservedRows: LiteratureResource[] = [];
      for (const r of dbRows) {
        if (diskIdSet.has(r.id)) continue;
        // 仅 literature 行处理(防御性 —— listResources 已在外部按 kind
        // 过滤,但 TS 类型是 Resource 联合,需 narrow 才不会把 note 行
        // 误判走 absPath 逻辑)
        if (r.kind !== 'literature') {
          try {
            deleteResource(r.id);
            dropped++;
          } catch (err: unknown) {
            log.warn('db-only delete failed for literature', r.id, errMsg(err));
          }
          continue;
        }
        if (await isReallyGone(r.absPath)) {
          // 真 ghost row:磁盘文件已外部消失(ENOENT)→ 就地清理。
          // r219:判据从裸 existsSync 换成 isReallyGone —— 前者把「读不到」
          //   (EACCES/EPERM/EBUSY,Defender/同步盘瞬时占用)压成「没了」,
          //   一次瞬时错误就把还在磁盘上的文献从索引里删掉;现在只有
          //   ENOENT 才算没了,「读不到」走下方「还在」分支保留。
          try {
            deleteResource(r.id);
            dropped++;
          } catch (err: unknown) {
            log.warn('db-only delete failed for literature', r.id, errMsg(err));
          }
          continue;
        }
        // 文件还在磁盘(或读不到 ⇒ fail-safe 当还在)—— 旧 id(0005 迁移行)→ 新 id 升级
        const newId = litResourceId(toPosix(r.absPath));
        if (newId === r.id) {
          // audit-r155:已是新 id 形态(典型:首次 reload 已升级过,后续
          //   reload 再次走到这里)—— 仍需把这一行送进 byId,否则 step 6
          //   的三处 sink 全部 miss:
          //   - diskIdSet 不含 newId(absPath 在 <rootPath>/literature/
          //     外,readdir 看不见)
          //   - diskPaths 不含(同上)
          //   - preservedRows 不会收(本分支此前 continue)
          //   后果:第二次 reload 之后 byId 永久漏这条 0005 行,UI 列表
          //   不可见,但 FTS 仍能搜到(searchResources 走 DB)。Self-
          //   heal 路径需要用户手动触发 rename/resync 才能补回。
          //   修:推 r(已经是新 id)进 preservedRows,step 6 第二段循环
          //   会收。注意:**不**重跑 upsertResource(r, ...)——r.id 与
          //   现存行一致,upsert 是 no-op,只是平白多写一次主表 + 触发
          //   FTS DELETE/INSERT(慢)。
          preservedRows.push(r);
          continue;
        }
        // 抄字段重写 row:absPath 不变(原文件位置),folderId 沿用
        // (用户可能已经把迁移行移进文件夹,不能丢归属),其它字段
        // 保留(metadata 不随 id 变)
        const preservedRow: LiteratureResource = {
          ...r,
          id: newId,
        };
        try {
          // r197:同事务换 id —— 旧实现是 `upsertResource(新行)` +
          //   `deleteResource(旧行)` 两个**独立事务**(moveFile / renameFile
          //   已在 r196 改成单事务 renameResource,这条 db-only 升级路径
          //   当时漏抄)。中间失败 ⇒ 同一文件在 resources 表里留**两行**
          //   (旧 id + 新 id)、FTS 里也有两份内容 ⇒ 全局搜索出重复结果,
          //   且旧行成了永远不会被清掉的 ghost。
          renameResource(r.id, preservedRow, '', r.absPath);
          preserved++;
          preservedRows.push(preservedRow);
        } catch (err: unknown) {
          // 升级失败留旧行(数据比格式重要,后续 reload 还会再试)
          log.warn('db-only preserve (id upgrade) failed for literature', r.id, '→', newId, errMsg(err));
        }
      }
      if (dropped > 0) {
        // audit-r136 H3:从 info 降到 debug —— 这条日志正常启动路径会
        //   在升级期大量出现(用户每开 app 一次,0005 迁移行 ghost 清
        //   一次),用户无感却塞 main 日志面板。debug 级别只在排查
        //   「为什么我文献消失了」时打开。
        log.debug('Literature reload: db-only dropped (file gone)', { dropped });
      }
      if (preserved > 0) {
        // 保留事件是 r136 引入的新路径,需要 info 让用户知道系统做了迁移
        log.info('Literature reload: db-only preserved (file still on disk, id upgraded)', {
          preserved,
        });
      }

      // 6. 重建 byId = 在 disk 的 db rows ∪ disk-only 新 upsert rows ∪
      //    preserved 旧 id 升级行(新 id 不在 diskIdSet —— 这些行的
      //    absPath 指向旧库路径,不在新 rootPath/literature/ 子树内)。
      //    顺序:先填 disk-in-db 的稳定行,再补 disk-only 新行,最后
      //    覆盖 preserved(理论上新 id 不会与既有行碰撞 —— 老 root ≠
      //    新 root,字符字面不重叠,但 set 写后写先得后写更稳)。
      const next = new Map<ResourceId, LiteratureResource>();
      for (const r of dbRows) {
        // audit-r136:listResources('literature') 返回 Resource[] (union);
        //   byId 是 Map<ResourceId, LiteratureResource>,需 narrow 才会被
        //   TS 接受。listResources 的 kind filter 是运行时校验,但 TS 层
        //   看不到,所以这里加 discriminator guard(防御性 = 不依赖运行
        //   时 filter,数据若被外部 dirty 也不会把 NoteResource 漏进
        //   LiteratureResource map)。
        if (r.kind !== 'literature') continue;
        // audit-r172:DB 行没有 relPath(literature 的 rel_path 列退化成
        //   absPath 本身)→ 运行时从 absPath 算真实归属。
        if (diskIdSet.has(r.id)) {
          // r211:stat 被刷过的行用刷新后的值 —— 否则 byId 里还是旧
          //   mtime/size ⇒ 指纹不变 ⇒ 不 emit ⇒ 渲染层看不到变化。
          const base = refreshed.get(r.id) ?? r;
          next.set(r.id, { ...base, relPath: litRelPathOf(litDir, r.absPath) });
        }
      }
      for (const pr of preservedRows) {
        next.set(pr.id, { ...pr, relPath: litRelPathOf(litDir, pr.absPath) });
      }
      for (const p of diskPaths) {
        const id = litResourceId(toPosix(p));
        if (next.has(id)) continue;
        if (!diskOnlyIds.has(id)) continue;
        // perf r254:同 step 4 —— 用扫描期的 stat,不再单独 fs.stat。
        const st = diskStats.get(p);
        if (!st) {
          // 上方 upsert 已 log,这里吞掉防 byId 漏 key
          continue;
        }
        next.set(id, {
          id,
          kind: 'literature',
          title: basename(p, extname(p)),
          mtime: st.mtimeMs,
          size: st.size,
          indexedAt: 0,
          absPath: p,
          relPath: litRelPathOf(litDir, p),
          rootId: null,
          extractStatus: 'filename-only',
        });
      }
      this.byId = next;
      // audit-r136 M1:指纹检查 —— 排序 ids join(用 byId 内真实存的 id 集合,
      //   覆盖 disk-in-db + disk-only + preserved 三个来源)。id 形态稳定
      //   (LitResourceId 字符串),排序保证 fingerprint 跨 reload 一致。
      //   注意:**只**用 id 算 fingerprint;metadata(mtime/size)即使变化,
      //   也想让 renderer 端 load 走全量拉。但这种「磁盘文件外部修改
      //   但 lit 行仍存在」场景下,mtime 变化是真实数据变化,必须 emit。
      //   因此 fingerprint 兼顾 id + mtime + size:
      //   `${id}|${mtime}|${size}` 排序后 join。规模 ~200 条 × 40 字符 ≈ 8KB,
      //   join + 字符串比较 < 1ms,对 reload 50ms 量级开销可忽略。
      //   r211:size 也参与 —— 「内容变了但 mtime 被保留」(备份还原 /
      //   cp -p / 同步盘按内容去重)这种场景 mtime 恒定,只看 mtime 会把
      //   真实变化判成「没变」⇒ 静默不刷。
      //   r215:目录集也进指纹 —— 空文件夹的增 / 删 / 改名不改变任何
      //   **文件行**,只看 `${id}|${mtime}|${size}` 的指纹会把目录结构变化
      //   判成「没变」⇒ 不 emit ⇒ 左侧栏文件夹树与磁盘对不上(notes 域
      //   r223 起也是指纹 emit,目录维度同样必带 —— 它的 watcher 自 r184
      //   就监听 addDir/unlinkDir)。目录用相对 litDir 的 POSIX
      //   relPath(rootPath 迁移 / ADR-0003 换根后绝对路径全变,会刷出一次
      //   假指纹差),排序保证跨 reload 稳定。
      const dirSig = diskDirs
        .map((d) => toPosix(relative(litDir, d)))
        .sort()
        .join(',');
      // perf r257:逐行状态 Map(不再拼大字符串)—— 判定语义与旧的
      //   「`${id}|${mtime}|${size}` 排序 join 后比字符串」完全一致
      //   (集合相同 + 每行 (mtime,size) 相同 ⇒ 「没变」),代价从
      //   O(n log n) 字符串排序降为 O(n) 逐项比对。
      const rowState = new Map<ResourceId, { mtime: number; size: number }>();
      for (const [id, r] of this.byId) {
        rowState.set(id, { mtime: r.mtime, size: r.size });
      }
      if (sameLitState(this.lastEmitRows, rowState) && dirSig === this.lastEmitDirs) {
        // 状态没变 → 跳过 emit,renderer 端不会触发多余 load
        return;
      }
      this.lastEmitRows = rowState;
      this.lastEmitDirs = dirSig;
      this.emit('changed');
    });
  }

  /**
   * r211:把「已在索引里」的文件的 stat 刷成磁盘真值。
   *
   * 只处理「id 在 diskIdSet 里」的行 —— 这些行的 absPath 就在当前
   * literature 子树内(0005 迁移行 / 旧库路径的行走 step 5 的保留与
   * id 升级分支,不在本函数职责内)。
   *
   * 写库走 updateResourceStat(只更 size/mtime 两列,**不碰 FTS** ——
   * 走 upsert 会把已抽正文的文献正文清空,见 resources-repo 的说明)。
   *
   * 判据:st.mtimeMs !== row.mtime || st.size !== row.size 才写。
   * stat 拿不到(EPERM / EBUSY / 文件刚被删)⇒ 本轮跳过,保留旧值 ——
   * **不**当成「文件没了」(那是 db-only 分支的职责,见 r209 的口径:
   * 只有 ENOENT 才算「没了」)。
   */
  private async refreshDiskStats(
    diskPaths: string[],
    dbRows: Resource[],
    diskIdSet: Set<ResourceId>,
    // perf r254:扫描期 stat 信息 —— 本轮不再对每个文件另起一遍 fs.stat
    //   (实测 2000 篇 = 扫描 40ms + 二次 stat 35ms;合并后只剩扫描那一次)。
    diskStats: Map<string, LitDiskStat>,
  ): Promise<Map<ResourceId, LiteratureResource>> {
    const refreshed = new Map<ResourceId, LiteratureResource>();
    const rowsById = new Map<ResourceId, LiteratureResource>();
    for (const r of dbRows) {
      if (r.kind !== 'literature') continue;
      if (!diskIdSet.has(r.id)) continue;
      rowsById.set(r.id, r);
    }
    if (rowsById.size === 0) return refreshed;
    let changed = 0;
    await runPool(diskPaths, LITERATURE_STAT_CONCURRENCY, async (p) => {
      const id = litResourceId(toPosix(p));
      const row = rowsById.get(id);
      // disk-only(本轮新出现的)不在这里 —— step 4 已经带真 stat 插进去了
      if (!row) return;
      // perf r254:优先用扫描期那一份 stat(语义等价,见 LitDiskStat 头注);
      //   拿不到(理论上不可能 —— diskPaths 全部来自扫描)才回退 fs.stat。
      const scanStat = diskStats.get(p);
      let mtimeMs: number;
      let size: number;
      if (scanStat) {
        mtimeMs = scanStat.mtimeMs;
        size = scanStat.size;
      } else {
        let st: Stats;
        try {
          st = await fs.stat(p);
        } catch (err: unknown) {
          log.warn('Literature stat refresh skipped (cannot stat)', p, errMsg(err));
          return;
        }
        mtimeMs = st.mtimeMs;
        size = st.size;
      }
      if (mtimeMs === row.mtime && size === row.size) return;
      try {
        updateResourceStat(id, size, mtimeMs);
      } catch (err: unknown) {
        log.warn('Literature stat refresh write failed', id, errMsg(err));
        return;
      }
      refreshed.set(id, { ...row, mtime: mtimeMs, size });
      changed++;
    });
    if (changed > 0) {
      log.info('Literature reload: stat refreshed', { changed });
    }
    return refreshed;
  }

  /** 60s 周期 resync 旧库迁移行 —— 见字段注释 audit-r162 H1 */
  private startResyncTimer(): void {
    if (this.resyncTimer) return;
    this.resyncTimer = setInterval(() => {
      if (!this.started) return;
      this.resyncExternal().catch((err: unknown) => {
        log.warn('Literature external resync failed', errMsg(err));
      });
    }, LITERATURE_EXTERNAL_RESYNC_INTERVAL_MS);
  }

  /**
   * audit-r162 H1:旧库迁移行 resync —— 60s 走一轮 byId,凡 absPath 落在
   *   `<rootPath>/literature/` 子树**之外**(典型 0005 迁移旧库路径)的
   *   行 isReallyGone 二次检测(r219;只有 ENOENT 才算「没了」,「读不到」
   *   fail-safe 当还在),文件不在则 deleteResource + byId.delete。
   *   走 writeLock 与 reload 互斥(否则 reload 同步装配 byId 时 resync
   *   改 byId 会撞)。
   */
  private async resyncExternal(): Promise<void> {
    await this.writeLock.run(async () => {
      if (!this.started) return;
      const litDir = join(getRootPath(), WORKSPACE_DATA_LAYOUT.LITERATURE_DIR);
      const litDirPrefix = toPosix(litDir) + '/';
      let dropped = 0;
      for (const [id, r] of this.byId) {
        if (toPosix(r.absPath).startsWith(litDirPrefix)) continue;
        // r219:isReallyGone 只有 ENOENT 才算「没了」,永不 throw ——
        //   旧实现的 try/catch 包 existsSync 是死代码(existsSync 自己
        //   吞掉所有错误返回 false),「读不到」被压成「没了」⇒ 瞬时
        //   EACCES/EPERM 就把还在磁盘上的外部行删掉。
        if (!(await isReallyGone(r.absPath))) continue;
        try {
          deleteResource(id);
          this.byId.delete(id);
          dropped++;
        } catch (err: unknown) {
          log.warn('resync deleteResource failed for literature', id, errMsg(err));
        }
      }
      if (dropped > 0) {
        log.info('Literature resync: external rows dropped', { dropped });
        this.emit('changed');
      }
    });
  }
}

// 模块级单例 —— 与 notes/service.ts 同款懒加载。
let _instance: LiteratureService | null = null;
export function getLiteratureService(): LiteratureService {
  if (!_instance) _instance = new LiteratureService();
  return _instance;
}
