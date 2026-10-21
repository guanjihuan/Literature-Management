// src/main/window-defaults.ts
//
// 窗口初始尺寸的唯一来源(抽出来的原因:src/main/window.ts 顶层 import
// 'electron' → 单元测试里 import 它会拉起原生 electron 模块,没法直接断言
// 数值;把这几个纯数字挪进独立文件后,tests/unit/main/window-defaults.test.ts
// 可以无 electron 依赖地锁住契约)。
//
// 语义:
//   - DEFAULT_WINDOW_WIDTH / HEIGHT 是**冷启动**时的初始尺寸。
//     本应用不持久化窗口 bounds(无 getBounds/setBounds 落盘),所以每次
//     启动都用这里的默认值 —— 用户拖过/最大化过也不影响下次启动。
//   - MIN_WINDOW_WIDTH / HEIGHT 是用户可手动缩到多小(下界)。
//   - MIN 必须 ≤ DEFAULT,否则窗口一创建就比允许的最小尺寸还小,用户的
//     「缩到最小」操作会被 Chromium 静默顶回,手感像 bug。
//
// audit r176 (2026-10-19):默认宽度 1280 → 1440(用户报「默认界面宽度可以
//   再稍微宽一些」)。1440 落在 1366×768 笔记本之外的屏上时,Electron 会
//   自行把窗口收进可视区域(Windows 上按 workArea 裁剪),不会把标题栏/
//   关闭按钮挤出屏幕;但 MIN_WINDOW_WIDTH 仍必须 ≤ 常见小屏宽度 1366,
//   否则 1366 屏用户根本没法把窗口拖到最窄。
export const DEFAULT_WINDOW_WIDTH = 1440;
export const DEFAULT_WINDOW_HEIGHT = 800;
export const MIN_WINDOW_WIDTH = 900;
export const MIN_WINDOW_HEIGHT = 600;
