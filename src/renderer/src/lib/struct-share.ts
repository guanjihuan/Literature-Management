// src/renderer/src/lib/struct-share.ts
//
// perf r258:IPC 快照的**结构共享** —— 把「内容没变」的条目沿用上一轮的
// 对象引用。
//
// ── 背景(用户诉求「使用流畅,不要有卡顿」)────────────────────────────
//   两个列表 store(notes / literature)的 load() 都把 IPC 回来的快照**整表
//   替换**进 state。IPC 走 structured clone ⇒ 每次回来的都是**全新对象**
//   (内容一模一样也是新引用)。于是:
//
//     ① store.notes / store.items 的引用每轮都变;
//     ② 组件用 `useShallow(s => s.notes)` 订阅 —— 而 useShallow 的浅比是
//        **逐元素 Object.is** ⇒ 元素全是新引用 ⇒ 浅比恒为「不等」⇒
//        **useShallow 在这两处从来没生效过**(注释里写的「浅比较元素相同
//        时不重渲」是**假绿**:元素引用从不相同);
//     ③ 每次 NOTES_CHANGED / LITERATURE_CHANGED(自动保存、外部改盘、网盘
//        同步落盘、另一个窗口写盘……)⇒ 整个可见列表 + 每一行都重渲 ——
//        列表越长越明显(2000 篇时每次广播都白刷一遍可见窗口)。
//
// ── 修法 ─────────────────────────────────────────────────────────────
//   load() 里把「字段全等」的条目换成**上一轮那个对象**(结构共享):
//     · 没变的条目 ⇒ 引用不变 ⇒ useShallow 的浅比真的相等 ⇒ 整表不重渲;
//     · 变了的条目 ⇒ 换新对象 ⇒ React.memo 的行组件只重渲那一行。
//
// ── 为什么比对要「数组逐元素」而不是纯 Object.is ─────────────────────
//   笔记摘要带 `tags: string[] | null` —— IPC clone 后是新数组。纯
//   Object.is 会把「标签一模一样」的笔记判成「变了」⇒ 结构共享永远不
//   生效 ⇒ 本文件白写。其它字段(标量)逐个比。

/**
 * 两个「同一实体」的快照是否等价。
 *
 * 逐字段浅比;字段值是数组时逐元素比(见文件头注:tags)。
 * null/undefined 与对象都按「同字段名 + 同值」处理。
 */
export function sameSnapshot(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = Object.keys(ao);
  if (keys.length !== Object.keys(bo).length) return false;
  for (const key of keys) {
    const va = ao[key];
    const vb = bo[key];
    if (Array.isArray(va) && Array.isArray(vb)) {
      if (va.length !== vb.length) return false;
      for (let i = 0; i < va.length; i += 1) {
        if (!Object.is(va[i], vb[i])) return false;
      }
    } else if (!Object.is(va, vb)) {
      return false;
    }
  }
  return true;
}

/**
 * 结构共享:把 `next` 里「与 `prev` 中同 id 条目字段全等」的条目换成
 * `prev` 那一份对象引用。
 *
 * 返回值有三种可能:
 *   · `prev` 本身(元素与顺序都没变)—— 订阅者拿到的引用完全不变 ⇒
 *     useShallow / React.memo 全部命中,零重渲;
 *   · 新数组(有变化或顺序变了),但**没变的条目沿用旧对象**—— 只有变了的
 *     那几行会重渲;
 *   · `next` 原样(prev 为空 —— 没有可沿用的旧对象)。
 */
export function shareUnchanged<T extends { id: string }>(prev: T[], next: T[]): T[] {
  if (prev.length === 0 || next.length === 0) return next;
  const prevById = new Map<string, T>();
  for (const p of prev) prevById.set(p.id, p);
  const merged = next.map((n) => {
    const p = prevById.get(n.id);
    return p && sameSnapshot(p, n) ? p : n;
  });
  // 元素与顺序都没变 ⇒ 沿用旧数组引用(useShallow 的订阅者完全不重渲)
  if (merged.length === prev.length && merged.every((m, i) => m === prev[i])) return prev;
  return merged;
}
