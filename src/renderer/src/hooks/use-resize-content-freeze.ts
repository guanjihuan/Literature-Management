// 拖拽分隔条期间冻结「内容宽度」—— 内容不重排,只有面板边框在动。
//
// 背景(r230 实测,Electron 真机 + CDP 帧间隔采样):
//   拖拽路径已经是「perf 路径」(useResizablePanel 拖拽期间直写 DOM,
//   绕过 React 重渲),所以卡顿**不在 JS**,而在**布局**:面板宽度每帧变 ⇒
//   被拖动那一侧的所有内容每帧重新布局一次。
//   实测(双列 + 笔记列开「渲染显示」):
//     正文 15KB → 每帧布局 0.8ms   → 60fps 流畅
//     正文 41KB → 每帧布局 2.9ms   → 60fps 流畅
//     正文 189KB(含 200 张表格)→ 每帧布局 **28ms**(拖文献列分隔条)
//                                   / **50ms**(拖左侧栏分隔条)
//                                   → 中位帧 66.7ms,60/60 帧超 50ms,肉眼可见的拖不动。
//   根因 = 文本重新折行 + 表格重新布局(表格布局算法是 O(单元格数) 且不缓存)。
//
//   关键点:卡顿**与拖哪个分隔条无关** —— 拖左侧栏时主区宽度同样每帧变,
//   主区里的长文档照样每帧重排(上面 50ms/帧那一组就是拖左侧栏测出来的)。
//   所以冻结必须是**全局**的:任意分隔条在拖 ⇒ 任意面板的内容都冻结。
//
// 做法(与 PDFReader 的 iframe 冻结同源思路,r202):
//   拖拽开始 → 把内容根元素的宽度**钉死**成拖拽开始那一刻的像素值
//   ⇒ 内容不再重排(文本不折行 / 表格不重算 / 图片不重新缩放);
//     面板边框照常跟手,内容被裁切(overflow)而不是重排。
//   拖拽结束 → 解冻,内容一次性跟上最终宽度(1 次重排,可接受)。
//
// 为什么不用 React 状态驱动:
//   冻结必须在 pointerdown 的**同一帧**生效(否则头几帧已经白重排了),
//   而 useSyncExternalStore 的重渲是异步调度的 ⇒ 这里直接订阅全局登记簿
//   (lib/resize-drag-registry),回调里同步改 DOM,不触发任何重渲。
import { useEffect, useRef, type RefObject } from 'react';
import { isResizeDragActive, subscribeResizeDrag } from '../lib/resize-drag-registry';

/**
 * 在「任意分隔条正在被拖拽」期间,把 ref 指向的内容根元素宽度钉死。
 *
 * 契约:
 *   - ref 必须指向**内容根元素**(滚动容器 / 文档根),不是面板外壳 ——
 *     钉外壳宽度等于没钉(外壳宽度本来就每帧在变)。
 *   - 元素自身的 inline width / overflow-x 会被临时改写,拖拽结束原样还原。
 *   - 元素需自带 overflow 裁切(或其父级有),否则钉住的内容会溢出到相邻列。
 *   - 嵌套拖拽安全:重复 begin 不会重复钉(幂等),end 时按登记簿计数还原。
 */
export function useResizeContentFreeze(ref: RefObject<HTMLElement | null>): void {
  // 还原函数(闭包持有被改动的 inline 样式);null = 当前没在冻结。
  const restoreRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const freeze = (): void => {
      // 已在冻结中 → 什么都不做(登记簿计数可能 >1,但宽度只需要钉一次)。
      if (restoreRef.current) return;
      const el = ref.current;
      if (!el) return;
      const prevWidth = el.style.width;
      const prevOverflowX = el.style.overflowX;
      const w = el.getBoundingClientRect().width;
      // 宽度为 0(未布局 / 隐藏)时不钉 —— 钉 0 会让内容彻底消失。
      if (w > 0) el.style.width = `${Math.round(w)}px`;
      // 横向溢出裁掉:钉住的宽度可能大于当前面板宽度(拖窄时),
      // 让它出横向滚动条会把纵向空间也吃掉(多一次布局抖动)。
      el.style.overflowX = 'hidden';
      restoreRef.current = () => {
        el.style.width = prevWidth;
        el.style.overflowX = prevOverflowX;
        restoreRef.current = null;
      };
    };
    const unfreeze = (): void => {
      restoreRef.current?.();
    };
    // 登记簿广播时同步生效:begin → 钉;end → 还原。
    // 用 isResizeDragActive() 判别方向(登记簿只广播「变了」,不带方向)。
    const onResizeDragChange = (): void => {
      if (isResizeDragActive()) freeze();
      else unfreeze();
    };
    const off = subscribeResizeDrag(onResizeDragChange);
    return () => {
      off();
      // 卸载时还原:组件被卸载(切 Tab / 关列)时不能把 inline 样式留成冻结态
      // (元素虽然没了,但同一 DOM 节点可能被复用 —— 还原是零成本的保险)。
      unfreeze();
    };
  }, [ref]);
}
