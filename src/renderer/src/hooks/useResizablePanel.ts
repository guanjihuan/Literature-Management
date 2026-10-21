// 可拖拽面板 hook:承载"鼠标拖拽 + 边界约束 + localStorage 持久化"的通用关注点。
// 不耦合任何消费者业务(如 Sidebar 的 PDF 自动收窄由消费者自己处理)。
//
// perf (2026-09-04):拖拽期间绕过 React 重渲 —— mousemove 只改 panel DOM 的
//   style.width,React state 在 mouseup 时一次性提交。
//   旧实现每次 mousemove 都 _setWidth → 整棵子树(包括重型 PDFReader)被 React
//   重渲 60~120 次/秒,鼠标拖动明显卡顿。
//   现在拖拽期间 React 树完全不动,DOM 由 panelRef.current.style.width 直写;
//   mouseup 时一次性 _setWidth(committed),触发 1 次重渲以保持 state 与 DOM 一致。
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefCallback,
} from 'react';
import { createLogger } from '../lib/logger-client';
import { errMsg } from '../lib/error';
import { beginResizeDrag, endResizeDrag } from '../lib/resize-drag-registry';

const log = createLogger('useResizablePanel');

export interface ResizablePanelOptions {
  /** localStorage key。不同面板用不同 key 互不冲突 */
  storageKey: string;
  /** 加载失败 / 越界时回落到的默认宽度 */
  defaultWidth: number;
  /** 最小宽度(单位同 width 默认 px,或 0-1 的小数当 unit='pct') */
  min: number;
  /** 最大宽度(单位同 width) */
  max: number;
  /**
   * 手柄位置。
   * - 'left'  : 手柄在面板右沿,向右拖 = 加宽
   * - 'right' : 手柄在面板左沿,向左拖 = 加宽
   */
  side: 'left' | 'right';
  /**
   * 单位: 'px'(默认) 或 'pct'。
   * - 'px': min/max/width 都是像素。消费者用 `style={{ width }}`。
   *   视口缩放时,已夹紧到 [min, max] 后不再变化。
   * - 'pct': min/max/width 都是 0-1 的小数(如 0.5 表示 50%)。
   *   消费者用 `style={{ width: `${width * 100}%` }}`。视口缩放时比例保持,
   *   面板按当前容器宽度等比缩放(适合工作台主区这种"占满"场景)。
   */
  unit?: 'px' | 'pct';
  /**
   * 窗口缩放后,本面板允许的最大宽度(px)。
   * 仅 unit='px' 时生效 —— 'pct' 模式下宽是相对值,无此约束。
   * 默认按"视口 60%"算;消费者传更精确的边界(知道对面还有侧栏面板时)
   * 能避免主区被压成 0。
   */
  getMaxForWindow?: () => number;
  /**
   * 首次真正 mousemove 时回调一次(单击手柄不触发)。
   * 消费者用它区分"用户真的拖了"和"用户只是点击"——例如 Sidebar 据此
   * 标记 userDraggedRef,影响后续 PDF 自动收窄逻辑。
   */
  onUserDrag?: () => void;
}

export interface ResizablePanelApi {
  /** 当前宽度(单位同 unit —— px 是数字像素,pct 是 0-1 的小数) */
  width: number;
  /**
   * 单位 —— 让消费者在渲染时按需格式化(aria-valuetext / title / 自定义 tooltip)。
   * audit-r142 加:之前未暴露,VerticalResizeHandle 写死 px,假设全局 px。
   *   加 Worktree 后 UI 拿到 unit,pct 模式不再硬编码单位。
   */
  unit: 'px' | 'pct';
  /** 是否正在拖拽 —— 消费者用于视觉强化手柄(变粗 / 加阴影 / 加 outline) */
  dragging: boolean;
  /**
   * panel 元素 callback ref —— 必须绑到承载 width 的 `<div>`。
   * 拖拽期间 hook 会直接写 panel.style.width 跳过 React 重渲;
   * 绑错元素 / 不绑,拖拽期间宽度不会变化(commit 在 mouseup 一次性生效)。
   */
  panelRef: RefCallback<HTMLElement>;
  /**
   * 手柄 onPointerDown 绑定。
   * r199 起是 **pointer** 事件(不再是 mouse 事件):只有 pointer 事件带
   *   pointerId,才能 setPointerCapture —— 拖出窗口再松开时事件仍回到手柄,
   *   拖拽不会卡死(光标 / userSelect 残留、面板停在半途)。
   */
  onResizeStart: (e: ReactPointerEvent) => void;
  /** 双击手柄 / 复位按钮 onClick 绑定 — 恢复到 defaultWidth(默认值,与持久化值无关) */
  onResizeReset: () => void;
  /**
   * 程序化设置宽度。给消费者业务用(Sidebar 的 PDF 自动收窄等)。
   * 内部会 clamp 到 [min,max],并走 setState → 非拖拽变化时持久化到 localStorage。
   * 引用稳定(useCallback),可放进 useEffect 依赖。
   */
  setWidth: (width: number) => void;
  /**
   * 增量调整宽度 —— 给键盘 handler 用,基于当前 state 累加 delta,避免
   * stale closure(浏览器 key-repeat 在 React 重渲前会连发多份 keydown,
   * 用 setWidth(width + step) 会用同一个旧 width 反复加 → 看上去"按了没动")。
   * 内部 clamp 到 [min,max];引用稳定。
   */
  bumpWidth: (delta: number) => void;
}

export function useResizablePanel(opts: ResizablePanelOptions): ResizablePanelApi {
  const {
    storageKey,
    defaultWidth,
    min,
    max,
    side,
    unit = 'px',
    getMaxForWindow,
    onUserDrag,
  } = opts;

  const loadSavedWidth = (): number => {
    try {
      const raw = localStorage.getItem(storageKey);
      const n = raw == null ? NaN : parseFloat(raw);
      if (Number.isFinite(n) && n >= min && n <= max) return n;
    } catch {
      // 隐私模式 / Storage 被禁,静默忽略
    }
    return defaultWidth;
  };

  const [width, _setWidth] = useState<number>(loadSavedWidth);
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);
  // r199:本次拖拽是否已在全局登记簿里登记(begin/end 必须成对)。
  //   用 ref 而不是计数器的返回值 —— onResizeStart 可能被重复触发而不
  //   走 onUp(例如拖到一半组件被卸载),登记簿的计数不能只减不增。
  const dragRegisteredRef = useRef(false);
  // r199:指针捕获句柄 —— 拖拽结束(Esc / blur / 卸载)时释放。
  const pointerCaptureRef = useRef<{ el: HTMLElement; id: number } | null>(null);
  const widthRef = useRef(width);
  // audit-r86:拖拽中 widthRef 的唯一权威是 applyToDom(直写 DOM 的中间值),
  // 本行不得用尚未提交的 state 覆盖它 —— 否则拖拽中途任何父级重渲把 widthRef
  // 覆回拖拽起点旧值,用户不再移动直接 mouseup 时 onUp commit 的是旧值,
  // 面板从拖到的位置"回跳"(DOM/state/localStorage 三者分叉)。
  // 非拖拽期照常同步:程序化 setWidth/bumpWidth/ceiling clamp 只走 _setWidth,
  // 依赖本行把新 state 同步进 widthRef(dragStart 与后续比较都读它)。
  if (!draggingRef.current) widthRef.current = width;
  // 拖拽起点 — 用 delta 计算而非 e.clientX 直接当宽度。
  // 原实现把 e.clientX 当绝对宽度,在 left 面板(手柄在右沿)会让手柄
  // 比鼠标超前整个侧栏宽度,看上去"鼠标拉不动" / "拖不到位"。
  const dragStartXRef = useRef(0);
  const dragStartWRef = useRef(0);
  // 首次真实 mousemove 才视为"用户拖了";单击手柄 = 没拖。
  const dragMovedRef = useRef(false);
  // onUserDrag 在每次渲染都可能是新的引用 — 用 ref 包一层,
  // 避免 useEffect 因为它变化而重订 mousemove/mouseup。
  const onUserDragRef = useRef(onUserDrag);
  onUserDragRef.current = onUserDrag;
  // min/max 的 ref 版本 —— 拖拽 mousemove handler 在 useEffect 空依赖里,
  // 不重新订阅也能读到最新 min/max(若消费者动态调整)。
  const minRef = useRef(min);
  const maxRef = useRef(max);
  minRef.current = min;
  maxRef.current = max;
  // unit 的 ref 版本 —— applyToDom 在 useEffect 空依赖里也要读到最新值。
  const unitRef = useRef(unit);
  unitRef.current = unit;
  // audit round 8 (2026-09-14):body.style.cursor / userSelect 在 onResizeStart
  //   前先记下原值,mouseup + 卸载 cleanup 还原(而不是粗暴写 '')。原实现
  //   '' 把 body 原本的 cursor(如 'wait' / 'pointer' / 其他 inline style)
  //   全部 clobber,用户拖完面板光标卡在错误的样式上,要手动刷新页面才能恢复。
  //   ref 而非 state:snapshot 仅在 onResizeStart 写,mouseup/cleanup 仅读,
  //   不触发重渲。
  const bodyCursorRef = useRef<string>('');
  const bodyUserSelectRef = useRef<string>('');
  // side / storageKey 同样进 ref —— 这两个值在拖拽生命周期内通常不变,
  // 但消费者每次 render 传新对象字面量时(尤其是 storageKey 是变量拼接),
  // 走 ref 让全局 mousemove/mouseup 监听只在挂载时挂一次,免去每帧
  // tear-down + re-attach 引入的 listener 抖动(详见下方 effect 注释)。
  const sideRef = useRef(side);
  sideRef.current = side;
  const storageKeyRef = useRef(storageKey);
  storageKeyRef.current = storageKey;
  // audit 2026-09-14:getMaxForWindow 的 ref 版本 —— 调用方常传 inline
  //   `() => Math.floor(window.innerWidth * 0.6)`,每次 render 都是新引用,
  //   旧实现直接放 useEffect deps 让 resize listener 反复 tear-down + re-attach
  //   (典型:父级任一字段变化 → 整组件重渲 → 引用换 → 监听重订)。进 ref 后
  //   listener 在 mount 时挂一次,handler 内读最新闭包,跟 sideRef / storageKeyRef
  //   同模式。
  const getMaxForWindowRef = useRef(getMaxForWindow);
  getMaxForWindowRef.current = getMaxForWindow;

  // 拖拽期间直写 DOM 的目标元素。消费者把 panelRef 绑到承载 width 的 div。
  // callback ref 形式:卸载时 React 会传 null,这里接住并清空引用,
  // 避免 JS GC 不到已卸载元素(理论上 React 会负责,但显式 null 化无副作用)。
  const panelElRef = useRef<HTMLElement | null>(null);
  const panelRef = useCallback<RefCallback<HTMLElement>>((el) => {
    panelElRef.current = el;
  }, []);

  // audit-r142:resize clamp 跳过本次 localStorage 写盘 —— clampOnResize 把
  //   显示宽度从用户偏好(600)夹到 ceiling(420),_setWidth(420) 触发 [width]
  //   effect 落盘 "420",覆盖了用户原始偏好。下一轮 resize 时读 pref 已变 420,
  //   大窗也回不去。本 ref 让 clampOnResize 在 _setWidth 前记下夹紧值,[width]
  //   effect 看到「本次宽度就是那个夹紧值」→ 跳过落盘 → 偏好保留。
  //
  // audit-r231:标记从「布尔(下一次)」改成「按值(这一个)」——
  //   原实现是一次性布尔:clampOnResize 设 true,[width] effect 消费后清 false。
  //   但当夹紧目标与当前宽度**相同**(最常见:用户没拖过,偏好就落在区间内)
  //   ⇒ setState 同值 ⇒ React 不重渲 ⇒ [width] effect 不跑 ⇒ 标记留在原地
  //   没人消费 ⇒ 下一次真正的用户调整(拖拽松手)落盘时被它吞掉:
  //   面板宽度变了、界面变了、偏好没变 ⇒ 重启后回退(真机实测:面板显示
  //   720px 而 localStorage 仍是 440px)。
  //   改成记「具体是哪个值」后:标记只对它指的那个值生效,别的值照常落盘。
  const skipPersistValueRef = useRef<number | null>(null);

  // 把 width 直接写到 panel 元素的 style.width —— 不触发 React 重渲。
  // 同步更新 widthRef 让 mouseup 时 _setWidth 拿到的是最终拖到的值。
  //
  // audit-r142:px 模式下 Math.round 取整 —— hi-DPI / 触控板 e.clientX
  //   带小数(0.4 常见),raw = startW + delta 是 float,不取整则
  //     (1) el.style.width = "320.4px" → DOM 子像素,边框模糊一帧;
  //     (2) 后续 _setWidth(widthRef.current) 把 state 写成 300.4;
  //     (3) [width] effect 把 300.4 落盘到 localStorage;
  //     (4) 下次启动 parseFloat 拿到的还是 300.4,进入小数世界。
  //   pct 模式不取整(本来就是 0-1 的小数,UI 显示百分号)。
  const applyToDom = useCallback((next: number) => {
    const u = unitRef.current;
    const value = u === 'pct' ? next : Math.round(next);
    widthRef.current = value;
    const el = panelElRef.current;
    if (!el) return;
    if (u === 'pct') {
      el.style.width = `${value * 100}%`;
    } else {
      el.style.width = `${value}px`;
    }
  }, []);

  // 程序化设置宽度(供消费者业务用,如 PDF 自动收窄)
  // 内部 clamp 到 [min,max],引用稳定
  // audit-r231:显式设宽 = 用户/调用方的意图 ⇒ 这一刻的宽度就是新偏好 ⇒
  //   清掉「夹紧值不落盘」的标记(它只对夹紧产物有意义)。
  const setWidth = useCallback(
    (w: number) => {
      skipPersistValueRef.current = null;
      _setWidth(Math.max(min, Math.min(max, w)));
    },
    [min, max],
  );
  // 增量调整 —— 键盘 handler 用。setWidth(w + step) 会因 stale closure
  // 在 key-repeat 时连发同值;bumpWidth 走 functional updater,基于 React
  // 当前 state 累加 delta,任意密集按键都正确推进。
  const bumpWidth = useCallback(
    (delta: number) => {
      skipPersistValueRef.current = null;
      _setWidth((prev) => Math.max(min, Math.min(max, prev + delta)));
    },
    [min, max],
  );

  // 全局 mousemove/mouseup 监听只在挂载时挂一次(deps 里只有稳定的
  // applyToDom / 回调;side / storageKey 通过 sideRef / storageKeyRef 读)。
  // 内部用 ref 解决闭包陈旧,与两边现有实现一致
  useEffect(() => {
    // r199:退出全局拖拽登记的幂等封装(登记簿用计数器,重复 end 不会压成负数)。
    const endDragRegistration = () => {
      if (!dragRegisteredRef.current) return;
      dragRegisteredRef.current = false;
      endResizeDrag();
    };
    // r199:释放指针捕获 —— 拖拽以任何方式结束时都要放,否则下一次
    //   pointerdown 可能因旧捕获而收不到事件。
    const releasePointerCapture = () => {
      const cap = pointerCaptureRef.current;
      if (!cap) return;
      pointerCaptureRef.current = null;
      try {
        if (typeof cap.el.releasePointerCapture === 'function') {
          cap.el.releasePointerCapture(cap.id);
        }
      } catch {
        // 元素可能已从文档移除 —— 忽略。
      }
    };
    const onMove = (e: PointerEvent) => {
      if (!draggingRef.current) return;
      // unit='pct' 时宽度是相对当前容器(主区)宽度的比例,
      // 不能直接用 e.clientX - startX,得除以容器宽度得到百分比 delta。
      let next: number;
      const side = sideRef.current;
      if (unitRef.current === 'pct') {
        // 容器是 <main>,其宽度 = window.innerWidth(主区占满视口)。
        // 取 Math.max(1, ...) 避免 0 除。
        const containerW = Math.max(1, window.innerWidth);
        const deltaPct = (e.clientX - dragStartXRef.current) / containerW;
        // 左面板:向右拖 = 加宽;右面板:向右拖 = 收窄。
        const raw =
          side === 'left' ? dragStartWRef.current + deltaPct : dragStartWRef.current - deltaPct;
        next = Math.max(minRef.current, Math.min(maxRef.current, raw));
      } else {
        // unit='px'(默认):delta 直接加在宽度上。
        const delta = e.clientX - dragStartXRef.current;
        const raw = side === 'left' ? dragStartWRef.current + delta : dragStartWRef.current - delta;
        next = Math.max(minRef.current, Math.min(maxRef.current, raw));
      }
      // perf:直写 panel DOM,不在 mousemove 路径上调 _setWidth
      // (会触发 60~120 次/秒 React 子树重渲,重型 Reader 拖到很卡)
      applyToDom(next);
      if (!dragMovedRef.current) {
        dragMovedRef.current = true;
        onUserDragRef.current?.();
      }
    };
    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      dragMovedRef.current = false;
      // r199:退出全局拖拽登记 —— 消费者(如 PDF 阅读器)据此解除尺寸冻结,
      //   并在**这一次**重新跟上最终尺寸(不再每帧重排)。
      endDragRegistration();
      releasePointerCapture();
      setDragging(false);
      // audit round 8 (2026-09-14):还原 snapshot 原始值 —— 之前写 '' 会
      //   clobber 拖拽开始前 body 已经存在的 cursor/userSelect。
      document.body.style.cursor = bodyCursorRef.current;
      document.body.style.userSelect = bodyUserSelectRef.current;
      // 把拖到的最终值提交到 React state —— 只触发 1 次重渲,保持
      // state 与 DOM 一致(否则后续非拖拽 re-render 会用旧 state 把 DOM 拉回)。
      // 落盘由下方 [width] effect 统一处理 —— 之前这里也有 localStorage.setItem,
      // 每次拖拽结束会写两次盘(本处 + effect 触发),audit 2026-09-10 合并为单点。
      // audit-r231:用户的手动调整**一定**要落盘 ⇒ 清掉「夹紧值不落盘」的标记
      //   (哪怕这次恰好拖到了夹紧值上 —— 那也是用户此刻的偏好)。
      skipPersistValueRef.current = null;
      _setWidth(widthRef.current);
    };
    // audit 2026-09-16 r18:F6 — Escape 取消拖拽(回滚到拖拽起点)。
    //   鼠标用户拖错了没法回滚只能 mouseup 提交;键盘 / 触屏用户尤其需要
    //   一个显式「撤销」通道。WAI-ARIA 1.2 separator pattern 推荐 Escape
    //   为标准取消手势。
    const onKeyCancel = (e: KeyboardEvent) => {
      if (!draggingRef.current) return;
      if (e.key !== 'Escape') return;
      e.preventDefault();
      // 把 DOM 与 state 一起回滚到拖拽起点(dragStartWRef),
      // 与 cancel 语义一致:用户没 commit。
      applyToDom(dragStartWRef.current);
      _setWidth(dragStartWRef.current);
      // 直接复用 onUp 走收尾逻辑(setDragging(false) + 还原 body 样式 +
      // 提交)。
      onUp();
    };
    // audit-r142:blur 释放拖拽 —— 用户按住把手的同时 alt-tab / 切到其它
    //   应用 / 点 OS 桌面,浏览器外 mouseup 不冒泡到 window → onUp 永不触发。
    //   后果:
    //     (a) document.body.style.cursor='col-resize' / userSelect='none' 永久
    //         残留,文本无法选中;
    //     (b) draggingRef 卡在 true,widthRef 卡在拖到的中间值,后续 onResizeStart
    //         用 widthRef.current 当 dragStartW → 第二次拖拽 startW 被污染
    //         (从 300 拖到 400 后 blur,再拖 = startW=400 + delta,而不是 300 + delta)。
    //   修:挂 window.blur,失焦时若 draggingRef=true 走释放路径:
    //     - draggingRef=false / setDragging(false) / dragMovedRef=false
    //     - 还原 body cursor / userSelect 到 snapshot
    //     - DOM 回滚到 dragStartW(用户没 commit,等同于 drag 被打断)
    //     - **不**调用 _setWidth(widthRef.current) —— outer React section 的
    //       style.width 还是初始 state(拖拽过程不逐帧 commit),无须额外写入;
    //       不写 width state 也连带避免 [width] effect 把拖拽中间值落盘。
    const onBlur = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      dragMovedRef.current = false;
      endDragRegistration();
      releasePointerCapture();
      setDragging(false);
      document.body.style.cursor = bodyCursorRef.current;
      document.body.style.userSelect = bodyUserSelectRef.current;
      applyToDom(dragStartWRef.current);
    };
    // r234:监听 **pointer 系**,不再是 mouse 系 ——
    //   onResizeStart 在 pointerdown 上调了 preventDefault()(防原生拖拽/选区),
    //   Chromium(PointerEvents-v3)对整个手势**停发全部兼容 mouse 事件**
    //   ⇒ window 只会收到 pointermove / pointerup,mousemove / mouseup 一个
    //   都不来(真机 Electron 30 / Chromium 124 + CDP 实证;jsdom 旧测试发
    //   「pointerdown + mouseup」混合序列 ⇒ 假绿,真机松手后 onUp 永不跑:
    //   dragging 卡 true、body col-resize 残留、宽度不提交不落盘)。
    //   pointer 事件不受 preventDefault 影响,且指针捕获下仍冒泡到 window。
    //   pointercancel(OS 手势劫持 / 设备中断)= 非用户主动松手 ⇒ 走 onBlur
    //   同款回滚路径,不提交中间值。
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onBlur);
    window.addEventListener('keydown', onKeyCancel);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onBlur);
      window.removeEventListener('keydown', onKeyCancel);
      window.removeEventListener('blur', onBlur);
      // r199:拖拽中组件被卸载(切 Tab / 关列)→ 也要退出全局登记,
      //   否则 PDF 阅读器会永远以为「有人在拖」,尺寸被永久冻结。
      endDragRegistration();
      releasePointerCapture();
      // 卸载时恢复 body 样式(防止拖拽中组件被卸载导致样式残留)。
      // audit round 8 (2026-09-14):同样用 snapshot 还原,而非 '' clobber。
      document.body.style.cursor = bodyCursorRef.current;
      document.body.style.userSelect = bodyUserSelectRef.current;
    };
  }, [applyToDom]);

  // 非拖拽变化时(如双击复位 / 消费者改 width)落盘。
  // 拖拽期间 draggingRef=true,本 effect 被屏蔽 → 避免 ~60Hz 写盘风暴
  // (storageKeyRef 拿到当前 key,无须列入 deps)
  useEffect(() => {
    if (draggingRef.current) return;
    // audit-r142:clampOnResize 设置的 skip 守门 —— resize 夹紧时不落盘,保留
    //   用户原始偏好(见下方 resize useEffect 注释)。
    // audit-r231:按**值**守门,不是「下一次」——
    //   夹紧值 === 本次宽度 ⇒ 这一次是夹紧产物 ⇒ 不落盘(偏好保留);
    //   不相等 ⇒ 这个标记已经过期(它属于别的宽度)⇒ 清掉并正常落盘。
    //   布尔标记会跨过一次「无宽度变化」的夹紧残留下来,把下一次真正的
    //   用户调整吞掉 ⇒ 用户的调整存不下来(见 skipPersistValueRef 头注)。
    if (skipPersistValueRef.current !== null) {
      if (skipPersistValueRef.current === width) {
        skipPersistValueRef.current = null;
        return;
      }
      skipPersistValueRef.current = null;
    }
    try {
      localStorage.setItem(storageKeyRef.current, String(width));
    } catch (err: unknown) {
      // audit 2026-09-14:之前裸 swallow 让 quota 满 / 隐私模式让面板宽度偏好不持久化,
      //   用户重启后被重置回 defaultWidth,完全无感知。降级 warn —— 默认行为不变(下次启动
      //   走 default),但 dev console 有信号可排查。
      log.warn('localStorage.setItem failed during panel resize persistence', {
        key: storageKeyRef.current,
        err: errMsg(err),
      });
    }
  }, [width]);

  // r199:DOM 宽度的**唯一权威**写入口 —— layout effect,每次 commit 后跑。
  //
  //   为什么要从 [width] effect 里搬出来:拖拽期间 React state 故意不动
  //   (perf 路径:宽度由 DOM 直写),于是「React props.style.width = state.width」
  //   与「DOM 直写的实时宽度」在**每一次重渲**里都会打架 ——
  //   React 会用旧 state 把 style.width 覆回去,面板当场跳回拖拽起点。
  //   layout effect 跑在 React 写完 DOM **之后**,能反过来把宽度钉回权威值:
  //     拖拽中 → 钉 widthRef(实时拖到的值)
  //     非拖拽 → 钉 state width
  //   顺带修掉 audit-r135 那个「outer 拿 state.width / inner 拿 panelRef 直写」
  //   的两层错位:只要 panelRef 绑在**真正承载视觉宽度**的元素上,这里
  //   写的 width 就是那个元素的宽度,两层不会再分叉。
  useLayoutEffect(() => {
    const el = panelElRef.current;
    if (!el) return;
    const u = unitRef.current;
    const v = draggingRef.current ? widthRef.current : width;
    el.style.width = u === 'pct' ? `${v * 100}%` : `${v}px`;
  });

  const onResizeStart = useCallback((e: ReactPointerEvent) => {
    e.preventDefault();
    // r199:只认主键 —— 右键 / 中键按下不该启动一次宽度拖拽(右键还要弹菜单)。
    //   button 缺失(合成事件 / 老环境)时按主键处理,不因此把拖拽整个禁掉。
    if (typeof e.button === 'number' && e.button !== 0) return;
    draggingRef.current = true;
    dragStartXRef.current = e.clientX;
    dragStartWRef.current = widthRef.current;
    // r199:登记全局拖拽状态 —— 消费者(PDF 阅读器)据此冻结自身尺寸,
    //   避免拖拽期间每帧重排 PDF(实测每帧 +16ms,60fps → 30fps)。
    if (!dragRegisteredRef.current) {
      dragRegisteredRef.current = true;
      beginResizeDrag();
    }
    // r199:指针捕获 —— 拖到窗口边缘、或把指针拖出窗口再松开时,事件仍然
    //   回到手柄元素(pointer 事件冒泡到 window,本 hook 的监听挂在 window)。
    //   没有它:指针一出窗口,window 的 pointermove/pointerup 全部收不到 ⇒
    //   拖拽卡死(body 的 col-resize 光标 + userSelect:none 永久残留,
    //   面板停在半途,必须刷新页面才能恢复)。
    //   r234 更正:旧注释说「兼容 mouse 事件也随之重定向并冒泡到 window」
    //   是错的 —— 本函数下一行的 preventDefault() 会让 Chromium 对整个
    //   手势停发兼容 mouse 事件,只有 pointer 系可靠(详见下方监听处注释)。
    //   环境不支持 setPointerCapture(如 jsdom)时静默跳过 —— 仍有
    //   window.blur 兜底(alt-tab / 切到别的应用)。
    const target = e.currentTarget as HTMLElement | null;
    if (target && typeof target.setPointerCapture === 'function') {
      try {
        target.setPointerCapture(e.pointerId);
        pointerCaptureRef.current = { el: target, id: e.pointerId };
      } catch {
        // 某些环境(元素已脱离文档 / 指针已失效)会抛 —— 忽略,拖拽照常。
      }
    }
    setDragging(true);
    // audit round 8 (2026-09-14):snapshot 当前 body.style.cursor / userSelect
    //   原值。onResizeStart 可能被同一组件的多次拖拽反复调用(用户来回拖),
    //   每次都覆盖之前自己设置的 'col-resize' / 'none',但不影响最终还原
    //   —— 第一次 snapshot 的就是 body 真正的原值,后续鼠标起/落都还原它。
    //   注意:这里用 .style.cursor 而非 computed style —— 前者只读 inline style,
    //   若之前 body 的 cursor 是 stylesheet 设置的,这里 snapshot 是 '',不会
    //   影响 stylesheet 的 fallback。这是 desired:inline 优先级最高,设了
    //   'col-resize' 后再清掉就是还原 stylesheet 的样式。
    bodyCursorRef.current = document.body.style.cursor;
    bodyUserSelectRef.current = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const onResizeReset = useCallback(() => setWidth(defaultWidth), [setWidth, defaultWidth]);

  // 窗口缩放 → 重新夹紧。原 bug:用户拖宽到 800,再把窗口缩到 900,
  // 本面板不会变化,主区被压成负数;现在监听 resize,按"当前宽度上限"重夹。
  // unit='pct' 时宽度是相对值,不需要 resize 重夹(比例保持即可)。
  useEffect(() => {
    if (unit === 'pct') return;
    const clampOnResize = () => {
      // 走 ref 读最新 getMaxForWindow,deps 不再含它,resize listener 在 mount
      // 时挂一次就稳了(详见 getMaxForWindowRef 注释)。
      const ceiling = getMaxForWindowRef.current?.() ?? Math.floor(window.innerWidth * 0.6);
      const effectiveMax = Math.min(max, ceiling);
      // audit-r142:localStorage 中**已落盘**的值是用户偏好,不是 widthRef。
      //   原实现用 widthRef.current 决定下限 → 缩窗夹紧的状态被落盘,
      //   拉回大窗后 localStorage 已被污染,用户原偏好永久丢失。
      //   修:把 localStorage 偏好当权威,夹紧目标 = clamp(pref, [min, effectiveMax])。
      //   若无偏好(从未拖过 / privacy mode),回退到夹紧 w 的旧路径。
      const pref = (() => {
        try {
          const raw = localStorage.getItem(storageKeyRef.current);
          if (raw == null) return null;
          const n = parseFloat(raw);
          return Number.isFinite(n) ? n : null;
        } catch {
          return null;
        }
      })();
      _setWidth(() => {
        if (pref != null) {
          // 有用户偏好:把偏好夹紧到当前 ceiling 内当显示值,但**不**把夹紧值
          //   写回 localStorage —— 偏好落在 [min, effectiveMax] 时直接还原,
          //   否则夹紧到 effectiveMax,下次 resize(pref 落在新区间)自动还原。
          //   这是"夹紧 + 不污染偏好"的契约。
          // 守 skipPersistValueRef 让下方 [width] effect 不把**这个值**落盘。
          //   注意:目标与当前宽度相同(setState 同值 ⇒ 不重渲 ⇒ effect 不跑)
          //   时,标记会留在原地 —— 改成按值守门后它只对这一个值生效,
          //   不会吞掉下一次真正的用户调整(见该 ref 头注)。
          const target = Math.max(min, Math.min(max, effectiveMax, pref));
          skipPersistValueRef.current = target;
          return target;
        }
        // 无偏好:沿用旧 fallback —— 夹紧当前显示宽度(可能等于 defaultWidth,
        //   也可能在极端窗口下被夹到 min)。此处 _setWidth 触发 [width] effect
        //   写盘是 r132 first-mount 路径的延续(默认宽度落盘机制)。
        return Math.max(min, Math.min(max, ceiling, widthRef.current));
      });
    };
    window.addEventListener('resize', clampOnResize);
    return () => window.removeEventListener('resize', clampOnResize);
  }, [min, max, unit]);

  return { width, unit, dragging, panelRef, onResizeStart, onResizeReset, setWidth, bumpWidth };
}
