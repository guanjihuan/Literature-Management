// src/renderer/src/lib/order-persistence.ts
//
// 侧栏文件排序(displayOrder)的 localStorage 适配器(audit-r143,2026-10-19)。
//   - 排序是 UI 偏好,**不**进 SQLite schema(理由:跨 7 个 migration + 3 个
//     write path + 2 store type + 4 IPC literal 同步加列 + backfill,变更面
//     远超 UI 偏好承担的成本,且无跨机器/跨端同步需求)。
//   - key 按 UI 策略:rkms:sidebarOrder:v1:<kind>。v1 留给未来格式升级
//     (如把 number → Map<id,order> 序列化为有序数组)。
//   - 防御面:load 损坏/缺字段不抛,save quota 抛错也吞。**localStorage 本身
//     拿不到(不存在 / 访问被拒 / getter 抛)也不抛** —— r197 补:这层
//     以前只包住 JSON.parse,存在性探测和 getItem 都在 try 外,而 loadOrder
//     是 store **模块 init** 期调用的 ⇒ 抛出去等于整个 store 模块加载失败。
//     store 内部用,UI 不直接接触,所以传值由 store 守门(非数字/非字符串键
//     已在本层筛掉,store 收到的都是 number)。
import type { ResourceKind } from '@shared/types';

/** displayOrderById 的 value 类型 —— 数字,小者靠前。 */
export type DisplayOrderMap = Record<string, number>;

const KEY_PREFIX = 'rkms:sidebarOrder:v1:';

function keyOf(kind: ResourceKind): string {
  return `${KEY_PREFIX}${kind}`;
}

/**
 * 安全取 localStorage 句柄。
 *
 * r197:不能用 `typeof localStorage === 'undefined'` 做存在性探测 ——
 *   ① `typeof` 只挡 ReferenceError(未声明标识符),**不挡 getter 抛异常**。
 *      Chromium 对不透明 origin(file:// / 站点数据被禁 / 隐私模式)访问
 *      localStorage 会抛 SecurityError,探测本身就炸。
 *   ② 本函数在 **store 模块 init** 时被调(store/notes.ts:298、
 *      store/literature.ts:217 的初始 state),一旦抛 ⇒ 整个 store 模块
 *      加载失败 ⇒ 列表/侧栏白屏,用户完全看不到原因。
 *
 * 返回 null 表示「用不了 localStorage」,caller 走降级分支。
 */
function safeLocalStorage(): Storage | null {
  try {
    // 裸标识符在真的没有 localStorage 的环境里会 ReferenceError → 这里一并吞掉
    const ls = typeof globalThis !== 'undefined' ? (globalThis as { localStorage?: Storage }).localStorage : undefined;
    return ls ?? null;
  } catch {
    return null;
  }
}

/**
 * 从 localStorage 读出指定 kind 的排序映射。
 * 缺数据 / JSON 损坏 / 形状不对 → 返回空 {}(caller 走默认顺位)。
 * 单条记录键或值类型不对 → 静默丢弃该条(其它条仍生效)。
 * localStorage 不可用(不存在 / 访问被拒 / getItem 抛) → 返回 {} 不抛。
 */
export function loadOrder(kind: ResourceKind): DisplayOrderMap {
  const ls = safeLocalStorage();
  if (!ls) return {};
  let raw: string | null = null;
  try {
    raw = ls.getItem(keyOf(kind));
  } catch {
    return {};
  }
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: DisplayOrderMap = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === 'number' && Number.isFinite(v) && typeof k === 'string' && k.length > 0) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * 把指定 kind 的排序映射写入 localStorage。
 * 任何 throw(quota / disabled / etc)都吞 —— 排序持久化失败不应阻塞 UI。
 */
export function saveOrder(kind: ResourceKind, map: DisplayOrderMap): void {
  const ls = safeLocalStorage();
  if (!ls) return;
  try {
    ls.setItem(keyOf(kind), JSON.stringify(map));
  } catch {
    // 静默:UI 偏好写入失败属于 best-effort,不影响列表功能。
  }
}
