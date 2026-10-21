// src/main/utils/retry-transient.ts
//
// audit C3R66 (2026-08-22):抽 Windows EPERM/EBUSY transient retry loop —
// 之前在 src/main/utils/safe-write.ts:118-142 和 src/main/utils/atomic-file.ts:164-191
// verbatim 重复 25 行(只有 return vs break 的差异)。两份代码独立演化风险高
// (C2R20 off-by-one fix 时只修了一处,另一处保留原状)。合并到本 helper 后:
//   1. EPERM/EBUSY 退避策略单一真相源(maxAttempts / backoff 公式 / jitter 上限)
//   2. C2R20 off-by-one fix 一处生效,全覆盖
//   3. 失败清理抽到 caller(caller 已经持有 tmp 路径,语义上更清晰)
//
// 退避策略(Windows 验证过):
//   - maxAttempts: 5
//   - backoff: 50 * 2^(attempt-1) ms —— 但**只有 4 次 sleep**:
//     50/100/200/400(基础合计 750ms)。第 5 次失败时 attempt=5 不再
//     < MAX_ATTEMPTS,直接 throw,800ms 档不存在。
//     audit-r95 修正:旧注释宣称「50/100/200/400/800,总窗口 ~1.5s」,
//     与代码差一倍(r88 PromptDialog 注释撒谎先例)。行为面由
//     retry-transient.test.ts 的 fake-timer 序列锁钉死,改公式必红。
//   - jitter: [0, 25) ms random,避免多 writer 齐步重试
//   - 退避期间命中 transient 之外的其他错误 → 立即 throw(不重试)
//
// audit 2026-09-14:cleanup callback 的 .catch(() => {}) 之前无日志。cleanup 是 caller 传的
//   (safeUnlink / fh.close 等),失败通常是 Windows AV 持锁 / 权限丢失 —— 留下孤儿 tmp /
//   fd 泄漏信号消失。补 log 让退避循环外的清理失败可观察。
import { createLogger } from './logger';
import { errMsg } from './error';

const log = createLogger('retry-transient');
//
// 为什么 caller 传 cleanup 而不是 helper 内部 fs.unlink:
//   - helper 不知道 caller 的 tmp 路径(caller 可能自定义 .tmp suffix / 不同的目录)
//   - 某些 caller 已经在 outer catch 里清理 tmp,inline 重复清理有 race
//   - 让 helper 保持单一职责(只 retry),副作用归 caller

import { errnoCode } from './error';

const MAX_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 50;
const JITTER_MAX_MS = 25;

/**
 * Windows 在快速 back-to-back rename 时偶发 EPERM/EBUSY(AV 扫描 / Defender
 * 全盘扫描持句柄导致 MoveFileEx 失败)。POSIX 上不会触发。本 helper 把 retry
 * 退避策略封装一次,所有原子写路径(safe-write + atomic-file + 未来新增的
 * rename-based 写)共享同一份行为。
 *
 * @param action   要执行的 rename-style 操作。返回 = 成功;抛错 = 失败。
 * @param cleanup  exhaust 时调用,通常清理 .tmp 文件;失败也无害(caller 通常
 *                 会 catch 住,真正的 tmp 清理已经做过)。
 */
export async function retryOnWindowsTransient<T>(
  action: () => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<T> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await action();
    } catch (err: unknown) {
      // C2R20: 先 ++ attempt 再比较,避免 off-by-one 多试一次。
      // maxAttempts=5 时实际跑 5 次(不是 6 次)。
      attempt++;
      const code = errnoCode(err);
      // audit 2026-10-01:补 ENOTEMPTY。目录 rename / recursive rm 在 Windows 上
      //   撞上 Defender / Search / 云盘同步的瞬时占用时,报的正是 ENOTEMPTY
      //   (EPERM/EBUSY 只覆盖文件级)。缺它意味着「清空目标目录再 rename」
      //   这类迁移步骤会一次失败就放弃 —— 而调用方把失败降级成 warn 继续启动,
      //   用户看到的就是笔记凭空消失。
      const transient = code === 'EPERM' || code === 'EBUSY' || code === 'ENOTEMPTY';
      if (transient && attempt < MAX_ATTEMPTS) {
        const backoff = BACKOFF_BASE_MS * 2 ** (attempt - 1);
        await new Promise((r) =>
          setTimeout(r, backoff + Math.floor(Math.random() * JITTER_MAX_MS)),
        );
        continue;
      }
      // cleanup 可能同步返回 undefined(vi.fn 或裸 () => {})— 用 Promise.resolve 包一层
      // 才能安全链 .catch。否则 vi.fn()(undefined).catch → TypeError 盖住原 err。
      await Promise.resolve(cleanup()).catch((cleanupErr: unknown) =>
        log.warn('Transient retry cleanup callback failed', { err: errMsg(cleanupErr) }),
      );
      throw err;
    }
  }
}
