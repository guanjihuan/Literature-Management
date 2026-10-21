// tests/unit/renderer/hooks/use-resizable-panel-persist.test.ts
//
// 守 useResizablePanel 的「调整落盘」契约 —— **松开鼠标后调整必须完成**
// (面板显示的宽度 == 用户偏好 == localStorage 里存的值)。
//
// 背景(2026-10-20 真机实测,Electron + CDP 拖左栏分隔条):
//   拖到 720px 后面板显示 720px,但 localStorage 里
//   'workbench.listPanel.width.v2' 仍是 **440** —— 用户的调整没存下来。
//   重启应用 → 面板又回到 440 ⇒ 「拖了半天,松手后调整没生效」。
//
// 根因(r142 引入的「夹紧值不落盘」守卫自带的一处泄漏):
//   窗口 resize → clampOnResize 算出夹紧后的目标宽度 → 若目标宽度与当前
//   宽度**相同**(最常见:用户没拖过,偏好就落在区间内),setState 同值 ⇒
//   React 不重渲 ⇒ [width] effect 不跑 ⇒ 那句「这一次不要落盘」的标记
//   (skipPersistRef)**留在原地没人消费**。
//   标记是一次性的「跳过下一次落盘」,不是「跳过这个具体值」⇒
//   下一次真正的用户调整(拖拽松手)落盘时被它吞掉 —— 宽度变了、界面变了、
//   偏好没变 ⇒ 重启后回退。
//
// 本文件锁三条:
//   1. 拖拽松手后 localStorage 必须等于新宽度(泄漏场景 ⇒ 红)。
//   2. 窗口夹紧产生的显示宽度**不污染**用户偏好(r142 的原契约 ⇒ 必须绿)。
//   3. 泄漏场景之后连续两次拖拽,两次都要落盘(标记不得再吞)。
//
// 本文件是 .ts(指针指定)⇒ 用 React.createElement 而不是 JSX。
import { describe, expect, it, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { createElement } from 'react';
import { useResizablePanel } from '../../../../src/renderer/src/hooks/useResizablePanel';

// jsdom 没有 PointerEvent 构造器(见 memory jsdom-test-gaps):
//   垫一个继承 MouseEvent 的替身,让 clientX / button / pointerId 不丢。
class FakePointerEvent extends MouseEvent {
  pointerId: number;
  pointerType: string;
  isPrimary: boolean;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? 'mouse';
    this.isPrimary = init.isPrimary ?? true;
  }
}

beforeAll(() => {
  (window as unknown as { PointerEvent: unknown }).PointerEvent = FakePointerEvent;
});

const KEY = 'test.panel.width';

// 视口宽度可写(jsdom 默认 1024,夹紧上限 = 60% = 614)。
function setViewportWidth(w: number): void {
  Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true });
}

interface HarnessProps {
  min: number;
  max: number;
  defaultWidth: number;
}

/** 最小宿主:section 承载视觉宽度(panelRef 必须绑在这层),按钮当手柄。 */
function Harness({ min, max, defaultWidth }: HarnessProps): ReturnType<typeof createElement> {
  const api = useResizablePanel({
    storageKey: KEY,
    defaultWidth,
    min,
    max,
    side: 'left',
  });
  return createElement(
    'section',
    { ref: api.panelRef, style: { width: `${api.width}px` }, 'data-testid': 'panel' },
    createElement(
      'button',
      { type: 'button', onPointerDown: api.onResizeStart, 'data-testid': 'handle' },
      'drag',
    ),
  );
}

function setup(opts?: Partial<HarnessProps>): {
  panel: HTMLElement;
  handle: HTMLElement;
  unmount: () => void;
} {
  const utils = render(
    createElement(Harness, { min: 200, max: 720, defaultWidth: 240, ...opts }),
  );
  return {
    panel: utils.getByTestId('panel') as HTMLElement,
    handle: utils.getByTestId('handle') as HTMLElement,
    unmount: utils.unmount,
  };
}

/** 模拟一次真实拖拽:按下 → 移动 delta 像素 → 松开。 */
function drag(handle: HTMLElement, delta: number): void {
  // r234:必须全发 pointer 系 —— 真机 Chromium 在 pointerdown preventDefault
  //   后整个手势不发兼容 mouse 事件(见 panel-resize-drag.test.tsx 头注);
  //   混合序列(pointerdown + mouseup)在 jsdom 里成立、在真机不成立 ⇒ 假绿。
  fireEvent.pointerDown(handle, { clientX: 0, button: 0, pointerId: 1 });
  fireEvent.pointerMove(window, { clientX: delta, pointerId: 1 });
  fireEvent.pointerUp(window, { clientX: delta, pointerId: 1 });
}

beforeEach(() => {
  localStorage.clear();
  setViewportWidth(1024);
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

describe('useResizablePanel 落盘契约(松开鼠标 ⇒ 调整完成)', () => {
  it('窗口夹紧(目标宽度 == 当前宽度)之后再拖拽 ⇒ 新宽度必须落盘', () => {
    // 偏好 400 落在 [min, max] 内 ⇒ 夹紧后的目标宽度 == 当前宽度 ⇒
    //   setState 同值 ⇒ [width] effect 不跑 ⇒ 跳过标记泄漏(本用例的靶心)。
    localStorage.setItem(KEY, '400');
    const { panel, handle } = setup();

    expect(panel.style.width).toBe('400px');

    // 窗口缩放 ⇒ 触发 clampOnResize(夹紧值 = 400,同值 ⇒ 不重渲)。
    setViewportWidth(1024);
    fireEvent(window, new Event('resize'));
    expect(panel.style.width).toBe('400px');

    // 用户拖到 500 并松手。
    drag(handle, 100);

    expect(panel.style.width).toBe('500px');
    // ⇒ 偏好必须落盘(修前:被泄漏的标记吞掉 ⇒ 这里红)。
    expect(localStorage.getItem(KEY)).toBe('500');
  });

  it('窗口夹紧(显示宽度确实变了)不得污染用户偏好', () => {
    // r142 原契约:夹紧后的显示宽度只影响显示,偏好保持原值。
    localStorage.setItem(KEY, '600');
    const { panel } = setup();
    expect(panel.style.width).toBe('600px');

    // 视口缩到 700 ⇒ 上限 60% = 420 ⇒ 显示宽度被夹到 420。
    setViewportWidth(700);
    fireEvent(window, new Event('resize'));

    expect(panel.style.width).toBe('420px');
    // 偏好仍是 600(没有被夹紧值污染)。
    expect(localStorage.getItem(KEY)).toBe('600');
  });

  it('泄漏场景之后连续两次拖拽,两次都要落盘', () => {
    localStorage.setItem(KEY, '400');
    const { panel, handle } = setup();

    fireEvent(window, new Event('resize')); // 制造泄漏

    drag(handle, 100);
    expect(panel.style.width).toBe('500px');
    expect(localStorage.getItem(KEY)).toBe('500');

    drag(handle, -50);
    expect(panel.style.width).toBe('450px');
    expect(localStorage.getItem(KEY)).toBe('450');
  });
});
