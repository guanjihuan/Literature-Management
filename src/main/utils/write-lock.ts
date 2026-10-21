// 写操作串行化锁:FIFO promise chain 实现
//
// audit C3R45 (2026-08-22):从 NotesService / CollectionsService / LibraryService
// 三处 verbatim 重复代码抽出。这三个 service 的 mutation 入口都需要把所有写操作
// 串行化,避免 read-modify-write 的 lost-update 与 scan 期间用户改 metadata
// 被 worker 覆盖。原先每个 service 都自带:
//   private writeLock: Promise<unknown> = Promise.resolve();
//   private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> { ... 12 行 }
// 共 36 行 100% 重复,且任何 service 改了锁实现,其他两个不会跟着改 —— 容易漂移。
//
// 抽到 util 后的好处:
//   1. 单点改动,所有 service 行为一致(FIFO + finally release)
//   2. 测试覆盖一次,所有 service 受益
//   3. 新加 mutation service 时不用再抄一遍
//
// 实现要点(必须保留的 invariant):
//   - **FIFO**:const prev = this.chain 捕获当前链尾,await prev 后才执行 fn
//   - **finally 必调 release**:一次抛错如果不调 release,后续所有 run() 永远等不到
//     —— 锁永久死锁,这种 bug 比丢更新还严重(不会自然恢复,需重启)
//   - **try { await fn() } 不重试**:锁只负责串行化,fn 内部抛错让 caller 处理
//     (业务层可能需要 retry / idempotent 等不同策略,锁不应该替你决定)
//
// audit r51 (2026-10-15):加 `maxQueue` 上限 —— 默认 16 是经验值(远高于任何
//   真实场景的瞬时并发,典型 1-3);超过时同步抛 AppError('BACK_PRESSURE') 让
//   caller 立即拒绝,**不**阻塞返回。深度检查放在 `run()` 入口处(同步 throw),
//   而**不是**放进 promise chain —— 否则在 async caller 里会被吞成 rejected
//   promise,IPC 层 wrap.ts 把它转 INTERNAL 走 INTERNAL 兜底,用户看到通用
//   「internal error」而非「系统繁忙,稍后重试」。同步 throw 让 catch + IPC
//   透传链全保。
import { AppError } from './error';

// 默认队列上限 = 16:远超真实瞬时并发(典型 1-3),给慢 mutation / 锁等待留余量。
// 调小会让正常压力测试红,调大会让「锁积压」的诊断信号消失。
export const WRITE_LOCK_DEFAULT_MAX_QUEUE = 16;

export class WriteLock {
  private chain: Promise<unknown> = Promise.resolve();
  // 当前 in-flight + pending 任务数。`run()` 入口先 ++,`finally` 里 --。
  // 0 = 空闲,> 0 = 有任务跑着或排队中。
  private depth = 0;

  /**
   * @param maxQueue 队列上限(含 in-flight + pending)。超过时 `run()` 同步抛
   *                 AppError('BACK_PRESSURE')。默认 16(见上方常量)。
   */
  constructor(private readonly maxQueue: number = WRITE_LOCK_DEFAULT_MAX_QUEUE) {}

  /**
   * 把 fn 排队到当前锁链尾执行。返回 fn 的 resolved value;
   * 若 fn 抛错,错误透传给 caller,锁链照常推进(后续 run 不会被死锁)。
   *
   * 用法:
   *   private writeLock = new WriteLock();
   *   async create(x: T): Promise<T> {
   *     return this.writeLock.run(async () => { ... mutation body ... });
   *   }
   *
   * 抛出条件:`depth >= maxQueue` 时**同步**抛 AppError('BACK_PRESSURE')。
   *   同步(而非 queue 成 rejected)是因为 async caller 中同步 throw 会立即冒泡
   *   到 wrap.ts catch → 转成 { ok: false, code: 'BACK_PRESSURE', ... };
   *   若改成 `queue 一个 rejected promise` 会被 caller 的 await 吞掉 → IPC
   *   层 wrap.ts 看见的是 fn 返回的 promise → 进 chain.then() 失败 → 转
   *   INTERNAL(user 看到「internal error」而非「系统繁忙」)。
   *
   * **实现注意**:本函数**不是** async,只返回 Promise。原因是 JS 规则:
   *   async 函数体里所有 throw(即便是第一个 await 之前的 sync throw)都会被
   *   包成 rejected promise 返回,caller 的 try/catch 接不住 —— BACK_PRESSURE
   *   信号就这样被「async 化」消失,IPC handler catch 里只能看到
   *   `Promise<unknown> rejection`,wrap.ts 走 INTERNAL 兜底分支。
   *   所以本签名是 sync 函数 + 内部用 IIFE async 包装锁链逻辑,实现「入口同步
   *   throw,后续异步等待」的混合行为。
   */
  run<T>(fn: () => Promise<T>): Promise<T> {
    // 深度上限检查必须**在**任何状态变更前 —— 否则 ++ 之后再抛,depth 永远
    // 比真实排队多 1,「队列已满」信号被自己吃掉。
    if (this.depth >= this.maxQueue) {
      throw new AppError(
        'BACK_PRESSURE',
        `writeLock overflow: depth=${this.depth} >= maxQueue=${this.maxQueue}`,
      );
    }
    this.depth++;
    const prev = this.chain;
    let release: (v: unknown) => void = () => {};
    this.chain = new Promise<unknown>((r) => {
      release = r;
    });
    // IIFE async:把「await prev + try fn + finally release」包成内层 async,
    // 让 lock 链调度与 fn 错误处理走 try/finally 语义;外层 run() 是普通函数
    // → 入口 throw 同 warp 立即冒泡。
    return (async () => {
      try {
        await prev;
        return await fn();
      } finally {
        this.depth--;
        release(undefined);
      }
    })();
  }

  /**
   * 等待当前锁链彻底排空(所有已排队的 run() 执行完毕),但**不**新增自己的执行。
   * 用于 service 关闭 / reset 路径 —— 必须保证 in-flight mutation 全部完成才能
   * 释放内存索引,否则可能丢数据(写入完成后 byId.clear() 把新条目吞掉)。
   //
   // audit 2026-09-11:notes/service.ts:107 原写 `await this.writeLock` —— WriteLock
   //   不是 thenable,await 直接 resolve 成实例本身,**不**等待链尾。修复:queue 一个
   //   no-op 到链尾,await 它就拿到"前面所有 run() 都完成"的语义。
   //
   // audit r162 M1:原写 `await this.run(async () => {})`,run() 入口 `depth >= maxQueue`
   //   同步抛 BACK_PRESSURE。某 service 改 `new WriteLock(1)`,stop() 调 drain
   //   → 同步抛,主进程 shutdown 路径崩。修:走「直接 await this.chain」绕过
   //   depth 闸门 —— drain 语义是「等现有任务完成」,不应被 maxQueue 拒(等于
   //   「不允许等」自相矛盾)。maxQueue 仍是 run() 入口闸门防"积压"。
   */
  async drain(): Promise<void> {
    // 直接 await 当前链尾 —— 不 ++depth,不走 run() 闸门,纯等待。
    // chain 是 thenable(Promise<unknown>),await 等链尾 resolve 即"所有已
    // 排队 run() 都完成"。chain 自身不会被本调用改写,后续 run() 仍按
    // FIFO 排在本调用之后。
    await this.chain;
  }
}
