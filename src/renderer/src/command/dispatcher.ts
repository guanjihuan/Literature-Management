// Command Dispatcher — 命令分发的"单一真实来源"
//
// 为什么需要 dispatcher?
//   命令面板(已删除,2026-08-27)、菜单(menu:invoke IPC)、快捷键(useShortcut hook)
//   等入口都要触发同一组命令。直接 cd dispatch:
//     - 菜单发 IPC 到 renderer,被 App.tsx 接收后转发
//     - 快捷键同样注册命令
//   现在两处都直接调 command.run(),无可观测性。
//
// 解决:
//   引入 dispatcher.invoke(id) 单点入口:
//     1. 查 registry 取命令
//     2. 跑 when() 守卫(隐藏的命令先过滤)
//     3. cmd.run() 执行
//   各 UI 入口都调 invoke,行为完全一致。
//
// 副作用:集中后可以加日志、metrics、Undo 包装,改动范围最小。
import type { Command } from './registry';
// audit C3R89 (2026-08-22):走 createLogger 统一前缀 + 日志等级
import { createLogger } from '../lib/logger-client';
// audit 2026-09-16 r21:H9 — 命令 run() 失败除了 log.error 还要弹 toast,
//   否则菜单点击 / 快捷键看起来"无响应"无信号。useToast.getState() 允许
//   在 React 组件外调用 show(),与 render-tree 完全解耦。
import { useToast } from '../lib/toast';
// audit r29 (2026-09-21):cq H2 — 走 errMsg 共享 helper, 与 renderer 其它
//   30+ 处一致;不用 `err instanceof Error ? err.message : ...` 三元。
import { errMsg } from '../lib/error';

const log = createLogger('dispatcher');

class CommandDispatcher {
  private commands = new Map<string, Command>();

  /** 注册命令 — 通常在 App.tsx 启动时一次性注册 */
  register(cmd: Command): void {
    this.commands.set(cmd.id, cmd);
  }

  /** 批量注册 */
  registerAll(cmds: Command[]): void {
    for (const cmd of cmds) this.register(cmd);
  }

  /** 查询命令是否注册 */
  has(id: string): boolean {
    return this.commands.has(id);
  }

  /** 取命令(只读) — 命令面板 / 上下文扩展用 */
  get(id: string): Command | undefined {
    return this.commands.get(id);
  }

  /** 全部命令(只读) — 命令面板列表 */
  list(): Command[] {
    return Array.from(this.commands.values());
  }

  /**
   * 触发命令。统一流程:
   *   1. 守卫 when() — false 则跳过
   *   2. 命令 run() — 同步或异步都会被 await
   *
   * 失败约定:
   *   - 未知命令 warning + 不抛
   *   - 守卫拒绝 silently skip(让 UI 自己决定如何处理)
   *   - run() 抛错走 log.error + toast(避免菜单 IPC 死锁;但用户必须看到
   *     "刚才那个动作为什么没反应")
   */
  async invoke(id: string, payload?: unknown): Promise<void> {
    const cmd = this.commands.get(id);
    if (!cmd) {
      log.warn('unknown command:', id);
      return;
    }
    // audit-r82 (2026-10-17):when() 也要包 try —— dispatcher 自述「菜单/
    //   快捷键单点入口,顶层没有 await caller,throw 会漏成 unhandled
    //   rejection」,run() 已按此包 try,旧代码 when() 却在 try 外裸调,
    //   守卫抛错直接 reject 调用方。守卫抛错按「拒绝」处理(与 when()
    //   返回 false 同语义:跳过不执行),但补 log.error 留排查线索。
    if (cmd.when) {
      let allowed = false;
      try {
        allowed = cmd.when();
      } catch (err) {
        log.error('command when() threw, treat as rejected:', id, err);
        return;
      }
      if (!allowed) {
        return;
      }
    }
    try {
      await cmd.run(payload);
    } catch (err) {
      log.error('command failed:', id, err);
      // audit 2026-09-16 r21:H9 — toast 推送,让用户感知到命令失败。
      //   错误消息提取:Error.message 优先,unknown 时给 fallback。
      //   抑制自己再 throw:dispatcher 是菜单 / 快捷键单点入口,顶层
      //   没有 await caller,throw 会被 Promise 链漏成 unhandled rejection。
      try {
        // errMsg 统一处理 Error / string / 其它 unknown 情况;fallback
        // 'command failed' 仅在 reason 是 null / undefined 等无 string 化结果时
        // 才出现,errMsg 已涵盖 String() 兜底,这里再加一次保证 toast 永远有非空 message。
        const message = errMsg(err) || 'command failed';
        useToast.getState().show({ type: 'error', message });
      } catch (toastErr) {
        // toast 自身异常不能再 throw,只能 log
        log.warn('toast dispatch failed', toastErr);
      }
    }
  }

  /** 清空注册 — 主要给测试用 */
  clear(): void {
    this.commands.clear();
  }
}

/** 全局单例 */
export const dispatcher = new CommandDispatcher();
