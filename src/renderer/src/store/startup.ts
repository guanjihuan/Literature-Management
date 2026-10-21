// 启动期进度覆盖层 — renderer 状态
//
// 单一真相来自 useSyncStores 拉取的 snapshot + 订阅的增量事件。
// 关键不变量:
//   - done=true 时 visible 必须 false(overlay 退场)
//   - applyEvent('all-done') → 立刻 done=true,visible=false
//   - applyEvent('phase-start') 自动把 phase 设为当前活跃(若有多个 running,后到者覆盖)
//   - 安全兜底:StartupOverlay mount 时 30s 没事件就 forceFinish
//   - hydrateFromSnapshot 合并「不回退」+ freshPhases/priority/merge 三表与
//     StartupPhase union 全集一致 —— audit-r75 起由
//     tests/unit/renderer/startup.test.ts 逐 phase 行为级锁定(r51 漏登记类回归;
//     audit-r229 补齐 26 例,含「三表 vs union 全集」的对拍)
//
// 不做的事:
//   - 不调用 IPC —— 完全被动,纯 reducer
//   - 不持久化 —— 进程内即可
//   - 不读任何业务 store(旧注的 useLibraryStore 已随库下线,见 audit-r56)
//     —— 独立横切关注点
import { create } from 'zustand';
import type {
  ActiveStartupPhase,
  StartupPhase,
  StartupPhaseInfo,
  StartupPhaseState,
  StartupProgressEvent,
  StartupProgressSnapshot,
} from '@shared/types';

interface StartupState {
  /** overlay 是否挂上 — done=true 立刻翻 false */
  visible: boolean;
  /** 全部阶段完成 — 等于 done=true 后 visible 必然 false */
  done: boolean;
  /** 当前活跃阶段 — 用于 overlay 副文案取 startup.phase.<key> */
  activePhase: ActiveStartupPhase;
  /** 各 phase 状态(单独 phase 的进度详情) */
  // 重构 (2026-09):workspace phase 删除 —— recent / trash services 已下线,
  //   favorites 是单文件 AtomicFile 同步读,不需独立 phase。
  // audit r51 (2026-10-15):补 'notes-resync' —— r50 M6 引入新 phase,StartupPhase
  //   union 已含,StartupState['phases'] inline 类型漏对齐会让 s.phases[k] 索引
  //   访问 TS 拒绝。
  // audit-r56:删 'library' —— library service 整体下线,启动期无 library phase;
  //   与 src/shared/types.ts:299 StartupPhase union 对齐。
  phases: {
    notes: StartupPhaseInfo;
    'notes-resync': StartupPhaseInfo;
    // audit-r136:补 'literature' 槽位 —— r67 LiteratureService 重启后
    //   startup 引入新 phase(src/shared/types.ts:363),inline 镜像必须与
    //   StartupPhase union 对齐,否则 s.phases[k] 索引访问 TS 拒绝。
    literature: StartupPhaseInfo;
    finalizing: StartupPhaseInfo;
  };
  /** 最近一次错误(任一 phase 失败时填入) */
  lastError: string | null;

  /** mount 时从主进程同步拉 snapshot,重建状态 */
  hydrateFromSnapshot: (snap: StartupProgressSnapshot) => void;
  /** 增量事件 — 单一入口 */
  applyEvent: (ev: StartupProgressEvent) => void;
  /** 兜底:长时间没事件强制结束 */
  forceFinish: () => void;
}

function freshPhases(): StartupState['phases'] {
  return {
    notes: { state: 'pending' },
    // audit r51 (2026-10-15):补 'notes-resync' 占位 — r50 M6 引入新 phase 但
    //   renderer 镜像 initializer 漏跟进。完整 M6 实现留后续 round。
    'notes-resync': { state: 'pending' },
    // audit-r136:补 'literature' 占位 —— r67 LiteratureService 重启后
    //   trackPhase('literature', literatureService.load()) 在 startup.ts:243
    //   接入,renderer phases 镜像必须有这个 key 否则 applyEvent dispatch
    //   时 s.phases['literature'] = undefined 抛 TypeError。
    literature: { state: 'pending' },
    finalizing: { state: 'pending' },
  };
}

/**
 * 从 phases 中选一个仍 running 的 phase 作为 activePhase(用于 phase-done 时的回退)。
 * 优先级(数组顺序即优先级,索引 0 最高):
 *   finalizing > notes-resync > notes
 * - finalizing 最优先:用户最关心"什么时候能好"
 */
function pickNextRunningPhase(phases: StartupState['phases']): ActiveStartupPhase {
  // audit r51:加 'notes-resync' — r50 M6 引入新 phase 后,该 phase 也会进入
  //   running 状态。priority 顺序按用户感知重要性:finalizing > notes-resync > notes。
  // audit-r56:删 'library' — 该 phase 已随 library service 下线。
  const priority: readonly StartupPhase[] = [
    'finalizing',
    // audit-r136:'literature' 插在 finalizing 与 notes-resync 之间 —— 文献
    //   加载比 notes-resync 用户感知更重要(主面板的文献面板就靠这一步),
    //   但仍低于 finalizing(用户最关心「什么时候能好」)。
    'literature',
    'notes-resync',
    'notes',
  ];
  for (const p of priority) {
    if (phases[p].state === 'running') return p;
  }
  return null;
}

// audit 2026-09-10:逐 phase 合并 listener 已应用的状态与 snapshot 状态。
//   state 转移单向:Pending → Running → Done(无 Done → Pending 回退)。
//   listener 在 snapshot 到达前可能已经推进到 Running / Done;snapshot 是
//   主进程某一时刻的快照,可能比 listener 累积的状态更早 —— 直接覆盖会把
//   已 Done 的 phase 回退到 Pending,UI 闪一次 "进行中"。
//   state 优先级:Done > Running > Pending。其它字段(total / error)
//   listener 在 phase-start 之后可能有 progress 更新;snapshot 是更早的版本,
//   同样保留 listener 的最新值。
function mergePhases(
  cur: StartupState['phases'],
  snap: StartupState['phases'],
): StartupState['phases'] {
  const rank = { pending: 0, running: 1, done: 2 } as const;
  const out = { ...snap };
  // audit r51:加 'notes-resync' — 完整 merges phase 全集与 StartupPhase union 对齐。
  // audit-r56:删 'library' — 该 phase 已随 library service 下线。
  // audit-r136:加 'literature' —— merge phases 数组必须覆盖 StartupPhase union 全集。
  (['notes', 'notes-resync', 'literature', 'finalizing'] as const).forEach((k) => {
    const c = cur[k];
    const s = out[k];
    // 若 cur 已比 snap 推进,保留 cur 的 state + listener 已记录的 progress 字段。
    if (rank[c.state] > rank[s.state]) {
      out[k] = c;
    } else if (rank[c.state] === rank[s.state] && c.state === 'running') {
      // 都 running → 保留 listener 的 total(snapshot 可能是更早的值)。
      out[k] = { ...s, total: c.total ?? s.total };
    }
  });
  return out;
}

export const useStartupStore = create<StartupState>((set) => ({
  visible: true,
  done: false,
  activePhase: null,
  phases: freshPhases(),
  lastError: null,

  hydrateFromSnapshot: (snap) => {
    // 关键:主进程已 done=true → 渲染层 mount 拿到 snapshot 时不挂 overlay
    if (snap.done) {
      set({ visible: false, done: true, activePhase: null });
      return;
    }
    // audit 2026-09-10:防御 forceFinish 已经先到的情况 —— 启动期 > 30s
    //   时 StartupOverlay mount 自带 timer 会先调 forceFinish()(让 overlay
    //   不再阻塞 UI),但 getStartupState IPC 的 snapshot 仍然在路中。snapshot
    //   到达时 done 已是 true,但 snap.done 是 false(主进程仍在跑)——
    //   原实现无条件 set({ visible:true, done:false, ... }),overlay 重新
    //   挂在已经渲染好的主界面上,闪一下。先读 store 当前 done,若已 forceFinish
    //   就直接 no-op,避免 overlay 闪回。
    const cur = useStartupStore.getState();
    if (cur.done) return;
    // audit 2026-09-10:phase 合并 —— listener 先于 snapshot 注册后,在
    //   snapshot 到达前的窗口里主进程可能已发过 phase-done(library) /
    //   phase-start(notes) 等事件,applyEvent 已把对应 phase 推进。若
    //   snapshot 此时无条件覆盖 phases,会让已 done 的 phase 回退到
    //   pending(snapshot 是 main process 在某一时刻的快照,可能早于
    //   当前 listener 累积)。逐 phase 合并:若 cur.phases[phase]
    //   已 running/done 而 snap 仍是 pending,保留 cur;否则用 snap。
    const mergedPhases = mergePhases(cur.phases, snap.phases);
    // 当前活跃阶段同理合并 —— 若 listener 已 phase-start 过某个 phase,
    // activePhase 应跟随;否则用 snap.currentPhase;都没有再 fallback
    // 到下一个 running phase。
    const activePhase = cur.activePhase ?? snap.currentPhase ?? pickNextRunningPhase(mergedPhases);
    set({
      visible: true,
      done: false,
      activePhase,
      phases: mergedPhases,
      lastError: snap.lastError ?? cur.lastError,
    });
  },

  applyEvent: (ev) => {
    set((s) => {
      // 已 done 的事件(几乎不会发生,但防御一下)直接忽略
      if (s.done && ev.type !== 'all-done') return s;

      switch (ev.type) {
        case 'phase-start': {
          const cur = s.phases[ev.phase];
          const nextPhaseInfo: StartupPhaseInfo = {
            ...cur,
            state: 'running' as StartupPhaseState,
          };
          if (typeof ev.total === 'number') {
            nextPhaseInfo.total = ev.total;
          }
          const phases = { ...s.phases, [ev.phase]: nextPhaseInfo };
          // phase-start 总是把 activePhase 设为该 phase(last-started wins)
          return {
            ...s,
            visible: true,
            phases,
            activePhase: ev.phase,
          };
        }

        // audit-r56:'progress' 事件类型删 —— 该事件仅 library 扫描用,
        //   library service 下线后 StartupProgressEvent union 已无此 variant
        //   (src/shared/types.ts:333)。TS 会在 default 分支挡掉未知事件。

        case 'phase-done': {
          const cur = s.phases[ev.phase];
          const next: StartupPhaseInfo = { ...cur, state: 'done' as StartupPhaseState };
          if (!ev.ok && ev.error) next.error = ev.error;
          const phases = { ...s.phases, [ev.phase]: next };
          const lastError = !ev.ok && ev.error ? ev.error : s.lastError;
          // 若当前活跃阶段刚 done,回退到下一个 running 或 null
          let activePhase = s.activePhase;
          if (activePhase === ev.phase) {
            activePhase = pickNextRunningPhase(phases);
          }
          return { ...s, phases, lastError, activePhase };
        }

        case 'all-done': {
          return { ...s, done: true, visible: false, activePhase: null };
        }
        // audit round 19 (2026-08-22):defensive default — union 扩展时
        // 未处理的 variant 会让 set 收到 undefined(抛错)。直接吞掉未知
        // 事件并保留当前状态,与"已 done 忽略其它事件"的对称防御一致。
        default:
          return s;
      }
    });
  },

  forceFinish: () => {
    set((s) => (s.done ? s : { ...s, done: true, visible: false, activePhase: null }));
  },
}));