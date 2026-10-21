// 渲染层广播 helper:把 IPC 消息推到所有活跃 BrowserWindow
//
// 设计:单一入口避免 3+ 处 inline 循环漂移(`workspace.ts`、`notes.ts`、
// `library.ts` 等都做过同样 `BrowserWindow.getAllWindows() / filter
// !isDestroyed / send(channel)` 的样板)。任何"通知所有窗口刷新"场景都走这里。
//
// audit HIGH-2 (2026-08-23):3 处重复实现统一到一个 helper。
// 现状(2026-09-08 audit):原列的 trash.ts / workspace.ts 推 push* 已分别于
// 2026-08-27 (trash 整体下线) 与 2026-08-28 (workspace → favorites 重构)
// 走完迁移,目前 push* 实际由 favorites / notes / library 三处承担,
// 全部统一到本 helper。
import { BrowserWindow } from 'electron';
import { createLogger } from '../utils/logger';
import { errMsg } from '../utils/error';

const log = createLogger('broadcast');

/**
 * 把 channel 推到所有未销毁 BrowserWindow 的 webContents。
 * 静默忽略任何 send 抛错 —— 边界情况(窗口关闭竞态)不影响其它窗口的广播。
 */
export function broadcastToAllWindows(channel: string, payload?: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    try {
      w.webContents.send(channel, payload);
    } catch (err: unknown) {
      // 窗口可能在 send 期间被关闭,忽略。但降级 log 记录 send 失败的具体原因
      // —— 偶发 race 让 window teardown 期间 send 抛"Object has been destroyed",
      //   真错误(序列化失败)被吞会很麻烦。audit 2026-09-14 改 warn。
      log.warn('webContents.send failed (window may be tearing down)', {
        channel,
        err: errMsg(err),
      });
    }
  }
}
