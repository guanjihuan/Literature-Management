// 旧 id → 新 id 的重映射登记处(notes 域)。
//
// 为什么需要 —— 主进程的笔记 id = relPath 的哈希(standalone.ts 的 repin 规则)
//   ⇒ 文件一旦被**搬移**或**改名**,同一个文件就换了 id,旧 id 在主进程的
//   byId 里被删除(死键,write 旧 id 必撞 NOT_FOUND)。
//
//   renderer 侧所有以 id 为键的状态(选中集 / 正在编辑的那篇 / 失败草稿)
//   都必须跟着换。store 在搬移/改名时已经更新了 selectedId / selectedIds /
//   activeNoteFull(r175),但**没有**告诉「编辑器正在编辑的那篇」的未落盘内容
//   该落到哪个 id —— 编辑器切笔记 flush 时按旧 id 写 ⇒ 主进程 NOT_FOUND ⇒
//   内容只进 failedDrafts(**旧 id 键**)⇒ 而笔记现在的新 id 取不到那份草稿
//   ⇒ 这段字永久消失(audit 2026-10-21 P0 数据丢失)。
//
// 本模块是「旧 id 现在对应哪个新 id」的**唯一**登记处:store 登记、编辑器
//   查询。放 lib/ 而不是 store 内联 ——
//     1) 编辑器要在**不 import store** 的前提下解析(否则 store ↔ 组件成环,
//        且现有守卫测试 mock 掉 store 模块时编辑器会拿到 undefined);
//     2) 文献域将来若有同样的需求,可以直接复用同一份判据。
//
// 为什么不是「靠 relPath 推断」:移动/改名**必然**改 relPath,而 r192 的漂移
//   判据恰恰是「同 relPath ⇒ 同一个文件」⇒ 移动场景下判据必然为 false ⇒
//   只能靠显式的 id 映射表。

/** 旧 id → 新 id。插入顺序 = 登记顺序 ⇒ 可按插入序淘汰最旧的。 */
const _remaps = new Map<string, string>();

/** 最多留多少条 —— 一次搬移/改名只登记一条,200 条足够覆盖任何会话。 */
const MAX_REMAPS = 200;

/**
 * 登记一次「旧 id 变成了新 id」。
 *
 * @param oldId 搬移/改名**之前**的 id(主进程已不再认识它)
 * @param newId 搬移/改名**之后**的 id(主进程现在认识它)
 */
export function registerIdRemap(oldId: string, newId: string): void {
  if (!oldId || !newId || oldId === newId) return;
  // 同一旧 id 重复登记(同一篇被搬了两次)⇒ 覆盖为最新,并把插入序挪到末尾
  // (否则它会被当成"最旧的一条"提前淘汰)。
  _remaps.delete(oldId);
  _remaps.set(oldId, newId);
  while (_remaps.size > MAX_REMAPS) {
    const oldest = _remaps.keys().next();
    if (oldest.done) break;
    _remaps.delete(oldest.value);
  }
}

/**
 * 解析「这个旧 id 现在对应哪个 id」。
 *
 * 未登记 ⇒ 原样返回(调用方按「没换过 id」处理,与旧行为一致)。
 * 链式(A→B→C)会顺着查到终点 —— 同一篇被搬两次时不能停在中间那环。
 */
export function resolveNoteId(oldId: string): string {
  let cur = oldId;
  // 上限 8 跳:防登记成环(A→B→A)时死循环。
  for (let hops = 0; hops < 8; hops += 1) {
    const next = _remaps.get(cur);
    if (next === undefined || next === cur) break;
    cur = next;
  }
  return cur;
}

/** 登记表里有多少条(诊断用)。 */
export function noteIdRemapSize(): number {
  return _remaps.size;
}

/** 清空登记表(测试用)。 */
export function resetNoteIdRemap(): void {
  _remaps.clear();
}
