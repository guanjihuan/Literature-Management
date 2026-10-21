// 启动期进度状态机 — 单一权威源,所有 startup-phase 事件都从这里出。
//
// 职责:
//   - 维护 StartupProgressSnapshot(主进程唯一一份真相)
//   - 通过 BrowserWindow.webContents.send 推送给所有未销毁窗口
//   - 提供 snapshot() 给 STARTUP_GET_STATE IPC(渲染层 mount 时兜底拉)
//
// 设计要点:
//   - 状态机简单:每个 phase 单独 pending/running/done,允许独立失败互不影响
//   - snapshot 与最后一次推送语义自洽(send 内先更新 snap,再发事件)
//   - 主进程崩溃 / 推送异常都不能让该单例崩出(所有方法 try/catch 兜底)
//
// 不做的事:
//   - 不在这里 await 任何 service 的 Promise — 调用方在 startup.ts 包 then/catch
//   - 不持久化 — 进程内内存状态,关窗即丢
//   - 不做 IPC 序列化类型校验 — 渲染层用 StartupProgressEvent discriminated union 自检

// perf(2026-08-24):走 broadcastToAllWindows helper 替代 inline BrowserWindow 循环
import { broadcastToAllWindows } from './ipc/broadcast';
import {
  IPC,
  StartupPhase,
  StartupPhaseInfo,
  StartupProgressEvent,
  StartupProgressSnapshot,
} from '../shared/types';
import { createLogger } from './utils/logger';
// audit C3R47 (2026-08-22):errMsg 替代 5 处内联 `errMsg(err)`
import { errMsg } from './utils/error';

const log = createLogger('startup-progress');

/** 三个 phase 的初值 — 都是 pending,total 未知,error 为空 */
function freshPhases(): StartupProgressSnapshot['phases'] {
  return {
    notes: { state: 'pending' },
    // audit r51 (2026-10-15):补 'notes-resync' 占位 — r50 M6 引入新 phase 但
    //   runtime initializer 漏跟进,types.ts 已声明其为 StartupProgressSnapshot.phases
    //   必填键。r51 当时仅作 type/runtime 一致性兜底(原注「phase 永不被
    //   phase-start 激活」描述的是那一轮状态;audit-r124 校正:后续轮已
    //   接入 —— startup.ts:211 trackPhase('notes-resync', resyncIfNeeded)
    //   在真实启动路径激活本 phase)。
    'notes-resync': { state: 'pending' },
    // audit-r136:literature phase 占位 —— 与 StartupPhase 同步扩。
    //   startup.ts:runBackgroundScansFireAndForget 在 notes-resync 后、
    //   finalizing 前调 trackPhase('literature', () => literatureService.load())。
    //   任何一处漏加 → renderer 端 phases.literature === undefined,
    //   StartupOverlay 直接卡死。snapshot 浅拷贝见下方同款注释。
    literature: { state: 'pending' },
    finalizing: { state: 'pending' },
  };
}

function freshSnapshot(): StartupProgressSnapshot {
  return {
    done: false,
    startedAt: null,
    currentPhase: null,
    phases: freshPhases(),
    lastError: null,
  };
}

/** 把 StartupPhaseInfo 通用 patch 进对应槽位 — 仅覆盖给定字段,不动其他 */
function patchPhase(
  snap: StartupProgressSnapshot,
  phase: StartupPhase,
  patch: Partial<StartupPhaseInfo>,
): void {
  const cur = snap.phases[phase];
  snap.phases[phase] = { ...cur, ...patch };
}

class StartupProgressBroadcaster {
  private snap: StartupProgressSnapshot = freshSnapshot();

  /**
   * 标记某 phase 开始。允许在同一 phase 被 start 多次(幂等:running 后再 start 不变)。
   * 首次调用时同时 stamp startedAt + currentPhase。
   * 多个 phase 并发时,last-started wins(overlay 显示最新启动阶段的 label)。
   */
  startPhase(phase: StartupPhase, total?: number): void {
    try {
      // perf+correctness:done 后不再接受新 phase(防止误调用污染 snapshot)
      if (this.snap.done) return;
      if (this.snap.startedAt === null) this.snap.startedAt = Date.now();
      this.snap.currentPhase = phase;
      const patch: Partial<StartupPhaseInfo> = { state: 'running' };
      if (typeof total === 'number') patch.total = total;
      patchPhase(this.snap, phase, patch);
      this.send({ type: 'phase-start', phase, total });
      log.debug('phase-start', phase, total ?? '');
    } catch (err) {
      log.warn('startPhase failed', phase, errMsg(err));
    }
  }

  /**
   * 标记某 phase 结束。ok=false 时 error 字段填入,lastError 也更新。
   * 同一 phase 可多次 endPhase(用最新一次覆盖,方便 finalizing 阶段覆盖之前的失败)。
   */
  endPhase(phase: StartupPhase, ok: boolean, error?: string): void {
    try {
      if (this.snap.done) return;
      const patch: Partial<StartupPhaseInfo> = { state: 'done' };
      if (!ok && error) {
        patch.error = error;
        this.snap.lastError = error;
      }
      patchPhase(this.snap, phase, patch);
      this.send({ type: 'phase-done', phase, ok, error });
      log.debug('phase-done', phase, ok, error ?? '');
    } catch (err) {
      log.warn('endPhase failed', phase, errMsg(err));
    }
  }

  /**
   * 全部完成 — 推 all-done 并标记 snapshot.done=true。
   * 任何后续 startPhase 都不再发送事件(snapshot 已 done)。
   */
  finish(): void {
    try {
      this.snap.done = true;
      this.send({ type: 'all-done' });
      log.info('all startup phases done');
    } catch (err) {
      log.warn('finish failed', errMsg(err));
    }
  }

  /**
   * 测试用 — 把内部 snap 重置为初始状态。
   * 生产代码不应调用(会丢失 done 状态导致 overlay 重新挂载);
   * 暴露此方法是为了让 vitest beforeEach 不必走 private 字段黑魔法。
   */
  reset(): void {
    this.snap = freshSnapshot();
  }

  /**
   * 给 STARTUP_GET_STATE IPC handler 用 — 返回当前 snapshot 的浅拷贝,
   * 防止 renderer 端意外篡改主进程内部状态。
   */
  snapshot(): StartupProgressSnapshot {
    return {
      done: this.snap.done,
      startedAt: this.snap.startedAt,
      currentPhase: this.snap.currentPhase,
      phases: {
        notes: { ...this.snap.phases.notes },
        // audit r51:补 'notes-resync' 浅拷贝,与 freshPhases 对齐。
        'notes-resync': { ...this.snap.phases['notes-resync'] },
        // audit-r136:literature 浅拷贝 — 与 freshPhases 对齐。漏掉此处
        //   会让 renderer 收到 phases.literature === undefined(浅拷贝
        //   只覆盖显式列出的键),StartupOverlay 加载阶段卡死。
        literature: { ...this.snap.phases.literature },
        finalizing: { ...this.snap.phases.finalizing },
      },
      lastError: this.snap.lastError,
    };
  }

  /**
   * 推送给所有未销毁的 renderer。
   * - snapshot.done 后不再发事件(防止 reload 后又看见 overlay 跳动)
   * - 每个窗口单独 try/catch,某个 send 抛错不影响其他窗口
   */
  private send(ev: StartupProgressEvent): void {
    if (this.snap.done && ev.type !== 'all-done') return;
    // perf(2026-08-24):走 broadcastToAllWindows 统一 helper
    broadcastToAllWindows(IPC.STARTUP_PROGRESS, ev);
  }
}

export const startupProgress = new StartupProgressBroadcaster();
