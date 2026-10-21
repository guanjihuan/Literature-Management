// tests/unit/renderer/resize-handle-keyboard.test.ts
//
// 守 VerticalResizeHandle 的**键盘操作契约**与**方向约定**
// (src/renderer/src/components/layout/VerticalResizeHandle.tsx 头注指向本文件)。
//
// 契约(每条都对应一个用户可见的后果):
//
//   1. 方向约定 —— 手柄永远在面板的「内侧」:
//        side='left'  (手柄在面板右沿):ArrowLeft = 面板收窄(-step)
//        side='right' (手柄在面板左沿):ArrowLeft = 面板加宽(+step)
//      退化(两个 side 的 ± 号写反)⇒ 键盘用户按左键面板反而变宽,
//      与鼠标拖拽方向正好相反(鼠标往左拖就是收窄)⇒ 用户完全失去方向感。
//   2. 步长:普通键 10px,Shift 加速 50px。
//      退化 ⇒ 长按加速失效 / 加速步长变成 10px,细调与粗调分不出来。
//   3. Home = 跳到 min,End = 跳到 max。
//      退化 ⇒ 键盘用户没法一键到边界,只能长按几十次。
//   4. 方向键必须 preventDefault —— 否则浏览器跟着横向滚动整页。
//   5. a11y 数值必须对得上:role=separator / aria-orientation=vertical /
//      aria-valuenow / valuemin / valuemax / aria-valuetext / title。
//      px 模式读出 "320 px",pct 模式读出 "32%"(读屏用户不靠像素猜宽度)。
//   6. 双击手柄 = 复位到 defaultWidth;按下 = 开始拖拽(必须是 pointer 事件,
//      只有 pointer 事件能 setPointerCapture,拖出窗口松手才不卡死)。
//
// 本文件是 .ts(指针指定)⇒ 用 React.createElement 而不是 JSX。
//
// 变异思路(下列任一改动会红):
//   - 把 arrowLeftAddsWidth 的判定反过来 / 把两个 case 的 ± 写反
//   - SHIFT_STEP 改回 NORMAL_STEP
//   - 去掉方向键分支里的 e.preventDefault()
//   - Home / End 传错 min / max
//   - fmt 里的 pct 分支去掉(百分比面板读出 "0.32 px")
//   - onDoubleClick / onPointerDown 摘掉
import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { createElement } from 'react';
import { VerticalResizeHandle } from '../../../src/renderer/src/components/layout/VerticalResizeHandle';
import { useResizablePanel } from '../../../src/renderer/src/hooks/useResizablePanel';
import type { ResizablePanelApi } from '../../../src/renderer/src/hooks/useResizablePanel';

// jsdom 没有 PointerEvent 构造器(见 memory jsdom-test-gaps)。
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

const NORMAL_STEP = 10;
const SHIFT_STEP = 50;

function makeApi(overrides: Partial<ResizablePanelApi> = {}): ResizablePanelApi {
  return {
    width: 300,
    unit: 'px',
    dragging: false,
    panelRef: () => {},
    onResizeStart: vi.fn(),
    onResizeReset: vi.fn(),
    setWidth: vi.fn(),
    bumpWidth: vi.fn(),
    ...overrides,
  };
}

function renderHandle(
  api: ResizablePanelApi,
  side: 'left' | 'right' = 'left',
  min = 100,
  max = 500,
): { handle: HTMLElement; container: HTMLElement; unmount: () => void } {
  const utils = render(
    createElement(VerticalResizeHandle, { api, side, min, max, ariaLabel: 'resize handle' }),
  );
  const handle = utils.container.querySelector('[role="separator"]') as HTMLElement;
  return { handle, container: utils.container, unmount: utils.unmount };
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
});

describe('VerticalResizeHandle 方向约定(键盘 ± step)', () => {
  it("side='left'(手柄在右沿):ArrowLeft 收窄 / ArrowRight 加宽", () => {
    const api = makeApi();
    const { handle } = renderHandle(api, 'left');

    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(api.bumpWidth).toHaveBeenCalledWith(-NORMAL_STEP);

    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(api.bumpWidth).toHaveBeenCalledWith(NORMAL_STEP);
  });

  it("side='right'(手柄在左沿):ArrowLeft 加宽 / ArrowRight 收窄(与 left 相反)", () => {
    const api = makeApi();
    const { handle } = renderHandle(api, 'right');

    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(api.bumpWidth).toHaveBeenCalledWith(NORMAL_STEP);

    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(api.bumpWidth).toHaveBeenCalledWith(-NORMAL_STEP);
  });

  it('Shift = 加速步长 50(普通 10)', () => {
    const api = makeApi();
    const { handle } = renderHandle(api, 'left');

    fireEvent.keyDown(handle, { key: 'ArrowLeft', shiftKey: true });
    expect(api.bumpWidth).toHaveBeenCalledWith(-SHIFT_STEP);

    fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true });
    expect(api.bumpWidth).toHaveBeenCalledWith(SHIFT_STEP);
  });

  it('方向键 preventDefault(否则整页横向滚动)', () => {
    const api = makeApi();
    const { handle } = renderHandle(api, 'left');
    // fireEvent 返回 dispatchEvent 的结果:被 preventDefault 过就是 false
    expect(fireEvent.keyDown(handle, { key: 'ArrowLeft' })).toBe(false);
    expect(fireEvent.keyDown(handle, { key: 'ArrowRight' })).toBe(false);
  });

  it('Home = min,End = max', () => {
    const api = makeApi();
    const { handle } = renderHandle(api, 'left', 100, 500);

    fireEvent.keyDown(handle, { key: 'Home' });
    expect(api.setWidth).toHaveBeenCalledWith(100);

    fireEvent.keyDown(handle, { key: 'End' });
    expect(api.setWidth).toHaveBeenCalledWith(500);
  });

  it('无关按键不触发任何宽度变更,也不拦默认行为', () => {
    const api = makeApi();
    const { handle } = renderHandle(api, 'left');

    expect(fireEvent.keyDown(handle, { key: 'a' })).toBe(true);
    expect(fireEvent.keyDown(handle, { key: 'ArrowUp' })).toBe(true);
    expect(fireEvent.keyDown(handle, { key: 'Tab' })).toBe(true);
    expect(api.bumpWidth).not.toHaveBeenCalled();
    expect(api.setWidth).not.toHaveBeenCalled();
  });
});

describe('VerticalResizeHandle a11y 数值', () => {
  it('separator 语义与 aria 数值都对得上当前宽度', () => {
    const api = makeApi({ width: 320 });
    const { handle } = renderHandle(api, 'left', 100, 500);

    expect(handle.getAttribute('role')).toBe('separator');
    expect(handle.getAttribute('aria-orientation')).toBe('vertical');
    expect(handle.getAttribute('aria-valuemin')).toBe('100');
    expect(handle.getAttribute('aria-valuemax')).toBe('500');
    expect(handle.getAttribute('aria-valuenow')).toBe('320');
    expect(handle.getAttribute('aria-valuetext')).toBe('320 px');
    expect(handle.getAttribute('title')).toBe('320 px');
    expect(handle.getAttribute('aria-label')).toBe('resize handle');
  });

  it('pct 模式读出百分比而不是像素', () => {
    const api = makeApi({ width: 0.32, unit: 'pct' });
    const { handle } = renderHandle(api, 'left', 0, 1);
    expect(handle.getAttribute('aria-valuetext')).toBe('32%');
    expect(handle.getAttribute('title')).toBe('32%');
  });
});

describe('VerticalResizeHandle 鼠标交互', () => {
  it('双击手柄 = 复位', () => {
    const api = makeApi();
    const { handle } = renderHandle(api, 'left');
    fireEvent.doubleClick(handle);
    expect(api.onResizeReset).toHaveBeenCalledTimes(1);
  });

  it('按下手柄用 pointer 事件(才能 setPointerCapture,拖出窗口不卡死)', () => {
    const api = makeApi();
    const { handle } = renderHandle(api, 'left');
    fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 100, clientY: 50 });
    expect(api.onResizeStart).toHaveBeenCalledTimes(1);
  });
});

describe('VerticalResizeHandle 接真 hook:键盘真的改变面板宽度', () => {
  function Harness({
    side,
    min = 100,
    max = 500,
    defaultWidth = 300,
  }: {
    side: 'left' | 'right';
    min?: number;
    max?: number;
    defaultWidth?: number;
  }) {
    const api = useResizablePanel({
      storageKey: 'test.resize.handle.width',
      defaultWidth,
      min,
      max,
      side,
      unit: 'px',
    });
    return createElement(
      'div',
      null,
      createElement('div', {
        ref: api.panelRef,
        'data-testid': 'panel',
        style: { width: `${api.width}px` },
      }),
      createElement(VerticalResizeHandle, { api, side, min, max, ariaLabel: 'resize handle' }),
    );
  }

  function panelWidth(): string {
    return (document.querySelector('[data-testid="panel"]') as HTMLElement).style.width;
  }

  it("side='left':ArrowLeft 让面板真的收窄 10px", () => {
    const { container } = render(createElement(Harness, { side: 'left' }));
    const handle = container.querySelector('[role="separator"]') as HTMLElement;
    expect(panelWidth()).toBe('300px');

    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(panelWidth()).toBe('290px');

    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(panelWidth()).toBe('300px');
  });

  it("side='right':ArrowLeft 让面板真的加宽 10px(与 left 相反)", () => {
    const { container } = render(createElement(Harness, { side: 'right' }));
    const handle = container.querySelector('[role="separator"]') as HTMLElement;

    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(panelWidth()).toBe('310px');
  });

  it('连续按键逐步推进,不会被夹死在 min / max 之外', () => {
    const { container } = render(createElement(Harness, { side: 'left' }));
    const handle = container.querySelector('[role="separator"]') as HTMLElement;

    for (let i = 0; i < 40; i += 1) fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(panelWidth()).toBe('100px'); // min

    for (let i = 0; i < 60; i += 1) fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(panelWidth()).toBe('500px'); // max
  });

  it('Home / End 直接落到边界', () => {
    const { container } = render(createElement(Harness, { side: 'left' }));
    const handle = container.querySelector('[role="separator"]') as HTMLElement;

    fireEvent.keyDown(handle, { key: 'End' });
    expect(panelWidth()).toBe('500px');

    fireEvent.keyDown(handle, { key: 'Home' });
    expect(panelWidth()).toBe('100px');
  });

  it('双击手柄 = 复位到 defaultWidth', () => {
    const { container } = render(createElement(Harness, { side: 'left', defaultWidth: 300 }));
    const handle = container.querySelector('[role="separator"]') as HTMLElement;

    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(panelWidth()).toBe('310px');

    fireEvent.doubleClick(handle);
    expect(panelWidth()).toBe('300px');
  });
});
