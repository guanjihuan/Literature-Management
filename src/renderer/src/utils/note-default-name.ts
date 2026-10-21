// 笔记「默认文件名」生成器 —— 给「先写后命名」流程用。
//
// 行为契约:
//   - 入参 `existing` 是已存在的笔记 filename 列表(全部带 .md 后缀)
//   - 入参 `base` 是无后缀的默认名(走 i18n 由 caller 决定中英文)
//   - 返回值永远带 .md 后缀
//   - 命名规则(对齐 macOS Finder / VSCode New File):
//       base          → base.md
//       base 已存在    → base 1.md
//       base / base 1 → base 2.md
//       跳过空位      → 取第一个空位(base / base 2 已存在 → 返回 base 1.md)
//       撞满前 N 个   → base (N+1).md
//
// 与主进程 DUPLICATE_NAME 的关系:本函数是「客户端乐观扫描 + 跳位」,纯消除
// 90% 撞名场景。极端 race(NOTES_CHANGED 推送晚于第二次 IPC 进入主进程时)
// 仍可能 EEXIST,store.create 层再加 retry loop 兜底,详见 useNotesStore.create。
//
// 为什么不放 main/notes/:这个函数同时给 NotesList 客户端预检 + useNotesStore
// retry loop 第二次 / 第三次的命名都用,放 renderer 共享 utils 最合适。
//
// i18n:函数纯字符串,i18n 由 caller(NotesList.handleCreate / store.retry)负责:
//   - NotesList: `nextDefaultNewFilename(notes, t('notes.defaultNewFilename'))`
//   - store retry: 同上,放进 createNote retry 闭包里
// 函数本身不调 t(),保持纯可测。
import { stripExt } from '@shared/path-utils';

/**
 * 找一个不会与现有 filename 冲突的「默认」filename。
 *
 * @param existing  已存在的笔记 filename 列表(全部带 `.md`)
 * @param base      默认 base 名(不带后缀)
 * @returns         带 `.md` 后缀的新 filename
 */
export function nextDefaultNewFilename(
  existing: ReadonlyArray<{ filename: string }>,
  base: string,
): string {
  // filename → stripExt:去 .md 后缀。filename-validator 强制所有 note filename
  // 都有 .md 后缀,stripExt 不会返回无后缀名字(底层 helper 不动 .hidden)。
  const taken = new Set<string>();
  for (const e of existing) taken.add(stripExt(e.filename));
  if (!taken.has(base)) return `${base}.md`;
  // 找第一个空位 n ∈ [1, ∞) 使 `${base} ${n}` 不在 taken
  for (let n = 1; n < Number.MAX_SAFE_INTEGER; n += 1) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return `${candidate}.md`;
  }
  // 不可达:MAX_SAFE_INTEGER 个笔记同名概率 0;TS 兜底返回。
  return `${base}.md`;
}
