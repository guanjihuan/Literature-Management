// tests/unit/renderer/components/ui/overlay-effects.test.tsx
//
// 守 Overlay 的**六项副作用契约**(src/renderer/src/components/ui/Overlay.tsx
// 头注指向本文件,audit-r115 登记「六项承诺逐条 11 例 + 9 变异验红」,
// 本轮补齐 —— 原先标 🔒(守卫缺失))。
//
// Overlay 是 Modal / ConfirmDialog / Drawer 的**唯一**副作用容器 ——
// 「打开就挡住整个视口」这件事的六个副作用全在这里,别处不重复实现。
// 任何一条退化,后果都是**用户可见**的:
//
//   1. Portal 到 body      —— 否则 transform/opacity 上下文污染,
//                              面板的 fixed 定位相对错误的祖先算;
//   2. body 滚动锁        —— 背景能滚 ⇒ 弹窗期间页面在动,用户失去方位;
//   3. ESC 关闭(仅栈顶)  —— 多层弹层时一次 ESC 只应关最上面那层;
//   4. 进入移焦 / 关闭还焦—— 键盘用户 Tab 进弹窗后焦点仍在背景,
//                              关闭后焦点丢失(落 body)⇒ 下一步操作失向;
//   5. Tab 焦点陷阱       —— Tab 跑出弹窗 = 焦点跑到被遮住的内容上;
//   6. 遮罩点击关闭       —— 且**只**在点到遮罩本身时关(点到面板内不关)。
//
// 变异思路:去掉 portal / 去掉滚动锁 / 去掉 isTop 判定 / 去掉焦点归还 /
// 去掉 trapFocus 分支 / 去掉 e.target===e.currentTarget 判定 —— 逐条会红。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { useRef } from 'react';
import {
  Overlay,
  pushOverlayLayer,
  removeOverlayLayer,
  isOverlayLayerTop,
} from '../../../../../src/renderer/src/components/ui/Overlay';

/** Overlay 内部用 window.setTimeout(0) 做「等面板渲染完再 focus」。 */
async function flushFocus() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}

afterEach(() => {
  cleanup();
  document.body.style.overflow = '';
  document.body.style.paddingRight = '';
});

describe('Overlay 六项副作用契约(audit-r115 补齐)', () => {
  it('1. Portal 到 body(面板不在 React 容器里)', () => {
    const { container } = render(
      <Overlay open onClose={() => {}}>
        <div data-testid="panel">panel</div>
      </Overlay>,
    );
    expect(container.querySelector('[data-testid="panel"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="panel"]')).not.toBeNull();
  });

  it('2. 打开时锁 body 滚动 + 补偿滚动条宽度;关闭后原样还原', () => {
    const { rerender } = render(
      <Overlay open onClose={() => {}}>
        <div>p</div>
      </Overlay>,
    );
    expect(document.body.style.overflow).toBe('hidden');
    rerender(
      <Overlay open={false} onClose={() => {}}>
        <div>p</div>
      </Overlay>,
    );
    expect(document.body.style.overflow).toBe('');
    expect(document.body.style.paddingRight).toBe('');
  });

  it('3. ESC 关闭;closeOnEscape=false 时不响应', () => {
    const onClose = vi.fn();
    render(
      <Overlay open onClose={onClose}>
        <div>p</div>
      </Overlay>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);

    const onClose2 = vi.fn();
    render(
      <Overlay open onClose={onClose2} closeOnEscape={false}>
        <div>q</div>
      </Overlay>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose2).not.toHaveBeenCalled();
  });

  it('3b. 多层弹层:ESC 只关栈顶那层(不是一次全关)', () => {
    const closeOuter = vi.fn();
    const closeInner = vi.fn();
    render(
      <Overlay open onClose={closeOuter}>
        <div>
          <Overlay open onClose={closeInner}>
            <div>inner</div>
          </Overlay>
        </div>
      </Overlay>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(closeInner).toHaveBeenCalledTimes(1);
    expect(closeOuter).not.toHaveBeenCalled();
  });

  it('4. 打开后焦点移入面板;关闭后焦点归还给打开前的元素', async () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { rerender } = render(
      <Overlay open onClose={() => {}}>
        <div data-testid="panel">p</div>
      </Overlay>,
    );
    await flushFocus();
    const panel = document.querySelector('[data-testid="panel"]')!;
    // 面板容器(Overlay 自己的 panel div)拿到焦点
    expect(document.activeElement).not.toBe(trigger);
    expect(panel.parentElement?.contains(document.activeElement)).toBe(true);

    rerender(
      <Overlay open={false} onClose={() => {}}>
        <div data-testid="panel">p</div>
      </Overlay>,
    );
    await flushFocus();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('4b. initialFocusRef 优先于 autoFocusSelector,两者都优先于面板兜底', async () => {
    function Case({ mode }: { mode: 'ref' | 'selector' | 'none' }) {
      const ref = useRef<HTMLButtonElement>(null);
      return (
        <Overlay
          open
          onClose={() => {}}
          initialFocusRef={mode === 'ref' ? ref : undefined}
          autoFocusSelector={mode === 'selector' ? '[data-auto]' : undefined}
        >
          <button ref={ref} data-testid="by-ref">
            ref
          </button>
          <button data-auto data-testid="by-selector">
            selector
          </button>
        </Overlay>
      );
    }
    const { unmount } = render(<Case mode="ref" />);
    await flushFocus();
    expect(document.activeElement).toBe(screen.getByTestId('by-ref'));
    unmount();

    const { unmount: unmount2 } = render(<Case mode="selector" />);
    await flushFocus();
    expect(document.activeElement).toBe(screen.getByTestId('by-selector'));
    unmount2();
  });

  it('5. Tab 焦点陷阱:焦点在面板末尾时 Tab 回到面板首个可聚焦元素', async () => {
    render(
      <Overlay open onClose={() => {}}>
        <button data-testid="first">1</button>
        <button data-testid="last">2</button>
      </Overlay>,
    );
    await flushFocus();
    const last = screen.getByTestId('last');
    last.focus();
    expect(document.activeElement).toBe(last);

    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
    expect(ev.defaultPrevented, '焦点在末尾时 Tab 必须被拦下').toBe(true);
    expect(document.activeElement).toBe(screen.getByTestId('first'));
  });

  it('5b. Shift+Tab 在面板首个元素时绕到末尾', async () => {
    render(
      <Overlay open onClose={() => {}}>
        <button data-testid="first">1</button>
        <button data-testid="last">2</button>
      </Overlay>,
    );
    await flushFocus();
    screen.getByTestId('first').focus();
    const ev = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(screen.getByTestId('last'));
  });

  it('5c. trapFocus=false ⇒ 不拦 Tab', async () => {
    render(
      <Overlay open onClose={() => {}} trapFocus={false}>
        <button data-testid="first">1</button>
      </Overlay>,
    );
    await flushFocus();
    const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('6. 点遮罩关闭;点面板内部不关', () => {
    const onClose = vi.fn();
    render(
      <Overlay open onClose={onClose}>
        <div data-testid="panel">p</div>
      </Overlay>,
    );
    const scrim = document.querySelector('[data-testid="panel"]')!.parentElement!.parentElement!;
    fireEvent.click(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    fireEvent.click(screen.getByTestId('panel'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('6b. closeOnBackdrop=false ⇒ 点遮罩不关', () => {
    const onClose = vi.fn();
    render(
      <Overlay open onClose={onClose} closeOnBackdrop={false}>
        <div data-testid="panel">p</div>
      </Overlay>,
    );
    const scrim = document.querySelector('[data-testid="panel"]')!.parentElement!.parentElement!;
    fireEvent.click(scrim);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('open=false ⇒ 什么都不渲染(且不锁滚动)', () => {
    render(
      <Overlay open={false} onClose={() => {}}>
        <div data-testid="panel">p</div>
      </Overlay>,
    );
    expect(document.querySelector('[data-testid="panel"]')).toBeNull();
    expect(document.body.style.overflow).toBe('');
  });
});

describe('Overlay 栈 API(r80:ContextMenu 接入同一栈)', () => {
  beforeEach(() => {
    // 每个用例从空栈开始 —— 栈是模块级状态,跨用例会串。
    // push/remove 走公开 API 清理。
    for (let i = 0; i < 10; i++) removeOverlayLayer(Symbol('probe'));
  });

  it('push → 自己是栈顶;再 push 一个则前者不是栈顶', () => {
    const a = Symbol('a');
    const b = Symbol('b');
    pushOverlayLayer(a);
    expect(isOverlayLayerTop(a)).toBe(true);
    pushOverlayLayer(b);
    expect(isOverlayLayerTop(b)).toBe(true);
    expect(isOverlayLayerTop(a)).toBe(false);
    removeOverlayLayer(b);
    expect(isOverlayLayerTop(a)).toBe(true);
    removeOverlayLayer(a);
  });

  it('remove 一个不在栈里的 id 不抛错(幂等)', () => {
    const a = Symbol('a');
    expect(() => removeOverlayLayer(a)).not.toThrow();
  });
});
