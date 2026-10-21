// src/renderer/src/store/failed-drafts.ts
//
// 笔记保存失败时的 body/title 暂存缓冲 —— 模块级 Map,**故意**不放在 ref 上:
//
//   - ref 随组件 unmount 消失,但「关面板 → 重开」正是最需要它活着的场景
//   - 进程级单例,renderer 整个生命周期内同一 note.id 复用同一草稿
//   - 成功保存 / delete / rename 时清掉,避免无界堆积
//
// 抽象到这里(audit r35,2026-10-08)是因为之前由 StandaloneNoteEditorCore
// 直接持有,store/notes.ts 通过 `import { clearFailedDraft } from
// '../components/notes/StandaloneNoteEditorCore'` 反向引用组件层 → 与
// StandaloneNoteEditorCore `import { useNotesStore } from '../../store/notes'`
// 形成循环依赖。layering test 直接红。
//
// 修复:把 Map + API 抽到 store 下的零依赖叶子模块,store/notes 与
// StandaloneNoteEditorCore 都从这里单向 import,循环消除。
//
// 不引入 size cap / LRU:r34 fix-log 已记录「per-note 草稿 < 1MB,正常用户
// 编辑会话触发频率低」,先解决循环依赖问题,后续真有 leak 报告再加 guard。
//
// audit-r113:单例/覆盖/clear 三承诺 + 「本文件零 import」结构不变式首补契约锁
// tests/unit/renderer/store/failed-drafts.test.ts(零依赖探针加 type import 即红)。

export interface FailedDraft {
  body: string;
  title: string;
}

const failedDrafts = new Map<string, FailedDraft>();

/** 暂存某 id 的失败草稿(覆盖旧值)。 */
export function putFailedDraft(id: string, draft: FailedDraft): void {
  failedDrafts.set(id, draft);
}

/** 取草稿 —— 不存在返 undefined。 */
export function getFailedDraft(id: string): FailedDraft | undefined {
  return failedDrafts.get(id);
}

/** 删某 id 的草稿(delete / rename / flush 成功后用)。 */
export function clearFailedDraft(id: string): void {
  failedDrafts.delete(id);
}
