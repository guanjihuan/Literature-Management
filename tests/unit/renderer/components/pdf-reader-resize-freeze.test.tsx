// tests/unit/renderer/components/pdf-reader-resize-freeze.test.tsx
//
// 守 r199「拖面板宽度时 PDF 区域很卡」的修复契约 —— PDF iframe 的**尺寸**
// 在面板拖拽期间必须冻结,拖拽结束才跟上。
//
// 为什么这是行为契约(而不是实现细节):
//   Chromium 的 PDF 渲染器在 iframe 尺寸变化时必须重排 + 重新光栅化可见页面。
//   实测(Chromium,本地 http 多页 PDF,每帧改一次宽度):
//     不动                          → 16.3ms/帧
//     改普通 HTML iframe 尺寸       → 16.4ms/帧
//     改 PDF iframe 尺寸             → 32.8ms/帧  ← 60fps 掉到 ~30fps
//     改容器尺寸但冻结 iframe 尺寸   → 16.4ms/帧
//   即「iframe 尺寸每帧变」就是那 ~16ms/帧的来源。本测锁住「尺寸冻结」
//   这条契约 —— 将来谁把 iframe 改回 w-full 跟随容器,本测立刻转红。
//
// 附带锁:拖拽结束后尺寸必须**跟上**最终值(冻结不能变成「永远不更新」)。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { PDFReader } from '../../../../src/renderer/src/components/reader/PDFReader';
import {
  beginResizeDrag,
  endResizeDrag,
  resetResizeDragRegistry,
} from '../../../../src/renderer/src/lib/resize-drag-registry';

// ── jsdom 垫片 ────────────────────────────────────────────────────────────
// jsdom 没有 ResizeObserver,也没有真实布局(getBoundingClientRect 全 0)。
// 这里自造一个可手动触发的 ResizeObserver + 一个可变矩形。
type Observed = { target: Element; contentRect: DOMRectReadOnly };
const observers: Array<{ cb: (entries: Observed[]) => void; targets: Set<Element> }> = [];

class FakeResizeObserver {
  private rec: { cb: (entries: Observed[]) => void; targets: Set<Element> };
  constructor(cb: (entries: Observed[]) => void) {
    this.rec = { cb, targets: new Set() };
    observers.push(this.rec);
  }
  observe(el: Element) {
    this.rec.targets.add(el);
  }
  unobserve(el: Element) {
    this.rec.targets.delete(el);
  }
  disconnect() {
    this.rec.targets.clear();
  }
}

function emitResize(): void {
  for (const rec of observers) {
    rec.cb(
      Array.from(rec.targets).map((target) => ({
        target,
        contentRect: { width: 0, height: 0 } as DOMRectReadOnly,
      })),
    );
  }
}

let rect = { width: 640, height: 800 };

function iframeOf(container: HTMLElement): HTMLIFrameElement {
  return container.querySelector('iframe') as HTMLIFrameElement;
}

describe('PDF 阅读器:面板拖拽期间冻结 iframe 尺寸(r199)', () => {
  beforeEach(() => {
    observers.length = 0;
    rect = { width: 640, height: 800 };
    resetResizeDragRegistry();
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          width: rect.width,
          height: rect.height,
          top: 0,
          left: 0,
          right: rect.width,
          bottom: rect.height,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    );
  });

  afterEach(() => {
    cleanup();
    resetResizeDragRegistry();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('首帧就把 iframe 尺寸对齐容器(不留在 100% 跟随态)', () => {
    const { container } = render(<PDFReader absPath="C:/x/a.pdf" filename="a.pdf" />);
    const iframe = iframeOf(container);
    expect(iframe.style.width).toBe('640px');
    expect(iframe.style.height).toBe('800px');
  });

  it('拖拽期间容器变窄 → iframe 尺寸冻结不动(不让 PDF 每帧重排)', () => {
    const { container } = render(<PDFReader absPath="C:/x/a.pdf" filename="a.pdf" />);
    const iframe = iframeOf(container);
    expect(iframe.style.width).toBe('640px');

    act(() => {
      beginResizeDrag();
    });
    // 拖拽中:容器变窄(面板收窄),iframe 尺寸必须**保持** 640
    rect = { width: 400, height: 800 };
    act(() => {
      emitResize();
    });
    expect(iframe.style.width).toBe('640px');

    // 再收窄一次,依然冻结
    rect = { width: 320, height: 800 };
    act(() => {
      emitResize();
    });
    expect(iframe.style.width).toBe('640px');
  });

  it('拖拽结束 → iframe 一次性跟上最终尺寸(冻结不是「永远不更新」)', () => {
    const { container } = render(<PDFReader absPath="C:/x/a.pdf" filename="a.pdf" />);
    const iframe = iframeOf(container);

    act(() => {
      beginResizeDrag();
    });
    rect = { width: 400, height: 800 };
    act(() => {
      emitResize();
    });
    expect(iframe.style.width).toBe('640px');

    act(() => {
      endResizeDrag();
    });
    expect(iframe.style.width).toBe('400px');
    expect(iframe.style.height).toBe('800px');
  });

  it('非拖拽场景(窗口缩放):尺寸落定后更新', () => {
    vi.useFakeTimers();
    try {
      const { container } = render(<PDFReader absPath="C:/x/a.pdf" filename="a.pdf" />);
      const iframe = iframeOf(container);
      expect(iframe.style.width).toBe('640px');

      rect = { width: 500, height: 800 };
      act(() => {
        emitResize();
        vi.advanceTimersByTime(200);
      });
      expect(iframe.style.width).toBe('500px');
    } finally {
      vi.useRealTimers();
    }
  });

  // audit 2026-10-21 (r252):「落定定时器」与「拖拽开始」的竞态。
  //   旧实现只在 ResizeObserver 回调那一刻查拖拽状态 —— 排好的 150ms 定时器
  //   到点时**不再查** ⇒ 若这 150ms 里用户开始了拖拽,定时器会在拖拽**中途**
  //   改 iframe 尺寸 ⇒ Chromium 重排 + 重新光栅化 PDF(实测每帧 +16ms)
  //   ⇒ 拖拽第一帧掉帧。
  it('拖拽开始时已挂着待落定定时器 ⇒ 定时器到点也不得在拖拽中改尺寸', () => {
    vi.useFakeTimers();
    try {
      const { container } = render(<PDFReader absPath="C:/x/a.pdf" filename="a.pdf" />);
      const iframe = iframeOf(container);
      expect(iframe.style.width).toBe('640px');

      // ① 非拖拽场景的一次 resize ⇒ 排一个 150ms 的落定定时器
      rect = { width: 500, height: 800 };
      act(() => {
        emitResize();
      });
      expect(iframe.style.width, '定时器还没到点,尺寸不变').toBe('640px');

      // ② 定时器到点之前,用户开始拖分隔条
      act(() => {
        beginResizeDrag();
      });

      // ③ 定时器到点 ⇒ **不得**在拖拽中途改 iframe 尺寸
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(iframe.style.width, '拖拽中不得改尺寸(PDF 每帧重排 = 掉帧)').toBe('640px');

      // ④ 拖拽结束 → 照旧一次性跟上最终尺寸(跳过定时器不会丢更新)
      act(() => {
        endResizeDrag();
      });
      expect(iframe.style.width).toBe('500px');
    } finally {
      vi.useRealTimers();
    }
  });
});
