// perf(2026-08-23):N-way 并发池 —— 从 library/scanner.ts 抽出共享。
// 原本只有 scanner 用,notes/standalone.ts 的 walk 也需要同款限流(串行 readFile
// 在几百篇笔记时拖到几百 ms),与 WriteLock / errPayload 同样的抽取动机:
// 避免第二份 verbatim 实现。
//
// 为什么用池而不是裸 Promise.all:大库一次性 spawn 数千 Promise 会同时打开数千
// fd(Windows 默认 handle 上限虽高,但 EMFILE 在 macOS/Linux 上很容易撞),
// 且没有背压 —— 池把并发钉在 N。
import { createLogger } from './logger';
import { errMsg } from './error';

const log = createLogger('run-pool');

/**
 * 把 items 分到最多 concurrency 个并发 worker 上跑 fn。
 *
 * 错误策略:单个 item 抛错被记录为 warn(包含 index + 错误信息),继续下一个 item。
 * 这样即使调用方忘记在 fn 内 try/catch,也能在 devtools 看到失败 ——
 * 原实现 empty catch 让 6 个 callsite 中任何一个忘记 log 都会 silent 丢失败,
 * 索引 / 扫描悄悄跳过损坏文件但 UI 没感知。warn 信息只到 run-pool scope,
 * 具体失败的 item 语义仍由调用方在 fn 内部 try/catch 自行 log。
 */
export async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    let i = cursor++;
    while (i < items.length) {
      const item = items[i];
      try {
        await fn(item);
      } catch (err: unknown) {
        log.warn('runPool task failed (caller should log specifics)', {
          i,
          item,
          err: errMsg(err),
        });
      }
      i = cursor++;
    }
  });
  await Promise.all(workers);
}
