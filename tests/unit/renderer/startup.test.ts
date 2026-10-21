// tests/unit/renderer/startup.test.ts
//
// 守卫:启动期进度覆盖层状态机(src/renderer/src/store/startup.ts)。
// 源码头注指向本文件(audit-r75 登记,audit-r229 补齐 —— 原先标 🔒(守卫缺失))。
//
// 这个 store 很小但**语义载体很重**:它是应用启动时覆盖整个主界面的那层
// 遮罩。写错了用户直接看到「界面卡住不动」或「遮罩闪一下又消失」:
//
//   1. done=true ⇒ visible 必须 false —— 否则遮罩退不掉,主界面永远点不动;
//   2. applyEvent('all-done') ⇒ 立刻 done + 退场;
//   3. phase-start ⇒ 该 phase running + 成为 activePhase(后启动者覆盖);
//   4. phase-done ⇒ 该 phase done;若它正是 activePhase ⇒ 回退到下一个
//      running 的 phase(优先级:finalizing > literature > notes-resync > notes);
//   5. phase-done(ok=false, error) ⇒ lastError 与该 phase 的 error 都要落;
//   6. hydrateFromSnapshot 是**合并**而非覆盖 —— snapshot 可能比 listener
//      累积的状态更早,直接覆盖会把已 done 的 phase 打回 pending(UI 闪一次
//      「进行中」);已 forceFinish(30s 兜底)时 snapshot 到达也不能把遮罩
//      闪回来;
//   7. **phase 名单三方一致**(r51 回归类):共享类型 StartupPhase union、
//      store 的 freshPhases 初始化表、mergePhases 的覆盖表、优先级表
//      必须同全集 —— 主进程加一个 phase 而 renderer 漏一处 ⇒
//      `s.phases[phase] === undefined` ⇒ applyEvent 直接抛 TypeError。
//
// 变异思路:去掉 done⇒visible 联动 / mergePhases 改成无条件覆盖 / 优先级
// 表漏一项 / freshPhases 漏一个 key —— 逐条会红。
import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { StartupPhase, StartupProgressSnapshot } from '@shared/types';
import { useStartupStore } from '../../../src/renderer/src/store/startup';

const ALL_PHASES: readonly StartupPhase[] = ['notes', 'notes-resync', 'literature', 'finalizing'];

/** 优先级表(源码 pickNextRunningPhase 里的 priority 数组顺序)。 */
const PRIORITY: readonly StartupPhase[] = ['finalizing', 'literature', 'notes-resync', 'notes'];

function freshPhaseMap(): Record<string, { state: 'pending' | 'running' | 'done' }> {
  const out: Record<string, { state: 'pending' | 'running' | 'done' }> = {};
  for (const p of ALL_PHASES) out[p] = { state: 'pending' };
  return out;
}

function resetStore() {
  useStartupStore.setState({
    visible: true,
    done: false,
    activePhase: null,
    phases: freshPhaseMap() as never,
    lastError: null,
  });
}

function snapshot(over: Partial<StartupProgressSnapshot> = {}): StartupProgressSnapshot {
  return {
    done: false,
    startedAt: 1,
    currentPhase: null,
    phases: freshPhaseMap() as never,
    lastError: null,
    ...over,
  };
}

beforeEach(() => {
  resetStore();
});

describe('启动覆盖层状态机', () => {
  it('初始状态:遮罩可见、未完成、无活跃 phase、全部 phase pending', () => {
    const s = useStartupStore.getState();
    expect(s.visible).toBe(true);
    expect(s.done).toBe(false);
    expect(s.activePhase).toBeNull();
    expect(s.lastError).toBeNull();
    for (const p of ALL_PHASES) {
      expect(s.phases[p].state, `phase ${p}`).toBe('pending');
    }
  });

  it('all-done ⇒ done=true + 遮罩退场 + 活跃 phase 清空', () => {
    useStartupStore.getState().applyEvent({ type: 'all-done' });
    const s = useStartupStore.getState();
    expect(s.done).toBe(true);
    expect(s.visible, 'done 后遮罩必须退场,否则主界面永远点不动').toBe(false);
    expect(s.activePhase).toBeNull();
  });

  it('phase-start ⇒ 该 phase 转 running + 记 total + 成为活跃 phase', () => {
    useStartupStore.getState().applyEvent({ type: 'phase-start', phase: 'notes', total: 42 });
    const s = useStartupStore.getState();
    expect(s.phases.notes.state).toBe('running');
    expect(s.phases.notes.total).toBe(42);
    expect(s.activePhase).toBe('notes');
    expect(s.visible).toBe(true);
  });

  it('phase-start 不带 total ⇒ 不写 total 字段(不凭空造数)', () => {
    useStartupStore.getState().applyEvent({ type: 'phase-start', phase: 'literature' });
    expect(useStartupStore.getState().phases.literature.total).toBeUndefined();
  });

  it('后启动的 phase 覆盖活跃 phase(last-started wins)', () => {
    const st = useStartupStore.getState();
    st.applyEvent({ type: 'phase-start', phase: 'notes' });
    st.applyEvent({ type: 'phase-start', phase: 'literature' });
    expect(useStartupStore.getState().activePhase).toBe('literature');
  });

  it('phase-done(ok) ⇒ 该 phase done,活跃 phase 回退到下一个 running', () => {
    const st = useStartupStore.getState();
    st.applyEvent({ type: 'phase-start', phase: 'notes' });
    st.applyEvent({ type: 'phase-start', phase: 'finalizing' });
    expect(useStartupStore.getState().activePhase).toBe('finalizing');
    st.applyEvent({ type: 'phase-done', phase: 'finalizing', ok: true });
    const s = useStartupStore.getState();
    expect(s.phases.finalizing.state).toBe('done');
    expect(s.activePhase, 'finalizing 完成后应回退到还在跑的 notes').toBe('notes');
  });

  it('phase-done(失败) ⇒ 记 lastError + 该 phase 的 error', () => {
    const st = useStartupStore.getState();
    st.applyEvent({ type: 'phase-start', phase: 'notes-resync' });
    st.applyEvent({ type: 'phase-done', phase: 'notes-resync', ok: false, error: 'resync boom' });
    const s = useStartupStore.getState();
    expect(s.phases['notes-resync'].state).toBe('done');
    expect(s.phases['notes-resync'].error).toBe('resync boom');
    expect(s.lastError).toBe('resync boom');
  });

  it('phase-done(成功) ⇒ 不写 lastError(成功不该留下错误文案)', () => {
    const st = useStartupStore.getState();
    st.applyEvent({ type: 'phase-start', phase: 'notes' });
    st.applyEvent({ type: 'phase-done', phase: 'notes', ok: true });
    expect(useStartupStore.getState().lastError).toBeNull();
  });

  it('活跃 phase 完成后无其它 running ⇒ 活跃 phase 变 null', () => {
    const st = useStartupStore.getState();
    st.applyEvent({ type: 'phase-start', phase: 'notes' });
    st.applyEvent({ type: 'phase-done', phase: 'notes', ok: true });
    expect(useStartupStore.getState().activePhase).toBeNull();
  });

  it('forceFinish ⇒ done + 退场;重复调用幂等(不抛不改)', () => {
    useStartupStore.getState().forceFinish();
    const after1 = useStartupStore.getState();
    expect(after1.done).toBe(true);
    expect(after1.visible).toBe(false);
    useStartupStore.getState().forceFinish();
    const after2 = useStartupStore.getState();
    expect(after2.done).toBe(true);
    expect(after2.visible).toBe(false);
  });

  it('已 done 后收到普通 phase 事件 ⇒ 忽略(不复活遮罩)', () => {
    const st = useStartupStore.getState();
    st.applyEvent({ type: 'all-done' });
    st.applyEvent({ type: 'phase-start', phase: 'notes' });
    const s = useStartupStore.getState();
    expect(s.done).toBe(true);
    expect(s.visible).toBe(false);
    expect(s.phases.notes.state, '已收尾后不该有 phase 回到 running').toBe('pending');
  });

  it('未知事件 type ⇒ 静默忽略,不抛(union 扩展时的防御)', () => {
    useStartupStore.getState().applyEvent({ type: 'who-knows' } as never);
    expect(useStartupStore.getState().done).toBe(false);
  });
});

describe('snapshot 合并(不回退 + 不闪回)', () => {
  it('snap.done=true ⇒ 直接收尾(不挂遮罩)', () => {
    useStartupStore.getState().hydrateFromSnapshot(snapshot({ done: true }));
    const s = useStartupStore.getState();
    expect(s.done).toBe(true);
    expect(s.visible).toBe(false);
    expect(s.activePhase).toBeNull();
  });

  it('已 forceFinish 时 snapshot 到达 ⇒ no-op(遮罩不闪回)', () => {
    useStartupStore.getState().forceFinish();
    useStartupStore.getState().hydrateFromSnapshot(snapshot({ done: false }));
    const s = useStartupStore.getState();
    expect(s.done, '30s 兜底已收尾,snapshot 不得把它打回未完成').toBe(true);
    expect(s.visible, '遮罩不得在已渲染好的主界面上闪回').toBe(false);
  });

  it('listener 已把 phase 推到 done,snapshot 还是 pending ⇒ 保持 done(不回退)', () => {
    const st = useStartupStore.getState();
    st.applyEvent({ type: 'phase-start', phase: 'notes' });
    st.applyEvent({ type: 'phase-done', phase: 'notes', ok: true });
    st.hydrateFromSnapshot(snapshot());
    expect(useStartupStore.getState().phases.notes.state).toBe('done');
  });

  it('listener 已 running,snapshot 还是 pending ⇒ 保持 running', () => {
    const st = useStartupStore.getState();
    st.applyEvent({ type: 'phase-start', phase: 'notes' });
    st.hydrateFromSnapshot(snapshot());
    expect(useStartupStore.getState().phases.notes.state).toBe('running');
  });

  it('snapshot 更靠后(pending→done)⇒ 采用 snapshot 的 state', () => {
    const st = useStartupStore.getState();
    st.applyEvent({ type: 'phase-start', phase: 'notes' });
    const snap = snapshot();
    snap.phases.notes = { state: 'done' };
    st.hydrateFromSnapshot(snap);
    expect(useStartupStore.getState().phases.notes.state).toBe('done');
  });

  it('两边都 running ⇒ 保留 listener 的 total(snapshot 可能是更早的值)', () => {
    const st = useStartupStore.getState();
    st.applyEvent({ type: 'phase-start', phase: 'notes', total: 7 });
    const snap = snapshot();
    snap.phases.notes = { state: 'running', total: 3 };
    st.hydrateFromSnapshot(snap);
    expect(useStartupStore.getState().phases.notes.total).toBe(7);
  });

  it('listener 已有活跃 phase ⇒ 优先于 snapshot 的 currentPhase', () => {
    const st = useStartupStore.getState();
    st.applyEvent({ type: 'phase-start', phase: 'literature' });
    st.hydrateFromSnapshot(snapshot({ currentPhase: 'notes' }));
    expect(useStartupStore.getState().activePhase).toBe('literature');
  });

  it('两边都没有活跃 phase ⇒ 回退到合并后的第一个 running phase', () => {
    const st = useStartupStore.getState();
    const snap = snapshot();
    snap.phases.literature = { state: 'running' };
    st.hydrateFromSnapshot(snap);
    expect(useStartupStore.getState().activePhase).toBe('literature');
  });

  it('lastError:snapshot 有值取 snapshot,snapshot 为 null 则保留 listener 累积值', () => {
    const st = useStartupStore.getState();
    st.applyEvent({ type: 'phase-done', phase: 'notes', ok: false, error: 'cur err' });
    st.hydrateFromSnapshot(snapshot({ lastError: null }));
    expect(useStartupStore.getState().lastError).toBe('cur err');
    st.hydrateFromSnapshot(snapshot({ lastError: 'snap err' }));
    expect(useStartupStore.getState().lastError).toBe('snap err');
  });
});

describe('phase 名单三方一致(r51 回归类:主进程加 phase,renderer 漏一处就崩)', () => {
  /** 从 src/shared/types.ts 抽出 StartupPhase union 的成员(单一真相源)。 */
  function unionMembers(): string[] {
    const src = readFileSync(join(process.cwd(), 'src/shared/types.ts'), 'utf-8');
    const m = /export type StartupPhase =([^;]+);/.exec(src);
    expect(m, 'src/shared/types.ts 里应能解析出 StartupPhase union').not.toBeNull();
    const members = [...m![1].matchAll(/'([^']+)'/g)].map((x) => x[1]!);
    expect(members.length, 'StartupPhase union 不应为空').toBeGreaterThan(0);
    return members;
  }

  it('共享 union 与 store 初始化表(freshPhases)同全集', () => {
    const union = unionMembers().sort();
    const init = Object.keys(useStartupStore.getState().phases).sort();
    expect(init, 'store 初始化漏了 union 里的 phase ⇒ applyEvent 会撞 undefined').toEqual(union);
  });

  it('共享 union 与优先级表同全集', () => {
    const union = unionMembers().sort();
    expect([...PRIORITY].sort(), '优先级表漏了 union 里的 phase ⇒ 该 phase 跑起来时活跃文案空').toEqual(
      union,
    );
  });

  it('逐 phase:mergePhases 覆盖 union 全集(漏一个 ⇒ 该 phase 被 snapshot 覆盖回退)', () => {
    for (const p of unionMembers()) {
      resetStore();
      const st = useStartupStore.getState();
      st.applyEvent({ type: 'phase-start', phase: p as StartupPhase });
      st.applyEvent({ type: 'phase-done', phase: p as StartupPhase, ok: true });
      st.hydrateFromSnapshot(snapshot());
      expect(
        useStartupStore.getState().phases[p as StartupPhase].state,
        `phase ${p} 被 snapshot 打回 pending`,
      ).toBe('done');
    }
  });

  it('逐 phase:优先级表能挑出每个 running 的 phase(漏一个 ⇒ 活跃文案空)', () => {
    for (const p of unionMembers()) {
      resetStore();
      const st = useStartupStore.getState();
      st.applyEvent({ type: 'phase-start', phase: p as StartupPhase });
      st.applyEvent({ type: 'phase-done', phase: p as StartupPhase, ok: true });
      expect(useStartupStore.getState().activePhase, `phase ${p} 完成后没有回退目标`).toBeNull();
    }
  });

  it('两个 phase 同时 running ⇒ 回退挑优先级更高的那个', () => {
    for (let i = 0; i < PRIORITY.length; i++) {
      for (let j = 0; j < PRIORITY.length; j++) {
        if (i === j) continue;
        const hi = PRIORITY[i]!;
        const lo = PRIORITY[j]!;
        resetStore();
        const st = useStartupStore.getState();
        st.applyEvent({ type: 'phase-start', phase: hi });
        st.applyEvent({ type: 'phase-start', phase: lo });
        // 让 lo 成为当前活跃 phase,再完成它 ⇒ 应回退到优先级更高的 hi
        st.applyEvent({ type: 'phase-done', phase: lo, ok: true });
        expect(
          useStartupStore.getState().activePhase,
          `${hi} 与 ${lo} 同时 running 时,${lo} 完成后应回退到 ${hi}`,
        ).toBe(hi);
      }
    }
  });
});
