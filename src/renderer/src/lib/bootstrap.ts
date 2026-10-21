// audit-r85 (2026-10-17) — bootstrap single-flight。
//
// 起因(r85 recon):main.tsx 后台 IIFE 第一行发 bootstrap,App.tsx passive
// effect 又「幂等兜底」地看 usePathsStore.loaded 决定要不要再发 —— 但
// React passive effect flush(<16ms)永远早于 bootstrap IPC 往返(50-200ms),
// loaded 此刻必然还是 false,所以**每次冷启都并发两次 bootstrap IPC**
// (dev StrictMode 三次)。main.tsx:33 注释「loaded 守卫(已设为 true)保证
// 不会跑 legacy fallback」是不生效的假守卫。危害实证:pendingLayout 的
// localStorage key 在 .then 异步清理,双调用 → 双 updateSettings 写(同值
// 不成害)—— 浪费是真,状态损坏是零,所以定级 LOW,修的是**重复 IPC +
// 虚假守卫**。
//
// 契约(行为锁 tests/unit/renderer/lib/bootstrap-single-flight.test.ts):
//   - 并发/后续调用命中同一 promise(单 IPC);
//   - 成功结果(含 ok:false 合法回复)缓存不重发 —— 与 main.tsx 失败后
//     置 loaded=true 的「本轮启动尝试过」语义一致;
//   - rejection(桥未就绪 / IPC 抛)清缓存 —— 瞬时 race,之后重调可再试,
//     这才是原注释「幂等兜底」想表达却没做到的行为;
//   - 桥缺失(api.bootstrap 非函数)转成 rejection 而非同步 throw ——
//     符合 r83 契约(调用点带同线 typeof guard,Proxy 属性读安全)。
//
// audit-r87 (2026-10-17) — 单飞修了「重复 IPC」,没修「重复应用」:两个
// awaiter 拿到同一结果后各自 applyBootstrapSettings + setState({paths,loaded})。
// pendingLayout 的消费在 applyPendingLayoutFallback 里 `void api.updateSettings(...)
// .then(removeItem)` —— key 清理是异步的,同帧双 apply → 双 updateSettings 写
// (同值 LOW,与 r85 定级同理)。修:apply 收口成本文件 applyBootstrapOnce 单点,
// 行为锁 tests/unit/renderer/lib/bootstrap-apply-once.test.ts。
import { api } from './api';
import { applyBootstrapSettings } from '../store/settings';
import { usePathsStore } from '../store/paths';
import type { BootstrapPayload, IpcResult } from '@shared/types';

let inflight: Promise<IpcResult<BootstrapPayload>> | null = null;

export function bootstrapOnce(): Promise<IpcResult<BootstrapPayload>> {
  if (inflight) return inflight;
  if (typeof api.bootstrap !== 'function') {
    return Promise.reject(new Error('bridge missing: bootstrap method unavailable'));
  }
  const p = api.bootstrap().then(
    (r) => r,
    (err: unknown) => {
      // 只清自己这个 inflight(期间可能有新调用接管缓存位)
      if (inflight === p) inflight = null;
      throw err;
    },
  );
  inflight = p;
  return p;
}

export type BootstrapApplyOutcome = 'applied' | 'already-applied' | 'ipc-failed';

/**
 * bootstrap 结果「应用且仅应用一次」单点(main.tsx / App.tsx 共用)。
 *
 * 契约:
 *   - r.ok 且尚未应用 → applyBootstrapSettings(消费 pendingLayout 兜底)+
 *     setState({ paths, loaded:true }),返回 'applied';
 *   - r.ok 但已应用(另一 continuation 先落地 / 测试直接置 loaded)→
 *     'already-applied',零 store 写、零 IPC —— 首落地值不被覆写;
 *   - !r.ok → 'ipc-failed',**纯判定不碰 state**:调用方按各自职责处理
 *     (main:log.warn + loaded=true「本轮启动尝试过」标记;App:legacy
 *     settings/paths pair 修复)。两个调用方都会拿到同一个 'ipc-failed',
 *     修复只由 App 执行一次,这是有意分工而非守卫。
 */
export function applyBootstrapOnce(r: IpcResult<BootstrapPayload>): BootstrapApplyOutcome {
  if (!r.ok) return 'ipc-failed';
  if (usePathsStore.getState().loaded) return 'already-applied';
  applyBootstrapSettings(r.data.settings);
  usePathsStore.setState({ paths: r.data.paths, loaded: true });
  return 'applied';
}
