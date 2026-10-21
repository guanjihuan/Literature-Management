// z-index 分层 — 单一来源,所有浮层/覆盖层从此处取值。
// (audit-r88 行为锁:tests/unit/renderer/lib/single-source-constants-parity
//  静态扫描裸 `zIndex: 数字` 与 `z-[N]` 任意值类;标准类 z-10 = 局部
//  stacking context 语义,故意不在锁内,见该文件头注释规则 2。)
//
// 设计意图:避免"ContextMenu 比 Modal 还高、Toast 跟 Overlay 同层"的散乱情况。
// 同层元素按 DOM 顺序后渲染者覆盖先渲染者,所以同一层在视觉上是稳定的。
//
// 用法:在 style 中引用 `Z.modal` 等;Tailwind 语法里没有 `z-[60]` 这种字符串,
// 所以保留 React style 内联。
//
//   层级        用途
//   ----------  -----------------------------------------------
//   chrome      header / 拖拽手柄 / tab 滚动按钮   (10–20)
//   tooltip     标题栏快捷键提示                    (40)
//   overlay     Modal / Drawer + 全局搜索下拉        (50)
//   contextMenu 右键菜单 + 子菜单                   (60)
//   toast       操作反馈                            (70)
//   critical    致命错误 / 不可关闭的硬阻塞          (80)
//
// audit (2026-09 V1.6):删 handle(30) —— 原注释列的 ActivityBar hover 把手
//   已在 V1.4 整条下线(grep 0 caller;workspace.ts / menu.ts / App.tsx
//   注释多处确认 ActivityBar 不存在)。chrome(10) 已覆盖 header 拖拽手柄,
//   真正用到"hover 把手"的场合没有,留下只是 dead entry。

export const Z = {
  chrome: 10,
  tooltip: 40,
  overlay: 50,
  contextMenu: 60,
  toast: 70,
  critical: 80,
} as const;
