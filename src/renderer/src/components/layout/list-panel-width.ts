// 左侧列表面板(文献 / 笔记 Tab)宽度策略 —— 单一事实源。
//
// 历史(默认值来回调过三轮,每次都由用户拍板):
//   r132 (2026-10-18):min 240→300、default 280→320、max 480→720
//                     —— 用户嫌默认太窄、长标题截断。
//   r175 (2026-10-19):min 300→200、default 320→240、max 720 不动
//                     —— 用户报「最小宽度和默认宽度都偏大」(320 被否过)。
//   r238 (2026-10-21):default 240→280 —— 用户又要求「稍微宽一些」。
//                     min 200 / max 720 不动(拖宽天花板保留)。
//   r241 (2026-10-21):default 280→300 —— 用户第二次说「稍微宽一些」。
//                     仍取「稍微」(+20)而不是 320:320 是 r175 被明确否掉的
//                     值(「默认宽度偏大」),这次要的是比 280 略宽一点。
//                     300 从未当过默认值,是 280 与 320 之间的空档。
//                     min 200 / max 720 不动。
//
// 迁移(storageKey 必须升版 —— 这是每次改默认值最容易漏的一步):
//   useResizablePanel 的 [width] effect 会把**当前宽度**在非拖拽时落盘,
//   包括首次挂载时的默认值 ⇒ 「默认值」第一次运行后就被固化进
//   localStorage。只改常量不改 key ⇒ 存量用户永远看不到新默认。
//   所以本轮升版 storageKey:'workbench.listPanel.width.v3' → '...v4'。
//
//   但纯升版会把**用户手动拖过的宽度**也一起丢掉。r175 接受了这个取舍
//   (「用户要的是默认更窄,存量手动偏好让位于新默认」),r238 起可以做得更好:
//   升版同时做一次**定向迁移** —— 旧 key 里存的值若**等于旧默认值 280**,
//   说明它只是自动落盘的默认(用户没拖过)⇒ 丢弃,让新默认 300 生效;
//   其它值视为用户真拖过的偏好 ⇒ 搬到新 key,不丢用户的手动设置。
//   边界情形:用户恰好手动拖到 280 —— 会被当成「没拖过」而升到 300
//   (280 正是上一版默认,视觉上无差,可接受)。
//
//   ⚠ 下次改默认值时的 checklist(别只改常量):
//     ① LIST_PANEL_DEFAULT 改新值;
//     ② LIST_PANEL_WIDTH_KEY 升版(v4 → v5)—— 存量值否则永远压着新默认;
//     ③ PREV_LIST_PANEL_DEFAULT 改成**上一个默认值**(280 → 300),
//        并把 migrateLegacyListPanelWidth 的源 key 换成上一版 key ——
//        它用来识别「自动落盘的默认」,不改就会把老用户卡在旧默认上。
//
// r240 (2026-10-21):WorkbenchListPanel 的 Tabs 行右侧加了「恢复默认宽度」
//   按钮(拖过分隔条后的一键回退)。它复用的就是本文件的 LIST_PANEL_DEFAULT
//   (hook 的 onResizeReset → setWidth(defaultWidth)),**不新增常量**。
//   ⇒ 复位后的宽度 = 默认值,和「用户没拖过」在存储上是同一个值 ——
//     这正好符合上面的迁移口径(值 == 旧默认 ⇒ 视为没拖过 ⇒ 下次升版时
//     跟着新默认走)。所以复位按钮**不会**让未来的默认升级对用户失效。
export const LIST_PANEL_MIN = 200;
export const LIST_PANEL_MAX = 720;
export const LIST_PANEL_DEFAULT = 300;

/**
 * 上一版的默认值 —— 用于识别「自动落盘的默认」,不迁移。
 * ⚠ 每次升版 storageKey 时必须同步更新成上一个默认值(见文件头 checklist)。
 */
const PREV_LIST_PANEL_DEFAULT = 280;

/** localStorage key(升版后 v1 / v2 / v3 的偏好不再直接生效) */
export const LIST_PANEL_WIDTH_KEY = 'workbench.listPanel.width.v4';

/** v3 key —— 本轮从它定向迁移「用户手动拖过」的宽度 */
export const LEGACY_LIST_PANEL_WIDTH_KEY = 'workbench.listPanel.width.v3';

/**
 * 把 v3 里「用户手动拖过」的宽度搬到 v4。
 *
 * 调用时机:**必须早于** useResizablePanel 的首次 useState 初始化
 * (它的初始化器只在挂载时读一次 localStorage)。⇒ WorkbenchListPanel
 * 在渲染体里、调用 hook 之前调本函数。
 *
 * 幂等:v4 里已有值 → 直接返回(不覆盖用户在新 key 下已有的偏好)。
 * 失败(隐私模式 / Storage 被禁)→ 静默忽略,回落默认宽度。
 */
export function migrateLegacyListPanelWidth(): void {
  try {
    if (localStorage.getItem(LIST_PANEL_WIDTH_KEY) !== null) return;
    const raw = localStorage.getItem(LEGACY_LIST_PANEL_WIDTH_KEY);
    if (raw == null) return;
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return;
    // 等于旧默认 ⇒ 只是自动落盘,没拖过 ⇒ 不迁移(让新默认生效)
    if (n === PREV_LIST_PANEL_DEFAULT) return;
    // 越界值(旧区间外的脏数据)⇒ 丢弃
    if (n < LIST_PANEL_MIN || n > LIST_PANEL_MAX) return;
    localStorage.setItem(LIST_PANEL_WIDTH_KEY, String(n));
  } catch {
    // 隐私模式 / Storage 被禁 —— 静默忽略(与 useResizablePanel 的读路径同策略)
  }
}
