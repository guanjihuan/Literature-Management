// src/renderer/src/store/_clipboard-consume.ts
//
// audit-r157:moveToFolder 后清剪贴板 跨 store dedup。
//   notes.ts:329-336 与 literature.ts:288-294 字节级相同 8 行块抽公共 helper。
//
// 行为契约(无变更 —— 完全保留原 hook 形态 + 注释意图):
//   1. clipboard === null           → no-op(set 不调)
//   2. clipboard.mode === 'copy'    → no-op(只切 cut 才消费)
//   3. clipboard.mode === 'cut' + 全命中  → set({clipboard: null})
//   4. clipboard.mode === 'cut' + 部分命中 → set({clipboard: {ids: remaining, mode: 'cut'}})
//   5. clipboard.mode === 'cut' + 0 命中    → no-op(set 不调)
//   6. moveResources 失败由 caller 处理(IPC reject 抛前不调本 helper,
//      抛后 clipboard 不动可重试)。
//
// 类型:S extends { clipboard: ClipboardState } —— 只约束必要字段,调用方
//   store(NotesState / LiteratureState)直接共享,无需另立 alias。
//
// 命名:`_` 前缀表示 internal helper(避免 dead-export-guard 把它当外部 export
//   抓;实际是导出 helper 但仅 store 内消费)。

import type { StoreApi } from 'zustand';

export type ClipboardState = { ids: string[]; mode: 'copy' | 'cut' } | null;

/**
 * 把移走的 id 从 cut 剪贴板里剔掉;全剔完则清空剪贴板(否则 cut 行卡
 *   opacity-50 直到下次 Ctrl+V)。copy 模式不动。
 *
 * 用法:moveToFolder IPC 成功后调一次;失败路径(moved throw)不调。
 *
 * 替代:`notes.ts:329-336` 与 `literature.ts:288-294` 原 8 行内联块。
 */
export function consumeMovedFromClipboard<S extends { clipboard: ClipboardState }>(
  set: StoreApi<S>['setState'],
  get: StoreApi<S>['getState'],
  movedIds: string[],
): void {
  const clip = get().clipboard;
  if (!clip || clip.mode !== 'cut') return;
  const movedSet = new Set(movedIds);
  const remaining = clip.ids.filter((id) => !movedSet.has(id));
  if (remaining.length === clip.ids.length) return; // 0 命中 no-op
  set({
    clipboard: remaining.length === 0 ? null : { ids: remaining, mode: 'cut' },
  } as Partial<S>);
}