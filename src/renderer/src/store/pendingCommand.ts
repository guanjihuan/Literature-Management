// Generic single-shot pending command — 跨组件 / 跨 mount 通讯通用模式。
//
// 历史:workspace store 里有 3 个 pending flag (pendingNewNote /
//   pendingRenameNoteId / pendingFocusNoteId) 都是「request 一次 +
//   consume 一次」的同款模式,2026-09-17 Phase 1b 又加 pendingSaveActiveNote。
//   4 处各自声明 + 各自实现 → drift 风险(已有 audit r23 发现 pendingFocusNoteId
//   必须加 pendingFocusVersion 才能让 zustand 浅比较不 short-circuit,其他 3 个
//   都缺同样的 invariant 而只是因为没暴露 bug)。
//
// 抽到这里后:4 个 pending 命令共用一个 shape (hasPending + payload + version),
//   future pending 命令(将来 ⌘P 命令面板 / 任何同款「request 一次 + consume
//   一次」需求)也走这个 helper,免去重复声明 + 漏 version 风险。
//
// Shape 解释:
//   - hasPending:true 时,consume 取出 payload 后立刻清零(atomic)。
//   - version:zustand 默认 setState 对 partial state 做浅比较,同 payload
//     重设会被 short-circuit 跳过通知,subscriber 不重跑。每次 request 必 +1,
//     确保每次 request 都被订阅者看到(NotesView pendingFocusNote effect
//     必需 — 否则「同一 id 二次 requestFocusNote」会丢)。
//   - 「boolean signal,无 payload」也可参数化为 `T = true`(unit type),`request(true)`
//     / `consume() → true | null`,API 一致。
//
// audit-r156:set / get 形参从 `any` 收紧为 zustand StoreApi<S>['setState' / 'getState']
//   — S 无约束(zustand 自带类型参数,StoreApi<S> 推断 WorkspaceState 等具体
//   store state shape);内部 `s[key]` 访问需 1 次 cast(Record<string, unknown>)
//   与 1 次 `as Partial<S>` 回写,签名无 any,编译期阻断 caller 传错 store 的
//   set/get,3 处 eslint-disable 注释一并删除。

import type { StoreApi } from 'zustand';

export interface PendingCommandFields<T> {
  hasPending: boolean;
  payload: T | null;
  version: number;
}

export const initPendingFields = <T>(): PendingCommandFields<T> => ({
  hasPending: false,
  payload: null,
  version: 0,
});

/**
 * request 一次 — set hasPending=true + payload + version+1。
 */
export function pendingRequest<S>(
  set: StoreApi<S>['setState'],
  key: string,
  payload: unknown,
): void {
  set((s) => {
    const cur = (s as Record<string, unknown>)[key] as PendingCommandFields<unknown>;
    return {
      [key]: { hasPending: true, payload, version: cur.version + 1 },
    } as Partial<S>;
  });
}

/**
 * consume 一次 — atomic 读 + 清零。未设置时返回 null。
 * 调用方 cast 成业务类型(`as string` / `as true`)即可,反正契约。
 */
export function pendingConsume<S>(
  get: StoreApi<S>['getState'],
  set: StoreApi<S>['setState'],
  key: string,
): unknown {
  const fields = (get() as Record<string, unknown>)[key] as PendingCommandFields<unknown>;
  if (!fields.hasPending) return null;
  set({
    [key]: { hasPending: false, payload: null, version: fields.version },
  } as Partial<S>);
  return fields.payload;
}

/**
 * peek 一次 — 只读 payload,不消费、不改 version。未设置时返回 null。
 *
 * 用途:effect 在「外部条件还没就绪」时检查 flag 但不能清掉它。比如
 *   NotesView pendingFocusNote effect:curFullId 还没到(IPC 卡死)
 *   → 不能 consume(flag 清空请求丢失)也不能 re-arm(requestFocusNote 会
 *   version++ 让 effect 立刻重跑 → 重挂自循环)。
 *   peek 拿到 payload 但不动 store,保持 armed,等下一次 activeNoteFullId
 *   变化触发 effect 重跑时再决定 consume 与否。
 *
 * 「peek + 后续条件 consume」是一个独立于 consume 的访问模式 —— 用
 * `consume()` 然后立刻 `request()` 模拟 peek 是错的(request 会 version++,
 *   让 effect dep 变化误触发额外一轮),peek helper 保留原 version,语义
 *   干净。
 */
export function pendingPeek<S>(
  get: StoreApi<S>['getState'],
  key: string,
): unknown {
  const fields = (get() as Record<string, unknown>)[key] as PendingCommandFields<unknown>;
  if (!fields.hasPending) return null;
  return fields.payload;
}
