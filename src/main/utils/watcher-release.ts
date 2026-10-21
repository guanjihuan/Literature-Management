// src/main/utils/watcher-release.ts
//
// r188:Windows 上「重命名 / 搬移一个**含子目录**的文件夹」必然 EPERM。
//
// 根因(本机实证,chokidar 4 + Windows 11):
//   chokidar 用 fs.watch(ReadDirectoryChangesW)递归监听目录树,对**每个**
//   被监听的目录持有一个 OS 句柄。Windows 拒绝重命名一个**内部存在打开
//   句柄**的目录 ⇒ 只要待搬动的目录里还有子目录(chokidar 正监听着它),
//   fs.rename 一定 EPERM。
//
//   四格对照实验(见本轮提交说明):
//     无 watcher + 扁平子结构  → rename OK
//     无 watcher + 含子目录    → rename OK
//     有 watcher + 扁平子结构  → rename OK
//     有 watcher + 含子目录    → rename **EPERM**
//
// 既有退避重试(retryOnWindowsTransient,5 次 / ~750ms)救不了:句柄是
// **长期**的(chokidar 一直在监听那个子目录),不是 Defender 那种瞬时占用。
// ⇒ 用户侧表现:侧栏右键「重命名」/「剪切→粘贴」一个含子文件夹的目录,
//   永远失败(notes 与 literature 两侧同病)。
//
// 修法:物理搬目录之前**关掉 watcher**(close 掉所有 FSWatcher ⇒ 释放
//   全部目录句柄),搬完再重建。
//   实测:close → rename → 重新 watch ⇒ rename 成功,且重建后的 watcher
//   仍能收到新位置里的文件变更(add 事件)⇒ 监听能力不丢。
//
// 为什么是「关整个 watcher」而不是 chokidar.unwatch(子树):
//   chokidar v4 的 unwatch 只 close **该路径自身**的 FSWatcher
//   (_closePath),**不**递归关子目录的 ⇒ 子目录句柄仍在 ⇒ 仍 EPERM。
//   (实测:unwatch(sub) 之后 rename 依旧 EPERM。)
import type { FSWatcher } from 'chokidar';
import { createLogger } from './logger';
import { errMsg } from './error';

const log = createLogger('watcher-release');

/** 服务侧钩子 —— 各 service 的 watcher 生命周期不同,由调用方给。 */
export interface WatcherReleaseHooks {
  /** 取当前 watcher;返回 null ⇒ 没有监听要释放,直接跑 fn。 */
  get: () => FSWatcher | null;
  /** 关掉之后把引用摘掉(避免 stop() 二次 close、身份判断误伤)。 */
  clear: () => void;
  /** 搬完之后重建 watcher(服务已 stop 时应自行跳过)。 */
  restart: () => void;
}

/**
 * r216:关掉 chokidar watcher,且不让「晚到的 awaitWriteFinish 轮询错误」
 * 炸主进程。
 *
 * 根因(chokidar 4.0.3 源码实证,node_modules/chokidar/index.js):
 *   - awaitWriteFinish 的轮询是 setTimeout 链(_awaitWriteFinish),挂在
 *     _pendingWrites 上,**不在** close() 的清理范围内(_closers 里只有
 *     FSWatcher 句柄,定时器没人 cancel);
 *   - close() 第一行就 removeAllListeners();
 *   - 轮询晚到时文件已被删/搬走 ⇒ fs.stat 报错;Windows 对 pending-delete
 *     路径报 **EPERM**(不是 ENOENT),而 chokidar 只容忍 ENOENT,其余错误
 *     走 awfEmit(err) ⇒ emit('error', err);
 *   - EventEmitter 对**无监听者**的 'error' 是同步 throw
 *     ⇒ 主进程 uncaught exception。
 *   三条现实路径都能撞上:应用退出 stop()、watcher 报错自动重启、
 *   withWatcherReleased 搬目录 —— 全都是「close 的正当时,被监听树里的
 *   文件正被删/被搬」。测试 teardown 删临时目录实测炸出 2 例。
 *
 * 修法:close **之后**在实例上补挂一个 noop 'error' 监听。实例已弃,监听
 * 无副作用,只给迟到事件一个去处。为什么挂在 close 之后而不是之前:
 * close() 自己会 removeAllListeners(),先挂会被它一起摘掉。await 的
 * continuation 在微任务里跑,fs.stat 回调是 macrotask,插不进 close()
 * 返回与补挂之间的窗口 ⇒ 无竞态。
 *
 * close 本身的失败**不吞**(finally 保证 noop 仍挂上),由调用方按各自
 * 语义 warn / 透传。
 */
// 行为锁:tests/unit/main/watcher-close-quiet.test.ts,摘掉 finally 里的 noop 补挂必红。
export async function closeWatcherQuietly(watcher: FSWatcher): Promise<void> {
  try {
    await watcher.close();
  } finally {
    watcher.on('error', () => {});
  }
}

/**
 * 在 fn 执行期间临时释放 chokidar 的目录句柄。
 *
 * 语义:
 *   - 没有 watcher → 直接跑 fn(测试环境 / watcher 未起);
 *   - fn 抛错 → 仍然重建 watcher(finally),不让监听永久消失;
 *   - close 失败 → 只 warn,不阻断搬家(句柄没释放也只是搬不动,
 *     错误会由 fn 自己抛出,语义更准)。
 */
export async function withWatcherReleased<T>(
  hooks: WatcherReleaseHooks,
  fn: () => Promise<T>,
): Promise<T> {
  const watcher = hooks.get();
  if (!watcher) return fn();
  hooks.clear();
  // 摘监听 → close 掉所有 FSWatcher ⇒ 释放 chokidar 持有的目录句柄。
  // closeWatcherQuietly(r216):搬目录正是「被监听树里的文件全部消失」的时刻,
  // 晚到的 awaitWriteFinish 轮询 stat 必报错 ⇒ 必须给迟到 error 留去处
  watcher.removeAllListeners();
  try {
    await closeWatcherQuietly(watcher);
  } catch (err: unknown) {
    log.warn('watcher close failed before directory move', { err: errMsg(err) });
  }
  try {
    return await fn();
  } finally {
    hooks.restart();
  }
}
