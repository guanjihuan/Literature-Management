// 全局「面板分隔条正在被拖拽」登记簿(r199 新增)。
//
// 为什么需要:
//   拖拽分隔条时,面板宽度**每帧都在变** ⇒ 容器里昂贵的消费者会被要求每帧
//   重排。Chromium 的 PDF 渲染器就是典型:iframe 尺寸每帧变 ⇒ 每帧多花
//   ~16ms 重排(实测 60fps → ~30fps,见 r199 的 CHANGELOG 实证)。
//   而「面板变窄」这件事本身不需要消费者每帧跟 —— 消费者只要在**拖拽结束**
//   时跟一次即可。
//
// 为什么不用 React Context:
//   拖拽可能发生在**任意**面板(左栏列表 / 主区文献列),而 PDF 在主区里 ——
//   拖左栏时 PDF 区域宽度同样在变。Context 要么在 App 层包 provider 让每个
//   面板各报自己的状态,要么各面板互相知道对方在拖;全局登记簿天然覆盖
//   「任意面板正在拖」这一事实,消费者只订阅一个布尔值。
//
// 契约:
//   - beginResizeDrag / endResizeDrag 必须**成对**调用(hook 内部用计数器
//     + ref 兜底,重复 end 不会把计数压成负数);
//   - 消费者用 useSyncExternalStore 订阅,快照是布尔值(稳定引用,不会
//     触发无限重渲)。
let activeCount = 0;
const listeners = new Set<() => void>();

function emit(): void {
  // 复制一份再遍历:listener 里可能退订(React 卸载时 cleanup 会调)
  for (const listener of Array.from(listeners)) listener();
}

/** 登记一次拖拽开始(嵌套/多面板同时拖时计数累加)。 */
export function beginResizeDrag(): void {
  activeCount += 1;
  emit();
}

/** 登记一次拖拽结束;计数已为 0 时是空操作(幂等)。 */
export function endResizeDrag(): void {
  if (activeCount <= 0) {
    activeCount = 0;
    return;
  }
  activeCount -= 1;
  emit();
}

/** 当前是否有面板分隔条正在被拖拽。 */
export function isResizeDragActive(): boolean {
  return activeCount > 0;
}

/**
 * 订阅拖拽状态变化。返回退订函数。
 * 配套 React 用法:useSyncExternalStore(subscribeResizeDrag, isResizeDragActive)
 */
export function subscribeResizeDrag(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 仅测试用:把计数复位(防止某个用例漏调 endResizeDrag 污染后续用例)。 */
export function resetResizeDragRegistry(): void {
  activeCount = 0;
  listeners.clear();
}
