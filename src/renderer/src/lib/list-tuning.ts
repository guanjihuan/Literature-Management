// 列表虚拟滚动调优常量 — 两处 Virtuoso 共享
// (audit-r88 行为锁:tests/unit/renderer/lib/single-source-constants-parity
//  禁止 JSX 裸 `overscan={数字}`,违例直接红。)
//
// audit round 19 (2026-09-15):CQ-020 — LibraryList + NotesList 之前各自
//   写裸 `overscan={400}`,调一处忘另一处导致 UI 行为不一致。集中到
//   lib/list-tuning.ts 作为 single source of truth,改一处两处生效。
//
// 400 px 是 react-virtuoso 推荐的 overscan 经验值 —— 让快速滚动到
// list 底部时空白行可见时间 ≤ 1 帧;5000 行图书馆仍保持 60fps。
// 值再大可减空白但浪费 DOM,再小会出现"滚到底之前短暂空白"。
export const LIST_OVERSCAN_PX = 400;
