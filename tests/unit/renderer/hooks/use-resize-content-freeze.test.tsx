// tests/unit/renderer/hooks/use-resize-content-freeze.test.tsx
//
// 守 r230「拖动分隔条调宽度时卡顿」的修复契约 —— 拖拽期间被拖动面板的
// **内容宽度必须冻结**,拖拽结束才跟上。
//
// 为什么是行为契约(而不是实现细节):
//   拖拽路径本来就是「perf 路径」(useResizablePanel 拖拽期间直写 DOM,
//   绕过 React 重渲)⇒ 卡顿不在 JS,在**布局**:面板宽度每帧变 ⇒ 该侧
//   所有内容每帧重新折行 / 重排表格。
//   Electron 真机 + CDP 帧间隔采样(双列 + 笔记列开「渲染显示」,189KB 文档):
//     不冻结(修前)→ 拖文献列分隔条:每帧布局 42ms,帧间隔中位 **50ms**,
//                     60 帧里 39 帧超 50ms(肉眼可见的拖不动);
//                     拖左侧栏分隔条:每帧布局 45ms,中位 50.1ms。
//     冻结(修后)  → 每帧布局 ~1ms,帧间隔中位 **16.7ms**(满 60fps)。
//   拖左栏时主区宽度同样每帧变 ⇒ 冻结必须**全局**(订阅共享登记簿),
//   不能只跟某一个面板的拖拽绑定 —— 这条也是本测的结构契约之一。
//
// 本轮是**新增能力**(不是收编),故:
//   - 行为例:对 HEAD 全红(hook 文件不存在)⇒ 修后必须绿;
//   - 结构例:锁「组件必须挂 hook」「hook 必须走全局登记簿」,
//     独立于 hook 自身实现,任何人把 hook 调用删掉 / 退化成 per-panel 即红。
import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { renderHook, render, fireEvent, act, cleanup } from '@testing-library/react';
import { readFileSync } from 'fs';
import { join } from 'path';

// i18n:只关心交互,不关心文案
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

// notes store:WorkbenchContentPanel 只读 selectedId(笔记列是否打开)
vi.mock('../../../../src/renderer/src/store/notes', () => {
  const state = { selectedId: 'n1', select: vi.fn() };
  const useNotesStore = ((selector?: (s: unknown) => unknown) =>
    selector ? selector(state) : state) as unknown as {
    (selector?: (s: unknown) => unknown): unknown;
    getState: () => unknown;
  };
  useNotesStore.getState = () => state;
  return { useNotesStore };
});

// literature store:WorkbenchContentPanel 读 items + selectedId 派生 ReaderFile
vi.mock('../../../../src/renderer/src/store/literature', () => {
  const state = {
    items: [{ id: 'l1', absPath: 'C:/papers/a.pdf' }],
    selectedId: 'l1',
    select: vi.fn(),
  };
  const useLiteratureStore = ((selector?: (s: unknown) => unknown) =>
    selector ? selector(state) : state) as unknown as {
    (selector?: (s: unknown) => unknown): unknown;
    getState: () => unknown;
  };
  useLiteratureStore.getState = () => state;
  return { useLiteratureStore };
});

// workspace store:主区空态身份
vi.mock('../../../../src/renderer/src/store/workspace', () => {
  const state = { active: 'library', setActive: vi.fn() };
  const useWorkspaceStore = ((selector?: (s: unknown) => unknown) =>
    selector ? selector(state) : state) as unknown as {
    (selector?: (s: unknown) => unknown): unknown;
    getState: () => unknown;
  };
  useWorkspaceStore.getState = () => state;
  return { useWorkspaceStore };
});

// 懒加载的阅读器 / 笔记视图:本测只关心分隔条、列宽与冻结,不关心内容
vi.mock('../../../../src/renderer/src/components/reader/Reader', () => ({
  Reader: () => <div data-testid="reader" />,
}));
vi.mock('../../../../src/renderer/src/components/notes/NotesView', () => ({
  NotesView: () => <div data-testid="notes-view" />,
}));

import { WorkbenchContentPanel } from '../../../../src/renderer/src/components/layout/WorkbenchContentPanel';
import { useResizeContentFreeze } from '../../../../src/renderer/src/hooks/use-resize-content-freeze';
import {
  beginResizeDrag,
  endResizeDrag,
  isResizeDragActive,
  resetResizeDragRegistry,
} from '../../../../src/renderer/src/lib/resize-drag-registry';

// jsdom 不做真实布局:getBoundingClientRect 恒为 0 ⇒ 冻结逻辑会因
// 「宽度为 0 不钉」而全部跳过。这里用一个可变矩形替身。
let rectWidth = 640;

function makeEl(): HTMLDivElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

describe('r230 行为契约:拖拽期间内容宽度冻结', () => {
  beforeEach(() => {
    resetResizeDragRegistry();
    rectWidth = 640;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          width: rectWidth,
          height: 800,
          top: 0,
          left: 0,
          right: rectWidth,
          bottom: 800,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    );
  });

  afterEach(() => {
    cleanup();
    resetResizeDragRegistry();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('非拖拽期不碰内容根(不预置任何 inline 宽度)', () => {
    const el = makeEl();
    const ref = { current: el };
    renderHook(() => useResizeContentFreeze(ref));
    expect(el.style.width).toBe('');
    expect(el.style.overflowX).toBe('');
  });

  it('拖拽开始 → 内容根宽度被钉成拖拽开始那一刻的像素值', () => {
    const el = makeEl();
    const ref = { current: el };
    renderHook(() => useResizeContentFreeze(ref));

    act(() => {
      beginResizeDrag();
    });
    expect(el.style.width).toBe('640px');
  });

  it('拖拽中容器变窄 → 内容根宽度不动(不重排)', () => {
    const el = makeEl();
    const ref = { current: el };
    renderHook(() => useResizeContentFreeze(ref));

    act(() => {
      beginResizeDrag();
    });
    rectWidth = 400;
    expect(el.style.width).toBe('640px');
    rectWidth = 320;
    expect(el.style.width).toBe('640px');
  });

  it('拖拽中横向溢出被裁掉(不出横向滚动条吃掉纵向空间)', () => {
    const el = makeEl();
    const ref = { current: el };
    renderHook(() => useResizeContentFreeze(ref));

    act(() => {
      beginResizeDrag();
    });
    expect(el.style.overflowX).toBe('hidden');
  });

  it('拖拽结束 → 内容根宽度一次性跟上(冻结不是「永远不更新」)', () => {
    const el = makeEl();
    const ref = { current: el };
    renderHook(() => useResizeContentFreeze(ref));

    act(() => {
      beginResizeDrag();
    });
    rectWidth = 400;
    act(() => {
      endResizeDrag();
    });
    expect(el.style.width).toBe('');
    expect(el.style.overflowX).toBe('');
  });

  it('拖拽前就有的 inline 样式在拖拽结束后原样还原(不是清空)', () => {
    const el = makeEl();
    el.style.width = '50%';
    el.style.overflowX = 'auto';
    const ref = { current: el };
    renderHook(() => useResizeContentFreeze(ref));

    act(() => {
      beginResizeDrag();
    });
    expect(el.style.width).toBe('640px');
    act(() => {
      endResizeDrag();
    });
    expect(el.style.width).toBe('50%');
    expect(el.style.overflowX).toBe('auto');
  });

  it('宽度为 0(未布局/隐藏)时不钉 —— 钉 0 会让内容彻底消失', () => {
    const el = makeEl();
    rectWidth = 0;
    const ref = { current: el };
    renderHook(() => useResizeContentFreeze(ref));

    act(() => {
      beginResizeDrag();
    });
    expect(el.style.width).toBe('');
  });

  it('嵌套拖拽:计数未归零时保持冻结,归零才还原', () => {
    const el = makeEl();
    const ref = { current: el };
    renderHook(() => useResizeContentFreeze(ref));

    act(() => {
      beginResizeDrag();
      beginResizeDrag();
    });
    expect(el.style.width).toBe('640px');
    act(() => {
      endResizeDrag();
    });
    // 还有一个拖拽在途 ⇒ 仍冻结
    expect(el.style.width).toBe('640px');
    act(() => {
      endResizeDrag();
    });
    expect(el.style.width).toBe('');
  });

  it('拖拽中组件卸载 → 还原(不留冻结态 inline 样式)', () => {
    const el = makeEl();
    const ref = { current: el };
    const { unmount } = renderHook(() => useResizeContentFreeze(ref));

    act(() => {
      beginResizeDrag();
    });
    expect(el.style.width).toBe('640px');
    unmount();
    expect(el.style.width).toBe('');
    expect(el.style.overflowX).toBe('');
  });
});

// 端到端:真实组件 + 真实事件序列(pointerdown → mousemove → mouseup)。
//
// 这一组锁的是用户说的那句「鼠标点击放开之后应该完成调整」——
//   拖拽期间:两列内容宽度被钉死(不重排);
//   松手之后:① 面板宽度提交(DOM + localStorage)② 内容解冻、宽度清空
//             ⇒ 内容重新跟着面板走 = 调整真正完成,不是「永远冻结」。
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

describe('r230 端到端契约:拖 → 松手 → 完成调整', () => {
  beforeAll(() => {
    (window as unknown as { PointerEvent: unknown }).PointerEvent = FakePointerEvent;
  });
  beforeEach(() => {
    localStorage.clear();
    resetResizeDragRegistry();
    // jsdom 无布局:getBoundingClientRect 恒 0 ⇒ 冻结逻辑会因「宽度 0 不钉」
    // 全部跳过。给一个固定宽度,让冻结路径真正跑起来。
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          width: 640,
          height: 800,
          top: 0,
          left: 0,
          right: 640,
          bottom: 800,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    );
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
    resetResizeDragRegistry();
    vi.restoreAllMocks();
  });

  it('拖拽期间两列内容宽度被钉死;松手后面板宽度提交 + 内容解冻跟上最终宽度', () => {
    const { container } = render(<WorkbenchContentPanel />);
    const separator = container.querySelector('[role="separator"]') as HTMLElement;
    expect(separator).toBeTruthy();
    const readerCol = separator.previousElementSibling as HTMLElement;

    // ① 拖拽开始
    fireEvent.pointerDown(separator, { clientX: 1000, clientY: 100, button: 0, pointerId: 1 });
    expect(isResizeDragActive()).toBe(true);

    // ② 拖动 100px(向左 = 文献列收窄)
    // r234:pointer 系 —— 真机 Chromium 在 pointerdown preventDefault 后
    //   不发兼容 mouse 事件(见 panel-resize-drag.test.tsx 头注)。
    act(() => {
      fireEvent.pointerMove(window, { clientX: 900, clientY: 100, pointerId: 1 });
    });
    // 面板宽度实时跟手(这一条是 r199 已有的契约,此处作为对照)
    expect(readerCol.style.width).toBe('540px');
    // 内容宽度被钉死在拖拽开始时的 640px ⇒ 不重排
    const frozen = [...container.querySelectorAll('*')].filter(
      (el) => (el as HTMLElement).style.overflowX === 'hidden',
    );
    expect(frozen.length, '两列内容根各被冻结一次').toBe(2);
    for (const el of frozen) {
      expect((el as HTMLElement).style.width).toBe('640px');
    }

    // ③ 松手 —— 调整必须在此完成
    act(() => {
      fireEvent.pointerUp(window, { clientX: 900, clientY: 100, pointerId: 1 });
    });
    expect(isResizeDragActive()).toBe(false);
    // ③-a 面板宽度提交(DOM + localStorage)
    expect(readerCol.style.width).toBe('540px');
    expect(localStorage.getItem('workbench.readerColumn.width')).toBe('540');
    // ③-b 内容解冻:inline 宽度清空 ⇒ 内容重新跟着面板走
    for (const el of frozen) {
      expect((el as HTMLElement).style.width).toBe('');
      expect((el as HTMLElement).style.overflowX).toBe('');
    }
    const stillFrozen = [...container.querySelectorAll('*')].filter(
      (el) => (el as HTMLElement).style.overflowX === 'hidden',
    );
    expect(stillFrozen.length, '松手后不得残留冻结态').toBe(0);
  });
});

describe('r230 结构契约:冻结必须全局 + 组件必须挂上', () => {  const ROOT = process.cwd();

  it('hook 走全局登记簿(任意分隔条在拖都冻结),不是 per-panel', () => {
    const src = readFileSync(
      join(ROOT, 'src/renderer/src/hooks/use-resize-content-freeze.ts'),
      'utf-8',
    );
    expect(src, '冻结必须订阅全局登记簿').toContain('subscribeResizeDrag');
    expect(src, '冻结必须读全局拖拽态').toContain('isResizeDragActive');
  });

  it('主区两列的内容根都挂了 useResizeContentFreeze', () => {
    const src = readFileSync(
      join(ROOT, 'src/renderer/src/components/layout/WorkbenchContentPanel.tsx'),
      'utf-8',
    );
    const calls = src.match(/useResizeContentFreeze\(contentRef\);/g) ?? [];
    expect(calls.length, '笔记列 + 文献列各挂一次冻结').toBe(2);
    expect(src, '两列内容根都要有 ref').toContain('ref={contentRef}');
  });

  it('主区不得自己再写一遍冻结(单一真相源在 hook 里)', () => {
    const src = readFileSync(
      join(ROOT, 'src/renderer/src/components/layout/WorkbenchContentPanel.tsx'),
      'utf-8',
    );
    expect(src, '冻结逻辑不得在组件里内联实现').not.toContain('style.width =');
    expect(src, '冻结逻辑不得在组件里内联实现').not.toContain('style.overflowX =');
  });

  it('文献列面板自带 overflow-hidden —— 钉住的内容不得溢出到笔记列', () => {
    const src = readFileSync(
      join(ROOT, 'src/renderer/src/components/layout/WorkbenchContentPanel.tsx'),
      'utf-8',
    );
    const panelIdx = src.indexOf('ref={readerCol.panelRef}');
    expect(panelIdx, '文献列面板必须存在').toBeGreaterThan(-1);
    const panelSnippet = src.slice(panelIdx, panelIdx + 400);
    expect(panelSnippet, '文献列面板必须裁切溢出的内容').toContain('overflow-hidden');
  });
});
