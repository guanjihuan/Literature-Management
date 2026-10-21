// src/renderer/src/lib/move-remap.ts
//
// 搬移后的 **id 重映射**纯函数(notes 域 + literature 域共用)。
//
// 背景:fs.rename 之后资源 id 会重算 ——
//   - notes 域:id 由 relPath 派生(frontmatter id 随文件重钉)
//   - literature 域:id = 'lit:' + absPath,absPath 变 → id 变
// 于是「搬移前拿到的 id」在搬移后是**死 id**:指向它的 selectedId /
// selectedIds 会让编辑器撞 NOT_FOUND,按 Delete / Ctrl+X 也命中空集。
//
// 这两个纯函数是 r175 修复的落点(此前 notes / literature 两个 store
// 各写一份字节级相同的重映射逻辑):
//
//   1. remapSelectedIds —— 把复数选中集里的旧 id 换成新 id
//   2. remapSelectedId  —— 把单数选中态(编辑器打开态)换成新 id
//
// r177:第三个纯函数 landedIdsAfterMove(把「一批待搬 id」映射成「落地后
//   的 id 列表」)随「导入后不自动打开」一起退役 —— 它唯一的生产调用方是
//   NotesList.importFiles 的自动选中(选最后一条导入的笔记)。导入不再选中,
//   就没有「拿落地 id 去 select」的需求;id 重映射由 store 内部的
//   applyMoveRemap 负责(成功/部分失败两条路都刷)。
//
// 纯函数、无副作用 → 行为级单测不必起 React 渲染。

/** 搬移映射条目 —— 两个域共用的最小形状(实际字段由各域 IPC 决定)。 */
export interface MoveRemapEntry {
  id: string;
  relPath?: string;
  absPath?: string;
}

/** oldId → newId 映射表。 */
export type MoveRemap = Map<string, MoveRemapEntry>;

/**
 * 把复数选中集里的旧 id 换成新 id。
 *
 * - 只有落在 idRemap 里的成员会被换;其余成员原样保留。
 * - 返回**新 Set**(不改入参),没有命中时返回 null —— 调用方据此避免
 *   无谓的 setState(省一次列表 re-render)。
 *
 * 旧实现只刷单数 selectedId,复数 selectedIds 留着死 id:窗口期内
 * cut/copy 算出空 id 列表(剪贴板不落),按 Delete 一条都删不掉。
 */
export function remapSelectedIds(
  selectedIds: ReadonlySet<string>,
  idRemap: MoveRemap,
): Set<string> | null {
  if (idRemap.size === 0) return null;
  let next: Set<string> | null = null;
  for (const [oldId, entry] of idRemap) {
    if (!selectedIds.has(oldId)) continue;
    if (!next) next = new Set(selectedIds);
    next.delete(oldId);
    next.add(entry.id);
  }
  return next;
}

/**
 * 把单数选中态换成新 id(旧 id 不在映射里 → 原样返回)。
 * 返回 null 表示「没有需要改的」,调用方据此跳过 setState。
 */
export function remapSelectedId(selectedId: string | null, idRemap: MoveRemap): string | null {
  if (!selectedId) return null;
  const entry = idRemap.get(selectedId);
  if (!entry) return null;
  return entry.id;
}
