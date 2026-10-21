// 笔记服务:内存索引 + chokidar 监听 + writeLock 串行化。
// 与 favorites 同款「内部权威 + push event」模式。

import { EventEmitter } from 'events';
import chokidar, { FSWatcher } from 'chokidar';
import { promises as fs } from 'fs';
import { join, relative } from 'path';
import type { FolderMoveResult, StandaloneNote, StandaloneNoteSummary } from '@shared/types';
import { WORKSPACE_DATA_LAYOUT, toNoteSummary } from '@shared/types';
import { toPosix, toNotePath } from './path-mapping';
import {
  scanNotes,
  writeNote,
  createNote,
  renameNote,
  moveNoteAcrossFolders,
  moveNoteDirAcrossFolders,
  renameNoteDir,
  repinNoteId,
  readNoteMtime,
  parseNoteFile,
  collectNotePaths,
  readNote,
  NOTE_FILE_EXT_RE,
} from './standalone';
// r175:导入走 service(旧实现 IPC handler 直调 helper → 导入的笔记不进
//   byId / resources 表,见 importFile 注释)
import { importNoteFromFile } from './import';
import type { NotesImportResult } from '@shared/api-types';
import { getRootPath, safeTrash, sweepOrphanTmpFiles } from '../utils/safe-write';
import { closeWatcherQuietly, withWatcherReleased } from '../utils/watcher-release';
import { LibraryError, errMsg } from '../utils/error';
import { isReallyGone } from '../utils/file-check';
import { assertNoConflict } from '../utils/optimistic-concurrency';
import { tr } from '../i18n';
import { createLogger } from '../utils/logger';
import { WriteLock } from '../utils/write-lock';
import { SelfWriteEchoSuppressor, fileFingerprint } from '../utils/self-write-echo';
import type { FileFingerprint } from '../utils/self-write-echo';
import {
  upsertResource,
  deleteResource,
  listResources,
  listResourceRelPaths,
  listStaleIndexIds,
  renameResource,
} from '../db/resources-repo';
import { noteResourceId, parseResourceId } from '@shared/resource-id';
import { stripExt } from '@shared/path-utils';
import type { NoteResource } from '@shared/types';
import { computeFileId } from './path-mapping';

const log = createLogger('notes-service');

/**
 * perf r255:取一篇笔记 body 的 UTF-8 字节数。
 *
 * 口径 = `Buffer.byteLength(body,'utf8')`(与 noteResourceOf 写库的 size
 *   列同算法)—— **唯一**区别是值优先取解析缓存(见 standalone.ts 的
 *   NoteParseCacheEntry.bodyBytes):缓存命中时零计算,未命中(理论上
 *   不该发生 —— 缓存与 notes 同源)才现场算一次。
 *
 * 为什么值得:byteLength 是一次**全量 UTF-8 扫描**,实测 2000 篇 × 8KB
 *   = 4.3ms/遍 的**主线程纯 CPU**(不是 I/O 等待 ⇒ 直接推迟同期的其它
 *   IPC 响应 ⇒ 用户侧「卡一下」)。旧实现每轮 reload 付两遍(emit 指纹
 *   一遍 + DB 判定一遍)= 4000 次调用 ≈ 8.6ms,稳态下这就是白烧。
 */
function bodyBytesOf(note: StandaloneNote, cache: Map<string, number> | undefined): number {
  const cached = cache?.get(note.relPath);
  return cached === undefined ? Buffer.byteLength(note.body, 'utf8') : cached;
}

/**
 * perf r255:两轮扫描的 per-note 状态是否**完全相同**(emit 幂等判定)。
 *
 * 判定语义与旧的「`${id}|${mtime}|${bytes}` 排序 join 后比字符串」**一字
 * 不差**:集合相同(条数一致)且每条的 (mtime, bytes) 一致 ⇒ 「没变」。
 * 差别只在代价:旧实现每次 reload 要拼 2000 个字符串 + 排序 + join
 * (实测 ≈ 5.7ms/2000 篇),这里只做 O(n) 的逐项比对(≈ 0.3ms)。
 *
 * 「同长不同文 + mtime 保留」判成「没变」—— 这是 r211/r220 双因子口径
 * 一直接受的盲区(备份还原 / cp -p / 同步盘按内容去重),不是本函数引入的。
 */
function sameNoteState(
  a: Map<string, { mtime: number; bytes: number }> | null,
  b: Map<string, { mtime: number; bytes: number }>,
): boolean {
  if (!a) return false; // 首轮:必 emit
  if (a.size !== b.size) return false;
  for (const [id, v] of b) {
    const prev = a.get(id);
    if (prev === undefined) return false;
    if (prev.mtime !== v.mtime || prev.bytes !== v.bytes) return false;
  }
  return true;
}

const RELOAD_DEBOUNCE_MS = 100;
/**
 * perf r239(2026-10-21):**自写回声抑制** —— 「我刚写过的文件,watcher 的回声
 * 不再触发全量重扫」。
 *
 * 判据 = **文件指纹**(mtime + size + ino),不是时间窗口:
 *   写盘后记下指纹;回声事件到达时现 stat 一次比对 —— 一样 ⇒ 文件还是
 *   我们写的那份 ⇒ 纯回声,抑制;不一样 ⇒ 文件被别人动过 ⇒ 照常重扫。
 *   早期实现用「1 秒时间窗口」,结果**窗口内的外部改动被一起吞掉**
 *   (用户 autosave 后 1 秒内又用 Obsidian / 同步盘改了同一个文件 ⇒ 那次
 *   改动永远不可见)—— 指纹判据没有这个洞。
 *
 * 下面的 TTL 只用于「回声迟到太久 / 平台丢事件」时让记录过期(宁可多重扫,
 * 不可漏扫),不是「判定是不是自写」的主判据。
 *
 * **不要**跟 renderer 的 SELF_WRITE_SUPPRESS_WINDOW_MS(500ms)「统一」——
 * 两者管的是不同的东西(那边管 IPC 往返,这边管磁盘 IO),强行对齐会让
 * 其中一个的余量被吃掉。
 */
const NOTES_SELF_WRITE_ECHO_TTL_MS = 30_000;
/**
 * perf r239:自写回声抑制后的**延迟复核**间隔(见 scheduleEchoVerify)。
 * 400ms:足够让「写盘 → 外部改动」这条链上的 watcher 事件都落地;
 * 又不至于让复核拖到用户已经忘了这次保存。
 */
const ECHO_VERIFY_DELAY_MS = 400;
// notes chokidar depth cap:对齐 import.ts,防深层目录 DoS(handle alloc);
// chokidar depth 0-based,顶层 + 16 层 = depth: 16
const MAX_NOTES_WATCH_DEPTH = 16;
// watcher 连续重启上限:防「库/数据目录被删 / 权限翻转 / 网络盘长期掉线」
// 等永久坏路径触发 2s 一轮 log 风暴,超过触发 'watcher-failed' 让用户介入
const MAX_NOTES_AUTO_RESTARTS = 5;
/** watcher 重启退避基数 */
const NOTES_WATCHER_RESTART_DELAY_MS = 2000;
/** watcher「健康期」窗口:重启后这段时间内不再报错 ⇒ 上一次失败是孤立事件,
 *  连续失败计数可以清零(见 scheduleWatcherRestart 的 r197 段)。 */
const NOTES_WATCHER_HEALTHY_MS = 30_000;

// r219:isReallyGone(「只有 ENOENT 才算没了」)已上收到 utils/file-check.ts
// 单一真相源 —— notes(r209 两处)与 literature(r219 两处)共用同一份,
// 不再各自维护孪生实现。

// 按 id 索引(id = SHA-256(relPath),重命名时 id 会变,但 user 「我编辑的是同一个笔记」
// 基于 relPath;为「按 id 查找」语义,内存用 id 索引)
export class NotesService extends EventEmitter {
  private byId = new Map<string, StandaloneNote>();
  private watcher: FSWatcher | null = null;
  private reloadTimer: NodeJS.Timeout | null = null;
  private started = false;
  // watcher 自动重启状态机(对齐 library 同款):旧实现 chokidar 失败就永久死亡 ——
  // 同步抛没有重启路径,异步 'error' 事件 handler 只 log.warn,this.watcher 仍
  // 指向死实例,事件流静默断。修法:2s 退避重启 + 连续失败上限防永久坏路径打
  // log 风暴 + start() 重置计数。restartTimer 必须在 stop() 清,否则拖 event loop
  // 阻退出
  private watcherRestartTimer: NodeJS.Timeout | null = null;
  private watcherRestartAttempts = 0;
  // r197:健康期计时器 —— 重启后 NOTES_WATCHER_HEALTHY_MS 内不再报错 ⇒
  //   判定「这次真的活了」⇒ 连续失败计数清零(详见 scheduleWatcherRestart)
  private watcherHealthTimer: NodeJS.Timeout | null = null;
  // 写操作并发锁,所有 mutation 串行化(抽到 utils/write-lock.ts 共享)
  private writeLock = new WriteLock();
  // audit-r223:reload 的 emit 幂等指纹(镜像 literature r136 M1 / r211 /
  //   r215)—— null = 首次 reload 必 emit(首推)。
  //
  // perf r255:指纹的**表示**换了(判定语义一字未改):旧实现把
  //   `${id}|${mtime}|${bytes}` 拼成 2000 个字符串再 sort + join 成一个大
  //   字符串(实测 2000 篇 ≈ 5.7ms/轮:2000 次拼接 + 一次 O(n log n) 排序
  //   + 一次 join)。而判定本身只需要「逐条比一比」⇒ 改成
  //   Map<id, {mtime, bytes}> 逐项比对:同样的判定,零排序零 join
  //   (实测 ≈ 0.7ms/轮)。
  private lastEmitNotes: Map<string, { mtime: number; bytes: number }> | null = null;
  // 目录维度的指纹(空文件夹的增/删/改名不改变任何**文件行** —— 见下)。
  private lastEmitDirs = '';
  // perf r239:自写回声抑制器 —— 详见 utils/self-write-echo.ts 的头注。
  //   autosave 每 1.5s 落一次盘 → watcher 回声 → 全量重扫(实测 2000 篇
  //   410ms),而这次重扫是纯浪费(write() 自己已经更新了 byId + DB + FTS)。
  private selfWrites = new SelfWriteEchoSuppressor(NOTES_SELF_WRITE_ECHO_TTL_MS);
  // perf r239:自写回声抑制后的延迟复核 timer(路径 → timer)。
  //   必须清:未清的 timer 会拖住 event loop 阻退出(与 reloadTimer 同款理由)。
  private echoVerifyTimers = new Map<string, NodeJS.Timeout>();

  async start(opts: { skipInitialLoad?: boolean } = {}): Promise<void> {
    if (this.started) return;
    try {
      // 三层 mkdir 防御:startup 顶层 + scanNotes + createNote,保证 notes/ 在任何代码路径
      // 上不会因外部因素(OneDrive sync / 用户手动删 / AV 隔离)突然消失
      const notesDir = join(getRootPath(), WORKSPACE_DATA_LAYOUT.NOTES_DIR);
      await fs.mkdir(notesDir, { recursive: true });
      // 清扫原子写 tmp 残留:<name>.md.<rand>.tmp(safeWriteFileAtomic 在 close→rename
      // 之间被杀留下)。scanNotes 只认 .md,看不见也不自愈 —— 反复断电持续堆积
      void sweepOrphanTmpFiles(notesDir).catch((sweepErr: unknown) => {
        log.warn('Orphan tmp sweep failed', errMsg(sweepErr));
      });
    } catch (err: unknown) {
      // 不再 swallow + emit('error'):旧实现 started 永远 false,后续任何 mutation
      // 因目录不存在抛 ENOENT,IPC 看似「启动成功」实则半残。throw 让 bootstrap
      // allSettled 透传错误,弹 dialog 提示用户检查磁盘权限
      log.error('Failed to ensure notes dir', errMsg(err));
      throw err;
    }
    // started=true 必须先置再调 reload() —— reload 守卫本意是阻 timer fire-after-stop
    // 重建 byId,若 started 在 reload 之后才 true,首次 reload 也会被自己守卫拦下,
    // list() 永远空
    this.started = true;
    if (!opts.skipInitialLoad) {
      await this.reload();
    }
    // 显式 start 重置计数,否则一次失败耗尽的计数让「重启应用 / 显式 retry」也被阈值锁死
    this.watcherRestartAttempts = 0;
    this.startWatcher();
  }

  /** 建立 notes 目录的 chokidar watcher — start() 与自动重启共用同一代码路径 */
  private startWatcher(): void {
    try {
      const notesDir = join(getRootPath(), WORKSPACE_DATA_LAYOUT.NOTES_DIR);
      const w = chokidar.watch(notesDir, {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
        depth: MAX_NOTES_WATCH_DEPTH,
      });
      this.watcher = w;
      // perf r239:文件级事件带路径走 scheduleReload(path) —— 判「是不是
      //   我自己写出来的回声」需要路径(chokidar 的 file 事件带 path,
      //   dir 事件不带)。目录事件仍旧无路径地走全量 reload。
      const schedule = (p: string) => this.scheduleReload(p);
      // perf r239:只对**笔记文件**(与 collectNotePaths 的收集口径逐字对齐)
      //   的事件触发 reload。旧实现对目录里**任何**文件都触发 ⇒ 用户往
      //   notes/ 里丢一张图片、粘一个 PDF、放进 .gitignore 之类的杂文件,
      //   每个都会命中 chokidar 'add' ⇒ **白跑一次全库重扫**
      //   (实测 2000 篇一次 410ms,而这些文件根本不是笔记)。
      //
      //   注(实测纠正,2026-10-21):早先以为「原子写的 tmp 文件
      //   (`<target>.rkms-a<rand>.tmp`)也会命中 'add',于是每次 autosave
      //   都多触发一次全量重扫」—— **实测不成立**:chokidar 的
      //   awaitWriteFinish(stabilityThreshold 50ms)要求文件大小稳定
      //   50ms 才上报,而 tmp 文件在几毫秒内就被 rename 走 ⇒ 永远
      //   达不到稳定阈值 ⇒ chokidar 根本不上报它。变异实证:去掉本过滤
      //   后,「应用自己写盘」用例的重扫次数仍是 0。
      //   过滤器的真实收益在**杂文件**(图片 / PDF / 其它后缀)——
      //   守卫用例 D 锁住这一条(变异:去掉过滤 ⇒ D 红)。
      //
      //   口径与 collectNotePaths 一致 ⇒ 不改变「哪些文件算笔记」的语义,
      //   只是不再为非笔记文件白跑一趟全库重扫。
      const onNoteFile = (p: string) => {
        if (!NOTE_FILE_EXT_RE.test(p)) return;
        schedule(p);
      };
      w.on('add', onNoteFile);
      w.on('change', onNoteFile);
      w.on('unlink', onNoteFile);
      // r184:目录**结构**变化也要触发 reload。
      //   旧实现只监听文件级 add/change/unlink ⇒ 用户在资源管理器里
      //   **建了一个空文件夹**(或删了一个文件夹)时,主进程连 'changed'
      //   都不发 ⇒ renderer 完全不知道磁盘的目录结构变了 ⇒ 左侧栏的
      //   文件夹树与磁盘永久对不上(外部建的夹不出现、外部删的夹还在)。
      //   文件级事件覆盖不到「只有目录变、没有文件变」这一类。
      w.on('addDir', () => this.scheduleReload());
      w.on('unlinkDir', () => this.scheduleReload());
      w.on('error', (err: unknown) => {
        // 不再裸 emit('error'):无 listener 时抛 unhandledError 同步崩主进程
        log.warn('Notes watcher error', errMsg(err));
        if (this.listenerCount('error') > 0) {
          this.emit('error', err);
        }
        // 最隐蔽失败形态:chokidar 内部已卡死/unwatch 掉,this.watcher 仍指向死
        // 实例,事件流静默断。闭包 w(不是 this.watcher)判断「自己是否已被替换」,
        // 避免旧实例迟到 error 误伤新 watcher
        if (this.watcher === w) {
          // 重启前必须先关掉+摘监听 —— 旧实现只置 null 不关,旧 chokidar 仍持有
          // fs.watch 句柄,add/change/unlink 监听还绑着 scheduleReload(一次外部改动
          // 触发多次 reload);stop() 只关 this.watcher(= null)关不掉它,退出期拖 event loop
          w.removeAllListeners();
          // closeWatcherQuietly(r216):裸 close 后晚到的 awaitWriteFinish
          // 轮询 stat 报错(Windows EPERM)⇒ emit('error') 无监听者 ⇒ 同步 throw
          void closeWatcherQuietly(w).catch((closeErr: unknown) =>
            log.warn('Notes watcher close during restart threw', errMsg(closeErr)),
          );
          this.watcher = null;
          this.scheduleWatcherRestart(err);
        }
      });
    } catch (err: unknown) {
      log.warn('Failed to start notes watcher (scheduling restart)', errMsg(err));
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
    // started=false 是退出期 —— 不排重启(留悬挂 timer)
    if (!this.started) return;
    // 已有 pending 不重复排,避免错误风暴排一串 timer
    if (this.watcherRestartTimer) return;
    // r197:刚又报错 ⇒ 上一次的「健康期」判定作废(健康期计时器必须撤,
    //   否则它会在 30s 后把计数清零,而 watcher 其实一直坏着 —— 计数清零
    //   ⇒ 2s 退避变成无限重试,正是本上限要防的 log 风暴)。
    if (this.watcherHealthTimer) {
      clearTimeout(this.watcherHealthTimer);
      this.watcherHealthTimer = null;
    }
    if (this.watcherRestartAttempts >= MAX_NOTES_AUTO_RESTARTS) {
      log.error('Notes watcher restart limit reached — giving up until next app start', {
        attempts: this.watcherRestartAttempts,
      });
      this.emit('watcher-failed', cause);
      return;
    }
    this.watcherRestartAttempts++;
    this.watcherRestartTimer = setTimeout(() => {
      this.watcherRestartTimer = null;
      if (!this.started) return;
      log.info('Restarting notes watcher', { attempt: this.watcherRestartAttempts });
      this.startWatcher();
      // r197:重启成功 ⇒ 排一个「健康期」计时器:NOTES_WATCHER_HEALTHY_MS 内
      //   不再报错 ⇒ 计数清零。
      //   旧实现只在 start()/stop() 清计数,于是「连续失败上限」实际是**终身**
      //   预算:一次长会话里攒够 5 次瞬时 watcher 错误(网络盘抖一下 /
      //   OneDrive 同步冲突 / AV 扫一下 / 目录被临时改名)就把 watcher 永久
      //   放弃 —— 之后所有外部改动都不再被感知,用户看到「我改了文件,应用
      //   不更新」,且没有任何报错提示(只在日志里)。
      //   计数清零必须**延后**到健康期结束,不能在 startWatcher() 之后立刻
      //   清:watcher 起来后马上再 error 的话,计数归零 ⇒ 无限重试。
      this.watcherHealthTimer = setTimeout(() => {
        this.watcherHealthTimer = null;
        if (!this.started) return;
        this.watcherRestartAttempts = 0;
      }, NOTES_WATCHER_HEALTHY_MS);
      void this.reload().catch((err: unknown) => {
        log.warn('Notes reload after watcher restart failed', errMsg(err));
      });
    }, NOTES_WATCHER_RESTART_DELAY_MS);
  }

  /** 显式触发一次全文重扫(推迟扫描到窗口出现之后的场景) */
  async load(): Promise<void> {
    await this.reload();
  }

  async stop(): Promise<void> {
    // 先标 started=false:防止 close 期间 fire 事件触发 scheduleReload 创建新 timer,
    // 在 byId.clear() 之后又 populate 回数据(stale 状态泄漏到下次 start)。
    // scheduleReload 双重保护 if (!started)
    this.started = false;
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
    // 必须清 watcher 重启 timer:started 已置 false,回调守卫会 bail,但 timer 句柄
    // 本身仍持 2s 拖 event loop 阻退出。顺带重置计数,下次 start() 干净起步
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
    if (this.watcher) {
      try {
        // closeWatcherQuietly(r216):退出期被监听树里的文件正被外部删/搬时,
        // 晚到的 awaitWriteFinish 轮询错误不能变成 uncaught exception
        await closeWatcherQuietly(this.watcher);
      } catch (err: unknown) {
        // shutdown 路径不该因 watcher 关不上 throw 阻断其他清理,降级 warn
        log.warn('Notes watcher close failed during shutdown', errMsg(err));
      }
      this.watcher = null;
    }
    // 先等 in-flight writeLock 结束再清 byId —— 避免 stop() 之后的写入落到内存被清空
    // WriteLock 非 thenable,await 实例本身绕过 FIFO chain;drain() 在链尾排 no-op,
    // resolve 即说明前面所有 run() 都完成
    await this.writeLock.drain();
    this.byId.clear();
  }

  /** 全量列表(mtime 倒序,含 body)—— 调用方显式决定"我要 body",
   *  默认走 listSummaries() 零 body 开销 */
  list(): StandaloneNote[] {
    return Array.from(this.byId.values()).sort((a, b) => b.mtime - a.mtime);
  }

  /** 精简列表(mtime 倒序,无 body) —— IPC 默认走这条 */
  listSummaries(): StandaloneNoteSummary[] {
    return Array.from(this.byId.values())
      .sort((a, b) => b.mtime - a.mtime)
      .map(toNoteSummary);
  }

  findById(id: string): StandaloneNote | null {
    return this.byId.get(id) ?? null;
  }

  // abs_path 不入 Resource(纯派生量),upsert 时由 caller 单传
  private noteResourceOf(n: StandaloneNote): NoteResource {
    return {
      id: noteResourceId(n.id),
      kind: 'note',
      // audit-r222:无标题兜底必须与 scan 路径(standalone.ts readNoteHeader)
      //   同口径 = stripExt(filename)(**去扩展名**)。旧实现 ?? n.filename 带
      //   .md 后缀,且只在「行来自 readNote/writeNote(title 可为 null)」时
      //   触发 ⇒ 无标题笔记每次保存后 DB title 在 'foo' 与 'foo.md' 之间
      //   翻转,FTS SearchHit.title 跟着翻。read 路径的 null 不能删 ——
      //   它是编辑器标题框「空 ⇒ 显示占位符、不写回 fm.title」的语义载体。
      title: n.title ?? stripExt(n.filename),
      relPath: n.relPath,
      tags: n.tags ?? [],
      mtime: n.mtime,
      size: Buffer.byteLength(n.body, 'utf8'),
      indexedAt: Date.now(),
    };
  }

  /** 磁盘写成功后的 resources / resources_fts 同步。失败 log + 不否决磁盘写
   * (磁盘是 source of truth)—— 失败行 disk-only 由下次 resync 插入,或
   * indexed_at=0 由下次启动 stale-index 回填,两条自愈路径都在本类里
   *
   * perf r239:返回**是否成功** —— 自写回声抑制依赖它:
   *   DB 同步失败时**不能**抑制 watcher 回声(否则这条笔记的 DB 行永远
   *   停在旧正文,只能等下次外部改动或重启才自愈)。失败 ⇒ 不打自写标记
   *   ⇒ 回声照常触发全量 reload ⇒ syncDbWithDisk 把这行补上。
   */
  private syncResource(n: StandaloneNote): boolean {
    try {
      upsertResource(
        this.noteResourceOf(n),
        n.body,
        toNotePath(getRootPath(), n.relPath),
      );
      return true;
    } catch (err: unknown) {
      log.error('resource sync failed for note', n.relPath, errMsg(err));
      return false;
    }
  }

  // CRUD
  async create(filename: string): Promise<StandaloneNote> {
    return this.writeLock.run(async () => {
      const n = await createNote(getRootPath(), filename);
      this.byId.set(n.id, n);
      this.syncResource(n);
      this.emit('changed');
      return n;
    });
  }

  /**
   * audit-r175:OS 拖入 .md 的导入 —— **必须走 service**,不能裸调
   *   standalone helper。
   *
   * 旧实现(IPC handler 直调 notes/import.ts 的 importNoteFromFile)完全
   * 绕开本类,后果有两条,都是用户可见的:
   *
   *   1. **导入的笔记不进 byId** —— chokidar 的 'add' 事件要等
   *      awaitWriteFinish(50ms)+ reload 去抖(100ms)才把笔记塞进 byId,
   *      而 renderer 拿到 import 结果后**立刻**调 moveToFolder(把笔记
   *      移进当前文件夹)→ byId.get(id) 必 miss → NOT_FOUND →
   *      「导入成功」toast 与「移动失败」toast 同时弹,笔记停在 notes 根。
   *   2. **导入的笔记不进 resources 表** —— notes 域的 reload() 只重建
   *      byId、不做 disk↔DB 差集(文献域有),所以导入的笔记在本次会话内
   *      永远没有 FTS 行 → 全局搜索搜不到它。
   *
   * 现在导入收进 service:文件落盘后立刻 byId.set + syncResource(DB/FTS),
   * 跟 create() 同一形态。落点仍是 notes 根(导入不带目录语义),要进子目录
   * 由 caller 紧接着调 moveFile —— 那时 byId 已经有行了。
   */
  async importFile(sourcePath: string): Promise<NotesImportResult> {
    return this.writeLock.run(async () => {
      const result = await importNoteFromFile(sourcePath, getRootPath());
      const relPaths = result.createdRelPaths ?? [];
      for (const relPath of relPaths) {
        const note = await readNote(getRootPath(), relPath);
        if (!note) continue;
        this.byId.set(note.id, note);
        this.syncResource(note);
      }
      if (relPaths.length > 0) this.emit('changed');
      return result;
    });
  }

  async write(
    id: string,
    body: string,
    title?: string,
    // expectedMtime:renderer 在 loadFullNote 时记下 activeNoteFull.mtime,save 时回传。
    // 比对磁盘 mtime,不一致抛 CONFLICT(防 OneDrive/iCloud sync、Vim、git pull 等
    // 外部修改被静默覆盖)。无 expectedMtime 保持 last-writer-wins(向后兼容老 caller)
    expectedMtime?: number,
  ): Promise<StandaloneNote> {
    return this.writeLock.run(async () => {
      const existing = this.byId.get(id);
      if (!existing) {
        throw new LibraryError('NOT_FOUND', tr('notes.notFound', { id }));
      }
      // expectedMtime 判定抽到 utils/optimistic-concurrency.assertNoConflict 共享
      // 走严格 ===,文件系统 fractional-second 容差(NTFS 100ns/APFS ns)由 caller
      // Math.round 兜底
      if (expectedMtime !== undefined) {
        const diskMtime = await readNoteMtime(getRootPath(), existing.relPath);
        if (diskMtime === null) {
          // 外部删了/搬走 → NOT_FOUND 与 byId 找不到对称
          throw new LibraryError('NOT_FOUND', tr('notes.notFoundPath', { path: existing.relPath }));
        }
        try {
          assertNoConflict(Math.round(diskMtime), Math.round(expectedMtime));
        } catch {
          // 抛 AppError('CONFLICT') — 用 i18n 字符串重包装让 toast 走用户语言
          // actual = 磁盘 mtime,expected = renderer 读时快照
          throw new LibraryError(
            'CONFLICT',
            tr('notes.modifiedExternally', {
              actual: String(Math.round(diskMtime)),
              expected: String(Math.round(expectedMtime)),
            }),
          );
        }
      }
      const updated = await writeNote(
        getRootPath(),
        existing.relPath,
        body,
        { title: title !== undefined ? title.trim() || undefined : undefined },
        { preserveExisting: true },
      );
      // audit-r124:writeNote 会把 frontmatter id 重钉为 computeFileId(relPath)
      //   (standalone.ts「副本重映射」规则)。若文件曾带外部 fm.id(手改 /
      //   拷贝导入 / 旧版本遗留),updated.id ≠ existing.id —— 旧实现只
      //   set 新键 + upsert 新行,不删旧键旧行:byId 留陈旧快照,resources
      //   表同 rel_path 出现双行(搜索命中死行 → 打开 NOT_FOUND)。收敛成
      //   renameFile 同款「先删旧再加新」,且 DB 旧行一并删。
      // audit-r155:DB 旧行 delete **不再 best-effort swallow** —— 失败
      //   时 byId 保持原状(chokidar 'change' 在 writeLock 释放后排队 →
      //   scheduleReload → scanNotes 重建 byId 把新 id 按新 relPath 入
      //   byId,自愈),但 throw 提示用户本次 write 失败,避免「磁盘已
      //   写 + byId 双键 + DB 双行 + 搜索命中死行」三态漂移。
      //   旧实现的 best-effort 注释自承「观测靠本条 error log」——
      //   实际上没有自愈路径(resync rel_path 差集不收此情况),error
      //   log 用户看不到,等于 silent corruption。
      if (updated.id !== existing.id) {
        try {
          deleteResource(noteResourceId(existing.id));
        } catch (err: unknown) {
          log.error('write id-repin: old row delete failed (chokidar will self-heal byId)', {
            relPath: existing.relPath,
            oldId: existing.id,
            newId: updated.id,
            err: errMsg(err),
          });
          throw new LibraryError(
            'IO_ERROR',
            tr('notes.idRepinDbSyncFailed', {
              oldId: existing.id,
              newId: updated.id,
              reason: errMsg(err),
            }),
          );
        }
        this.byId.delete(existing.id);
      }
      this.byId.set(updated.id, updated);
      const dbOk = this.syncResource(updated);
      // perf r239:打「自写」标记 —— watcher 的回声不再触发全量重扫
      //   (autosave 每 1.5s 一次,2000 篇实测每次白跑 410ms)。
      //   记的是**写完那一刻的文件指纹**(mtime+size+ino):回声事件到达时
      //   现 stat 一次比对,一样 ⇒ 还是我们写的那份 ⇒ 纯回声,抑制;
      //   不一样 ⇒ 文件被别人动过 ⇒ 照常重扫(外部改动永远可见)。
      //   **DB 同步失败时不打标记**:那条笔记的 resources 行还停在旧正文,
      //   必须靠 watcher 回声触发的全量 reload 来补(否则搜索永远搜不到
      //   新内容,直到下次外部改动 / 重启)。「DB 写失败」是罕见路径,
      //   为它多跑一次全量重扫是划算的。
      if (dbOk) {
        const abs = toNotePath(getRootPath(), updated.relPath);
        const fp = await this.fingerprintOf(abs);
        if (fp) this.selfWrites.mark(abs, fp);
      }
      // perf r239:写盘后的延迟复核 —— 「我写完之后这个文件有没有被别人动过?」
      //   (watcher 可能整个吞掉一次外部改动,见 scheduleWriteVerify 注释)
      this.scheduleWriteVerify(toNotePath(getRootPath(), updated.relPath));
      this.emit('changed');
      return updated;
    });
  }

  async renameFile(id: string, newFilename: string): Promise<StandaloneNote> {
    return this.writeLock.run(async () => {
      const existing = this.byId.get(id);
      if (!existing) {
        throw new LibraryError('NOT_FOUND', tr('notes.notFound', { id }));
      }
      const updated = await renameNote(getRootPath(), existing.relPath, newFilename);
      // audit-r151:DB tx 在 byId mutation 之前 —— 原实现在 IPC handler 跑
      //   renameResource(此时 writeLock 已释放),DB tx 失败时 byId 已更新,
      //   出现 disk 新文件 + byId 新 id + DB 旧 row + FTS 旧行的三态漂移。
      //   现在 renameResource 与 renameNote 同 writeLock 内,DB 失败 → byId 不变;
      //   chokidar 'unlink' (old) + 'add' (new) 在 writeLock 释放后排队 →
      //   scheduleReload → scanNotes 重建 byId,把 disk 上的新文件按新
      //   relPath 入 byId。Self-healing,无需 user 介入。
      //   列形态走 noteResourceOf(同 syncResource 共用一套资源字段推导)。
      //
      // r196:DB tx + byId 换键抽成 applyNoteIdSwap —— 原来 renameFile /
      //   moveFile 两处逐字重复(只有 log 文案与 i18n key 不同),改一边
      //   漏另一边 = 「重命名同步了 DB,搬移没同步」这类漂移。
      await this.applyNoteIdSwap(id, updated, 'DB rename failed for note', 'notes.renameDbSyncFailed');
      this.emit('changed');
      return updated;
    });
  }

  // r161+ disk-folder Phase 2b:跨文件夹移动笔记。结构与 renameFile 同款
  //   (writeLock + standalone + renameResource in same lock + byId mutation
  //   + emit),差异:targetRelPath 是「目标目录」相对路径('' = 根 / 'foo' /
  //   'foo/bar'),newRelPath = ${targetRelPath}/${basename(oldRelPath)}。
  //
  // 时序不变量(承 r155 H1 / r151 同款):disk rename → DB tx → byId mutation
  //   三步全在 writeLock 内。DB 失败 throw IO_ERROR + byId 旧键保留 +
  //   chokidar 'unlink'(old) + 'add'(new) 在 writeLock 释放后排队 →
  //   scheduleReload → scanNotes 重建 byId 把新 id 按新 relPath 入 byId
  //   自愈。失败路径无三态漂移(disk 新文件 + byId 新 id + DB 旧 row 三态
  //   错位 不会发生,因为 DB tx 在 byId mutation 之前抛)。
  async moveFile(
    id: string,
    targetRelPath: string,
  ): Promise<StandaloneNote> {
    return this.writeLock.run(async () => {
      const existing = this.byId.get(id);
      if (!existing) {
        throw new LibraryError('NOT_FOUND', tr('notes.notFound', { id }));
      }
      const updated = await moveNoteAcrossFolders(
        getRootPath(),
        existing.relPath,
        targetRelPath,
      );
      // r196:同 renameFile —— 走同一份 applyNoteIdSwap(时序不变量单点化)。
      await this.applyNoteIdSwap(id, updated, 'DB move failed for note', 'notes.idRepinDbSyncFailed');
      this.emit('changed');
      return updated;
    });
  }

  /**
   * r173:跨父目录搬移整个笔记文件夹(子树)。
   *
   * 场景:侧栏「剪切文件夹 → 粘贴到别的目录」「把文件夹拖到别的目录」
   *   「移到根目录」—— 三条入口此前全是 throw「not yet supported」的
   *   占位(UI 菜单项可见、点了必报错)。
   *
   * 与 moveFile(单文件)的差异:
   *   - 搬的是整棵子树:fs.rename 一次(目录里的非 .md 文件也带走,
   *     不静默丢弃用户文件);
   *   - 子树里**每个** .md 的 id 都要重钉(笔记 id = SHA-256(relPath),
   *     路径变 → id 变)⇒ 逐个 repinNoteId + renameResource + byId 换键;
   *   - 返回 idRemap(oldId → newId)给 renderer 把选中态跟到新 id。
   *
   * 时序不变量(同 moveFile):disk rename → DB tx → byId mutation 三步
   *   全在 writeLock 内;DB 失败 throw(byId 保持旧键),后续 chokidar
   *   'unlink'+'add' 触发 reload 自愈。
   */
  async moveDir(
    oldRelPath: string,
    targetRelPath: string,
  ): Promise<FolderMoveResult> {
    return this.writeLock.run(async () => {
      // 子树里的笔记(byId 索引)—— 必须在 fs 搬家**之前**取快照:
      // 搬完之后 byId 里的 relPath 已是新路径,没法再算「旧前缀」。
      const affected = this.subtreeNotes(oldRelPath);
      const newRelPath = await this.withWatcherReleased(() =>
        moveNoteDirAcrossFolders(getRootPath(), oldRelPath, targetRelPath),
      );
      if (newRelPath === oldRelPath) {
        // 同位置 → no-op,没有 id 变化
        return { relPath: newRelPath, idRemap: [] };
      }
      const idRemap = await this.repinSubtree(
        affected,
        oldRelPath,
        newRelPath,
        'DB dir-move failed for note',
      );
      this.emit('changed');
      return { relPath: newRelPath, idRemap };
    });
  }

  /**
   * r175:重命名笔记文件夹(子树)。
   *
   * 场景:侧栏右键「重命名」文件夹。
   *
   * 为什么必须走 service(而不是 IPC 层裸 fs.rename):
   *   笔记 id 与路径强绑定(fm.id = SHA-256(relPath) 前 16 位)。重命名
   *   目录 ⇒ 子树里每个 .md 的 relPath 都变 ⇒ id 全变。旧实现只搬目录:
   *   - 文件里的 fm.id 还是旧路径的哈希。下一次 writeNote 无条件
   *     重烧 `id: computeFileId(relPath)` ⇒ id **突变** ⇒ renderer 手里
   *     的 id 变死 id ⇒ 之后每次保存都 NOT_FOUND,用户新敲的字困在
   *     死 id 草稿里(重启即丢)—— 真实数据丢失路径;
   *   - DB 的 rel_path 停在旧路径,搜索命中的路径信息是旧的。
   *   本方法把「物理搬家 + 逐个重钉 id + DB rename + byId 换键」收进
   *   writeLock,与 moveDir 同款时序不变量。
   *
   * 返回 idRemap(oldId → newId)给 renderer 把选中态跟到新 id。
   */
  async renameDir(
    oldRelPath: string,
    newRelPath: string,
  ): Promise<FolderMoveResult> {
    return this.writeLock.run(async () => {
      // 同 moveDir:先取子树快照,再动磁盘。
      const affected = this.subtreeNotes(oldRelPath);
      await this.withWatcherReleased(() =>
        renameNoteDir(getRootPath(), oldRelPath, newRelPath),
      );
      if (newRelPath === oldRelPath) {
        // 同名 → no-op,没有 id 变化
        return { relPath: newRelPath, idRemap: [] };
      }
      const idRemap = await this.repinSubtree(
        affected,
        oldRelPath,
        newRelPath,
        'DB dir-rename failed for note',
      );
      this.emit('changed');
      return { relPath: newRelPath, idRemap };
    });
  }

  /**
   * r196:单篇笔记的「DB 同步 + byId 换键」—— renameFile / moveFile 共用。
   *
   * 时序不变量(audit-r151 起,两条路径**必须**一致):
   *   1. disk 操作已在 writeLock 内完成;
   *   2. DB tx(renameResource)**先**于 byId mutation —— DB 失败就抛,
   *      byId 保持旧键,不会出现「disk 新文件 + byId 新 id + DB 旧 row」
   *      的三态漂移(chokidar 的 unlink+add 会在锁释放后触发 reload 自愈);
   *   3. byId 换键:relPath 变 → id 变 ⇒ 先删旧 id 再加新 id。
   *
   * @param logLabel log.error 的首参(区分是 rename 还是 move)
   * @param errKey   抛给 IPC 的 i18n key(reason 由 errMsg 填)
   */
  private async applyNoteIdSwap(
    oldId: string,
    updated: StandaloneNote,
    logLabel: string,
    errKey: string,
  ): Promise<void> {
    try {
      renameResource(
        noteResourceId(oldId),
        this.noteResourceOf(updated),
        updated.body,
        toNotePath(getRootPath(), updated.relPath),
      );
    } catch (err: unknown) {
      log.error(logLabel, updated.relPath, errMsg(err));
      throw new LibraryError('IO_ERROR', tr(errKey, { reason: errMsg(err) }));
    }
    this.byId.delete(oldId);
    this.byId.set(updated.id, updated);
  }

  /**
   * r196:子树里的笔记(byId 索引)—— relPath 以 `oldRelPath/` 开头。
   * 目录内相对路径 = relPath 去掉 oldRelPath 前缀(见 repinSubtree)。
   */
  private subtreeNotes(oldRelPath: string): StandaloneNote[] {
    const prefix = `${oldRelPath}/`;
    return Array.from(this.byId.values()).filter((n) => n.relPath.startsWith(prefix));
  }

  /**
   * r196:子树 id 重钉 —— 目录搬移 / 改名后,子树里每个 .md 的 relPath 变了
   * ⇒ 笔记 id(= SHA-256(relPath) 前 16 位)全变 ⇒ 逐个:
   *   repinNoteId(重写 frontmatter id)→ DB rename → byId 换键。
   *
   * moveDir / renameDir 共用这一份 —— 原来两个方法把这 20 行逐字抄了两遍
   * (只差 log 文案),改一边漏另一边 = 「搬移重钉了 id、改名没重钉」⇒
   * 子树里的笔记下次保存必 id 漂移(r192 同款数据丢失路径)。
   *
   * @param affected 搬家**之前**取好的子树笔记快照(旧 relPath)
   */
  private async repinSubtree(
    affected: StandaloneNote[],
    oldRelPath: string,
    newRelPath: string,
    logLabel: string,
  ): Promise<FolderMoveResult['idRemap']> {
    const idRemap: FolderMoveResult['idRemap'] = [];
    for (const n of affected) {
      // 'a/b/n.md' 搬到 'x/a' → 'x/a/b/n.md'(保留目录内层级)
      const newNoteRelPath = newRelPath + n.relPath.slice(oldRelPath.length);
      const updated = await repinNoteId(getRootPath(), newNoteRelPath);
      await this.applyNoteIdSwap(n.id, updated, logLabel, 'notes.idRepinDbSyncFailed');
      idRemap.push({ oldId: n.id, newId: updated.id, relPath: updated.relPath });
    }
    return idRemap;
  }

  /** 删除改走系统回收站(electron shell.trashItem,经 safeTrash),用户可恢复。
   * 时序不变量:findById → onBeforeTrash → trashItem → byId.delete → onAfterTrash → emit */
  async trash(
    id: string,
    // hook 拆成 beforeTrash + afterTrash — DB sync 需「删除之前/之后」做事。
    // DB delete 走 onAfterTrash:之前 onBeforeTrash 顺序在删除失败(EPERM / OneDrive
    // sync lock / AV 扫描)时留「DB 永久 stale, 文件还在」鬼影 —— 改后删除失败时
    // byId/DB/文件三态一致,user 重试即可;成功但 DB delete 失败是罕见 stale row,
    // 下次 chokidar reload 或重命名时刷新
    onBeforeTrash?: (note: StandaloneNote) => void | Promise<void>,
    onAfterTrash?: (note: StandaloneNote) => void | Promise<void>,
  ): Promise<void> {
    return this.writeLock.run(async () => {
      const existing = this.byId.get(id);
      if (!existing) {
        throw new LibraryError('NOT_FOUND', tr('notes.notFound', { id }));
      }
      if (onBeforeTrash) await onBeforeTrash(existing);
      const absPath = join(getRootPath(), WORKSPACE_DATA_LAYOUT.NOTES_DIR, existing.relPath);
      // safeTrash 与旧 safeUnlink 同款契约:文件已不存在吞 ENOENT 当作成功,
      // 其他错误冒泡 —— 差异是删除进系统回收站
      await safeTrash(absPath);
      this.byId.delete(id);
      if (onAfterTrash) await onAfterTrash(existing);
      this.emit('changed');
    });
  }

  // findBySource / readNoteForSource / writeNoteForSource / removeBySource 已下线
  // —— per-file notes 退役后 NotesService 不维护 source 桥接;AI 模块 V1.6 下线后
  // 只剩独立 notes/*.md 一条路径

  // 「删单条 db-only 行」的独立 API 已下线(audit-r124):唯一消费链路(用户
  //   决策 modal)从未接线,现由 resyncIfNeeded 就地清理取代。未来若真要做
  //   「保留磁盘文件、只删索引行」的 UI 功能,参照 trash / write 的
  //   byId+DB 双清形态重建即可。

  /** 启动期 disk ↔ DB 差集:disk-only 走 parseNoteFile + upsertResource 补齐;
   * db-only(磁盘文件已外部消失)audit-r124 起**就地清理** DB 行 + byId。
   * 文件已不在、行只是镜像,删除属状态同步而非数据销毁。
   * 走 writeLock 与 write/rename/trash/reload 同队列串行;started 守卫对齐 reload
   *
   * audit-r156:旧「写 settings.notesResyncPending 让 renderer modal 决定」链路
   *   从未接线(settings 字段、preload 推听、renderer 组件全 0 caller),整链路
   *   一并删除;ghost 行清理自 audit-r124 起即由本方法就地完成,与 settings
   *   字段存在与否无关。 */
  async resyncIfNeeded(): Promise<{ inserted: number; dbOnlyIds: string[] }> {
    if (!this.started) return { inserted: 0, dbOnlyIds: [] };
    return this.writeLock.run(async () => {
      if (!this.started) return { inserted: 0, dbOnlyIds: [] };
      const root = getRootPath();
      const notesDir = join(root, WORKSPACE_DATA_LAYOUT.NOTES_DIR);
      await fs.mkdir(notesDir, { recursive: true });

      // 收集 disk rel_path(只扫 readdir,不 parse)
      const filePaths: string[] = [];
      await collectNotePaths(notesDir, notesDir, filePaths);
      const diskRelSet = new Set(filePaths.map((full) => toPosix(relative(notesDir, full))));
      const dbRelSet = new Set(listResourceRelPaths('note'));

      // disk-only → parse + upsertResource + 加 byId(resources_fts 索引 body,
      // 插入天然带全文)
      const diskOnly = [...diskRelSet].filter((p) => !dbRelSet.has(p));
      let inserted = 0;
      for (const rel of diskOnly) {
        const full = join(notesDir, rel);
        try {
          const note = await parseNoteFile(notesDir, full);
          if (!note) continue;
          upsertResource(this.noteResourceOf(note), note.body, full);
          this.byId.set(note.id, note);
          inserted++;
        } catch (err) {
          log.warn('resync insert failed', rel, errMsg(err));
        }
      }
      if (inserted > 0) this.emit('changed');

      // 0005 迁移标记消费:indexed_at=0 的 note 行(老库升级 FTS 只有 title 种子)
      // 重读磁盘回填 body。回填走 syncResource → upsertResource 一次性;
      // db-only 行(byId 里没有)跳过 —— 它们在下方 ghost 清理里整行删除
      let reindexed = 0;
      for (const rid of listStaleIndexIds('note')) {
        const note = this.byId.get(parseResourceId(rid).raw);
        if (!note) continue;
        this.syncResource(note);
        reindexed++;
      }
      if (reindexed > 0) log.info('stale-index backfill done', { reindexed });

      // db-only = 磁盘文件已外部消失 → ghost 行就地清理(audit-r124)。
      //   逐行按 rel_path 命中删除 —— 行的 raw id 可能是 fm.id /
      //   computeFileId / 历史形态,id 不可靠,rel_path 才是全形态覆盖的
      //   判定键。
      //   ⚠ r209:**不能只信 diskRelSet**。collectNotePaths 对单个子目录的
      //   readdir 失败是「log warn 后只丢这一支」的(standalone.ts 的
      //   per-branch try/catch),失败时 diskRelSet 缺的**是一整棵子树**,
      //   而不是「这些文件真被删了」。旧注释写的「扫描 throw 会让整个
      //   resync reject,不会带着残缺 diskRelSet 进删除分支」**不成立**
      //   (collectNotePaths 从不 throw)⇒ 子树里的笔记会被整片判成 ghost
      //   删掉:文件还在磁盘上,索引行却没了 ⇒ 列表 / 搜索里消失,而且
      //   本轮不会补回(插入阶段先于删除阶段跑,且它也看不见这些文件)。
      //   修法 = 与同文件运行期路径 syncDbWithDisk(r180)的**双重守卫**对齐:
      //   diskRelSet 之外再用「文件是不是真的没了」兜一次。
      //   路径用**当前 root** 重建而不是 DB 里的 abs_path(ADR-0003:
      //   rootPath 迁移后 abs_path 会过期,照它判会误删仍存在的笔记)。
      const dbOnlyRel = [...dbRelSet].filter((p) => !diskRelSet.has(p));
      let dropped = 0;
      if (dbOnlyRel.length > 0) {
        const dbOnlySet = new Set(dbOnlyRel);
        for (const r of listResources('note')) {
          // listResources 签名返回 Resource[] 联合 —— note 行必带 relPath、
          // literature 行不带,TS 需 kind 窄化(audit-r124:tsc 抓到裸 r.relPath)
          if (r.kind !== 'note' || !dbOnlySet.has(r.relPath)) continue;
          // 兜底:文件其实还在磁盘上 —— collectNotePaths 的盲区(子目录
          // readdir 失败 / 深度 > 16 / symlink 目标)会让 diskRelSet 缺一块,
          // 没有这道守卫就会把「还在的笔记」判成 ghost 删掉。
          if (!(await isReallyGone(join(notesDir, r.relPath)))) continue;
          deleteResource(r.id);
          dropped++;
          const raw = parseResourceId(r.id).raw;
          if (this.byId.delete(raw)) this.emit('changed');
        }
        log.info('Notes resync: dropped ghost rows of externally deleted notes', { dropped });
      }
      // 返回形状保留 { inserted, dbOnlyIds }:唯一消费方是 startup 观测日志;
      //   r124 起它不是「待决定」清单,而是本轮已清理行的 id 快照(legacy id
      //   推导保留仅为形状兼容,数值不再代表待处理项)
      const dbOnlyIds = dbOnlyRel.map((rel) => computeFileId(rel));
      return { inserted, dbOnlyIds };
    });
  }

  /**
   * perf r239(2026-10-21):带路径的 reload 调度。
   *
   * @param path 触发本次调度的事件路径(chokidar 的 file 事件带 path)。
   *   undefined = 目录级事件(addDir / unlinkDir)或显式 reload —— 一律走
   *   全量重扫。
   *
   * **自写回声短路**:文件级事件先 stat 一次拿指纹,与「我写完时记下的
   * 指纹」比对 —— 一样 ⇒ 这个事件只是我自己的写盘回声 ⇒ 直接返回,
   * 不排 reload。理由(详见 utils/self-write-echo.ts):
   *   write() 自己已经做完 byId.set + syncResource(DB/FTS) + emit('changed'),
   *   watcher 的回声只是把同样的状态**重新从磁盘读一遍**(2000 篇实测 410ms,
   *   而触发条件只是「用户停下来打字 1.5 秒」)。
   *
   *   指纹不同 ⇒ 文件**被别人动过** ⇒ 照常重扫。早期实现用「1 秒时间
   *   窗口」,结果窗口内的外部改动被一起吞掉(用户 autosave 后 1 秒内
   *   又用 Obsidian 改了同一个文件 ⇒ 那次改动永远不可见)—— 指纹判据
   *   没有这个洞。
   */
  private scheduleReload(path?: string): void {
    // stop 期间 started=false bail:防 watcher close 期间 fire 事件创建新 timer,
    // 绕过 stop() 的 clearTimeout,在 byId.clear() 之后又 populate 回数据
    // 重新计时而不早返回:chokidar 一次写盘会触发 add/change 多事件,
    // 「已有 timer 就 return」会把窗口内的增量信号吞掉
    if (!this.started) return;
    if (path === undefined) {
      this.armReload();
      return;
    }
    // 文件级事件:先 stat 再判(异步)。stat 失败(文件已被删 = unlink 事件)
    //   ⇒ 不是自写回声 ⇒ 照常重扫。
    void this.maybeSelfEcho(path).then((isEcho) => {
      if (isEcho) {
        log.debug('skip reload for self-write echo', { path });
        return;
      }
      this.armReload();
    });
  }

  /**
   * perf r239:写盘后的**延迟复核** —— 「我写完之后,这个文件有没有被别人动过?」
   *
   * 为什么需要:自写回声抑制只在「事件到达时文件指纹 == 我们写完时的指纹」
   *   时成立。但 watcher 的事件流**可能整个吞掉**一次外部改动 —— 最典型的
   *   就是「app 写盘后 1ms 内外部把文件删了」:chokidar 的 awaitWriteFinish
   *   还在等这个文件「大小稳定 50ms」,文件却先没了 ⇒ chokidar 认为
   *   「那个待上报的写没了」,**既不发 'change' 也不发 'unlink'** ⇒
   *   外部删除彻底不可见(实测:机器繁忙时必现,空闲时偶现)。
   *
   * 复核 = 写盘后 ECHO_VERIFY_DELAY_MS 再 stat 一次,重跑一次「是不是
   *   自写回声」的判断:
   *     指纹仍相同 ⇒ 文件确实还是我们写的那份 ⇒ 真的没有外部改动。
   *     指纹变了 / 文件没了 ⇒ 外部动过 ⇒ 照常重扫。
   *   ⇒ 抑制从「赌事件不会丢」变成「丢了也能补回来」。
   *
   * 为什么挂在**写盘**上而不是挂在「收到回声事件」上:事件可能根本不来
   *   (上面那个吞事件的场景)⇒ 挂在事件上的复核永远不会触发。
   *
   * 代价:每次 autosave 多 1 个 timer + 1 次 stat(约 0.1ms)——
   *   相对省下的 410ms 全量重扫可以忽略。
   */
  private scheduleWriteVerify(path: string): void {
    const existing = this.echoVerifyTimers.get(path);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.echoVerifyTimers.delete(path);
      if (!this.started) return;
      void this.maybeSelfEcho(path).then((stillEcho) => {
        if (stillEcho) return; // 文件还是我们写的那份 ⇒ 确实没有外部改动
        log.info('External change detected after self-write', { path });
        this.armReload();
      });
    }, ECHO_VERIFY_DELAY_MS);
    this.echoVerifyTimers.set(path, timer);
  }

  /**
   * 判断某个文件级 watcher 事件是不是「我自己写出来的回声」。
   * 判据 = 当前文件指纹 vs 写盘时记下的指纹(见 utils/self-write-echo.ts)。
   */
  private async maybeSelfEcho(path: string): Promise<boolean> {
    const fp = await this.fingerprintOf(path);
    if (!fp) return false;
    return this.selfWrites.isSelfEcho(path, fp);
  }

  /** 拿一个路径的文件指纹;文件不存在 / 读不到 ⇒ null。 */
  private async fingerprintOf(absPath: string): Promise<FileFingerprint | null> {
    try {
      const st = await fs.stat(absPath);
      return fileFingerprint(st);
    } catch {
      return null;
    }
  }

  /** 真正排一次防抖 reload(RELOAD_DEBOUNCE_MS)。 */
  private armReload(): void {
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

  private async reload(): Promise<void> {
    // reload 必须走 writeLock:之前直接换 this.byId 与并发 write/rename/trash
    // 产生 race(T0 reload 启动 scanNotes → T1 write 进入 writeLock → T2 write
    // 完成 set(old byId) → T3 reload 完成 next 不含 write → T4 next 覆盖 write),
    // fix:reload 走 writeLock 串行化,与 write/rename/trash 同队列
    // 加 started 守卫:timer fire 与 stop() 之间的 race(timer 入队时 started 还是
    // true,stop() clearTimeout 但 writeLock 已 queue reload,reload 完成 byId = next
    // 后 stop() 清 byId 已被覆盖),reload 内部再次检 started 拒绝 rebuild byId
    if (!this.started) return;
    return this.writeLock.run(async () => {
      if (!this.started) return;
      // audit-r223:dirsOut —— emit 指纹的目录维度(见下方指纹块)。
      const diskDirs: string[] = [];
      // perf r255:body 字节数由解析缓存给出(稳态零计算)—— 见
      //   standalone.ts 的 NoteParseCacheEntry.bodyBytes 头注。
      const bodyBytes = new Map<string, number>();
      // perf r255:本轮的磁盘路径集 —— syncDbWithDisk 原先**又走一遍**
      //   目录树来算同一个东西(实测 2000 篇 / 20 子目录 ≈ 4.4ms 一遍)。
      const diskPaths: string[] = [];
      const notes = await scanNotes(getRootPath(), {
        dirsOut: diskDirs,
        bodyBytesOut: bodyBytes,
        pathsOut: diskPaths,
      });
      const next = new Map<string, StandaloneNote>();
      for (const n of notes) {
        next.set(n.id, n);
      }
      this.byId = next;
      // audit-r223:emit 幂等指纹,镜像 literature r136 M1 —— 旧实现**无条件**
      //   emit('changed'):chokidar 对 no-op 触碰(同步盘周期 touch mtime 后
      //   又改回 / 元数据抖动)也触发 scheduleReload → emit ⇒ renderer 每次
      //   都全量 listNotes + setState(100+ 行重渲),内容其实一个字没变。
      //   指纹 = 每篇的 (id, mtime, size)(size = body UTF-8 字节数,与
      //   noteResourceOf 同算法;r211/r220 的双因子口径:「内容变但 mtime
      //   保留」只看 mtime 会判「没变」)+ **目录集**(r215 的教训:空文件夹
      //   增/删/改名不改变任何文件行,只看文件指纹会把目录结构变化判成
      //   「没变」⇒ 左侧栏文件夹树与磁盘对不上;r184 起 notes 的 watcher
      //   就监听 addDir/unlinkDir,指纹必须接住这一类)。目录用相对
      //   notesDir 的 POSIX relPath(换根 / ADR-0003 后绝对路径全变,会刷
      //   出一次假指纹差),排序保证跨 reload 稳定。
      //   「同长不同文 + mtime 保留」是双因子已接受的盲区(与 literature
      //   同款)。
      //   perf r255:表示换成 Map 逐项比对(判定语义不变,见 lastEmitNotes
      //   头注)—— 旧实现的「2000 次字符串拼接 + 排序 + join」是纯开销。
      //   注意:指纹只管 emit;下方 syncDbWithDisk **无条件跑** —— DB 自愈
      //   (stale 回填 / ghost 清理)不依赖 renderer 是否需要刷新。
      const root = getRootPath();
      const notesDir = join(root, WORKSPACE_DATA_LAYOUT.NOTES_DIR);
      const dirSig = diskDirs
        .map((d) => toPosix(relative(notesDir, d)))
        .sort()
        .join(',');
      const noteState = new Map<string, { mtime: number; bytes: number }>();
      for (const n of notes) {
        noteState.set(n.id, { mtime: n.mtime, bytes: bodyBytesOf(n, bodyBytes) });
      }
      const unchanged =
        sameNoteState(this.lastEmitNotes, noteState) && dirSig === this.lastEmitDirs;
      this.lastEmitNotes = noteState;
      this.lastEmitDirs = dirSig;
      if (!unchanged) {
        this.emit('changed');
      }
      // r180:内存索引重建完还要把 DB 拉齐 —— 见 syncDbWithDisk 头注
      await this.syncDbWithDisk(root, notes, diskPaths, bodyBytes);
    });
  }

  /**
   * r180:reload 期 disk ↔ DB 差集(**与 literature 域 r136 对齐**)。
   *
   * 旧实现:reload() 只重建内存 byId,**从不碰 DB** —— 于是会话运行期间
   * 三件事让「侧栏列表」与「磁盘文件夹」对不上:
   *   1. 用户从 OS 拖进 <rootPath>/notes/ 的 .md:侧栏能看见(列表跟磁盘
   *      一致),但 resources 表里**没有这一行** ⇒ 全局搜索 / FTS 永远搜不到;
   *   2. 用户用外部编辑器改过的 .md:侧栏标题是新的,DB 里的 body 还是旧的
   *      ⇒ 搜索命中旧正文,正文与文件内容不一致;
   *   3. 用户在 OS 删掉的 .md:DB 留下 ghost 行 ⇒ 搜索还能搜到一篇磁盘上
   *      已经不存在的东西(点进去 NOT_FOUND)。
   * literature 域每次 reload 都做这个差集(r136),两个域行为相反 —— 这正是
   * 用户报「文献和笔记列表应该和对应的文件夹完全一致」里最刺眼的一条。
   *
   * 差集键用 rel_path(不是 id):id 会随目录改名(r179)/去重消解(r80)变,
   * rel_path 才是覆盖全生命周期的判定键(与 resyncIfNeeded 同口径)。
   *
   * 差集方向:
   *   - disk-only / 内容变 / id 变 → upsert(带 body ⇒ FTS 同步刷新);
   *   - db-only(磁盘已无此文件)  → ghost 行清理(行只是镜像,文件才是数据;
   *     删除属状态同步,不是数据销毁 —— 与 r124 启动期口径一致)。
   */
  private async syncDbWithDisk(
    root: string,
    notes: StandaloneNote[],
    diskPaths: string[],
    bodyBytes: Map<string, number>,
  ): Promise<void> {
    const notesDir = join(root, WORKSPACE_DATA_LAYOUT.NOTES_DIR);
    // disk 侧权威路径集:**文件在磁盘上就算数** —— 解析失败的笔记(超大 /
    // 坏 frontmatter)也必须留在集合里,否则它的 DB 行会被误判成 ghost
    // 删掉(文件还在,只是读不出来)。
    //
    // perf r255:路径集由 scanNotes **顺手**带出来 —— 旧实现在这里**又走
    //   一遍** collectNotePaths(与扫描期那次逐字相同的调用),同一轮 reload
    //   走两遍同样的树(实测 2000 篇 / 20 子目录 ≈ 4.4ms 一遍)。
    //   语义差异只有一处,且是**更安全**的方向:现在两个口径来自同一次
    //   walk ⇒ 「本轮解析出来的笔记」与「本轮看到的文件」严格一致(旧实现
    //   两次 walk 之间磁盘若变了,两边会各说各话)。唯一可见差别:walk 之后
    //   才被删掉的文件,它的 DB 行本轮不清(下一轮 reload 清)—— 下一轮
    //   reload 由该次 unlink 事件触发,不会久留。
    const diskRelSet = new Set(diskPaths.map((full) => toPosix(relative(notesDir, full))));

    const dbRows = listResources('note');
    const rowsByRel = new Map<string, (typeof dbRows)[number]>();
    for (const r of dbRows) {
      // listResources 签名返回 Resource 联合 —— note 行必带 relPath,
      // literature 行不带,TS 需 kind 窄化(audit-r124 同款坑)
      if (r.kind !== 'note') continue;
      if (!rowsByRel.has(r.relPath)) rowsByRel.set(r.relPath, r);
    }

    // 本轮所有笔记的「应有 id」集合 —— 用于「旧行是否已被别人占用」的守卫
    const wantIds = new Set<string>();
    for (const n of notes) wantIds.add(noteResourceId(n.id));

    let upserted = 0;
    for (const n of notes) {
      const row = rowsByRel.get(n.relPath);
      const wantId = noteResourceId(n.id);
      // 无变化(id 同 + mtime 同 + size 同 + FTS body 已填)→ 跳过:reload
      // 是 100ms 防抖的高频路径,不能每次都全量重写 DB。
      // r220:mtime + size 双因子(对齐 literature r212 口径)—— 「内容变
      //   但 mtime 保留」(备份还原 / cp -p / 同步盘按内容去重)只看 mtime
      //   会判「没变」⇒ FTS 永久停在旧正文,全文搜索搜不到新内容。
      //   size = body 的 UTF-8 字节数(与 noteResourceOf 同一算法),body
      //   本来就在内存里,成本可忽略;「同长不同文 + mtime 保留」仍是
      //   双因子已接受的盲区(与 literature 同款,要兜只能全文 hash)。
      // perf r255:字节数取自解析缓存(稳态零计算)—— 口径与上面完全
      //   相同(同一个 Buffer.byteLength(body,'utf8')),只是算一次、复用。
      if (
        row &&
        row.id === wantId &&
        row.mtime === n.mtime &&
        row.size === bodyBytesOf(n, bodyBytes) &&
        row.indexedAt !== 0
      ) continue;
      try {
        upsertResource(this.noteResourceOf(n), n.body, toNotePath(root, n.relPath));
        // 同 relPath 但 id 变了(外部改写 fm.id / r80 去重消解):旧行是陈旧
        // 镜像,删掉 —— 否则搜索里同一篇笔记出两行。旧 id 若已被本轮别的
        // 笔记占用(两个文件同 id 的去重场景)则不删,那是 upsert 冲突解决
        // 的活,交给 upsert 的 ON CONFLICT(rel_path 覆盖)收口。
        if (row && row.id !== wantId && !wantIds.has(row.id)) {
          deleteResource(row.id);
        }
        upserted++;
      } catch (err: unknown) {
        log.warn('reload db upsert failed', n.relPath, errMsg(err));
      }
    }

    // db-only:磁盘上已没有这个文件 → ghost 行清理。
    //   双重守卫(缺一不可):
    //     a) diskRelSet —— 常规判定;
    //     b) isReallyGone(当前 root 下的真实路径)—— 兜住 collectNotePaths
    //        的盲区(深度 > 16 的深层笔记、symlink 目标等)。路径用
    //        **当前 root 重建**而不是 DB 里的 abs_path —— ADR-0003
    //        rootPath 迁移后 abs_path 会过期,照它判会把仍存在的笔记
    //        误删(索引丢了,文件还在,但搜索再也搜不到)。
    //        r209:判据从 existsSync 换成 isReallyGone —— 前者把「读不到」
    //        也当成「没了」(EACCES / EBUSY 时会误删),后者只在 ENOENT 时
    //        判「没了」,其余错误 fail-safe 当作「还在」(与启动期路径同口径)。
    let dropped = 0;
    // perf r239:复用上面那份 dbRows,不再第二次 listResources('note') ——
    //   旧实现每次 reload 把**整表 note 行**物化两遍(2000 篇 = 2×2000 行
    //   的对象构造 + JSON 字段拷贝)。两次结果等价:中间发生的 upsert 只
    //   **新增**行,而新增行必然在 diskRelSet 里(它们来自本轮 notes),
    //   ghost 循环按 diskRelSet 判 ⇒ 不受新增行影响。
    for (const r of dbRows) {
      if (r.kind !== 'note') continue;
      if (diskRelSet.has(r.relPath)) continue;
      if (!(await isReallyGone(join(notesDir, r.relPath)))) continue;
      try {
        deleteResource(r.id);
        dropped++;
      } catch (err: unknown) {
        log.warn('reload db ghost delete failed', r.id, errMsg(err));
      }
    }

    if (upserted > 0 || dropped > 0) {
      log.info('Notes reload: db synced with disk', { upserted, dropped });
    }
  }
}

// 模块级单例
let _instance: NotesService | null = null;
export function getNotesService(): NotesService {
  if (!_instance) _instance = new NotesService();
  return _instance;
}
