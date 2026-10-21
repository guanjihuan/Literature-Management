// tests/unit/renderer/components/panel-resize-drag.test.tsx
//
// 守「拖拽分隔条改面板宽度」这一交互在**拖拽过程中**的行为契约。
//
// 背景(r199 修复的三个用户可见缺陷):
//   1. 左侧列表面板:宽度写在 outer <section> 上,而 hook 的 panelRef 绑在
//      inner div → 拖拽期间 hook 直写的是 inner div 的 width,outer section
//      的 width 仍是 React state ⇒ **面板在拖拽过程中根本不变**,内容溢出
//      压到分隔条上,分隔条也不跟鼠标走 ⇒ 「鼠标点击拉动」操作失效。
//   2. 文献 PDF 区域:iframe 直接 100% 跟随容器宽度 ⇒ 拖拽每一帧都在重排
//      Chromium PDF 渲染(实测每帧 +16ms,60fps 掉到 ~30fps)⇒ 缩小时很卡。
//   3. 拖拽期间父级若重渲,React 会用旧 state 覆写 style.width ⇒ 面板跳回。
//
// 本测锁(行为级):
//   A. 拖拽过程中,承载视觉宽度的元素宽度必须**跟着鼠标实时变**;
//   B. 拖拽过程中,PDF iframe 的尺寸必须**冻结**(不让 PDF 每帧重排),
//      mouseup 之后才允许跟上新尺寸;
//   C. 拖拽结束后,宽度落定且与拖拽结果一致。
import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';

// jsdom 没有 PointerEvent(见 memory jsdom-test-gaps:按需 per-case 垫片,
//   不污染全局 setup)。手柄改用 pointer 事件后,必须补上这个类 —— 否则
//   fireEvent.pointerDown 退化成普通 Event,clientX / button / pointerId
//   全部丢失,测出来的行为不是浏览器里的行为。
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

// i18n:只关心交互,不关心文案
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

// workspace store:ListPanel 只用 active / setActive
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

// 懒加载的列表组件:本测不关心列表内容,换掉避免 react-virtuoso / IPC 噪声
vi.mock('../../../../src/renderer/src/components/literature/LiteratureList', () => ({
  LiteratureList: () => <div data-testid="lit-list" />,
}));
vi.mock('../../../../src/renderer/src/components/notes/NotesList', () => ({
  NotesList: () => <div data-testid="notes-list" />,
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

// 懒加载的阅读器 / 笔记视图:本测只关心分隔条与列宽,不关心内容
vi.mock('../../../../src/renderer/src/components/reader/Reader', () => ({
  Reader: () => <div data-testid="reader" />,
}));
vi.mock('../../../../src/renderer/src/components/notes/NotesView', () => ({
  NotesView: () => <div data-testid="notes-view" />,
}));

import { WorkbenchListPanel } from '../../../../src/renderer/src/components/layout/WorkbenchListPanel';
import { WorkbenchContentPanel } from '../../../../src/renderer/src/components/layout/WorkbenchContentPanel';
import {
  LIST_PANEL_MIN,
  LIST_PANEL_DEFAULT as DEFAULT_W,
} from '../../../../src/renderer/src/components/layout/list-panel-width';
import { isResizeDragActive } from '../../../../src/renderer/src/lib/resize-drag-registry';

function drag(separator: HTMLElement, fromX: number, toX: number) {
  // r234:整条手势必须发 **pointer 系**事件 —— 真实 Chromium 在
  //   pointerdown 被 preventDefault(useResizablePanel.onResizeStart 就是这么
  //   做的)后,整个手势**不再发任何兼容 mouse 事件**(PointerEvents-v3;
  //   真机 Electron 30 / Chromium 124 + CDP 实证:页面只见 pointerdown /
  //   pointermove / pointerup,mousemove / mouseup 一个都没有)。
  //   旧版这里发 pointerdown + mousemove + mouseup 的混合序列 —— 真实浏览器
  //   从不这么发,jsdom 里却畅通 ⇒ hook 监听 mouse 系时测试假绿、真机卡死。
  fireEvent.pointerDown(separator, { clientX: fromX, clientY: 100, button: 0, pointerId: 1 });
  act(() => {
    fireEvent.pointerMove(window, { clientX: toX, clientY: 100, pointerId: 1 });
  });
  return () => {
    act(() => {
      fireEvent.pointerUp(window, { clientX: toX, clientY: 100, pointerId: 1 });
    });
  };
}

describe('面板分隔条拖拽', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
  });

  it('拖拽过程中承载宽度的 section 宽度实时跟随鼠标(不只在 mouseup 后才变)', () => {
    const { container } = render(<WorkbenchListPanel />);
    const section = container.querySelector('section') as HTMLElement;
    const separator = container.querySelector('[role="separator"]') as HTMLElement;

    expect(section).toBeTruthy();
    expect(separator).toBeTruthy();
    // 初始宽度来自 state
    expect(section.style.width).toBe(`${DEFAULT_W}px`);

    const end = drag(separator, 1000, 1100); // 向右拖 100px ⇒ 加宽 100px

    // 拖拽中:宽度必须已经变了(实时跟手),而不是停在初始值
    expect(section.style.width).toBe(`${DEFAULT_W + 100}px`);

    end();
    // mouseup 后仍然一致
    expect(section.style.width).toBe(`${DEFAULT_W + 100}px`);
  });

  it('拖拽收窄时被最小宽度夹住(不会缩到 0)', () => {
    const { container } = render(<WorkbenchListPanel />);
    const section = container.querySelector('section') as HTMLElement;
    const separator = container.querySelector('[role="separator"]') as HTMLElement;

    const end = drag(separator, 1000, 200); // 向左拖 800px ⇒ 远超最小宽度
    expect(section.style.width).toBe(`${LIST_PANEL_MIN}px`);
    end();
    expect(section.style.width).toBe(`${LIST_PANEL_MIN}px`);
  });

  it('拖拽期间全局登记「正在拖拽」—— PDF 阅读器据此冻结尺寸', () => {
    const { container } = render(<WorkbenchListPanel />);
    const separator = container.querySelector('[role="separator"]') as HTMLElement;
    expect(isResizeDragActive()).toBe(false);

    const end = drag(separator, 1000, 1100);
    expect(isResizeDragActive()).toBe(true);
    end();
    expect(isResizeDragActive()).toBe(false);
  });
});

// r241:默认宽度 280→300,storageKey v3→v4 —— 面板层面验证:
//   (1) v3 里「用户真拖过」的宽度被迁移并生效(不被新默认覆盖);
//   (2) v3 里等于旧默认 280 的值 = 自动落盘 ⇒ 走新默认 300。
// (r238 那轮是 v2→v3 / 240→280;迁移源随每次升版往前挪一版。)
describe('左侧面板宽度默认值升级(r241)', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('v3 里手动拖过的宽度(400)被迁移过来并生效', () => {
    localStorage.setItem('workbench.listPanel.width.v3', '400');
    const { container } = render(<WorkbenchListPanel />);
    const section = container.querySelector('section') as HTMLElement;
    expect(section.style.width).toBe('400px');
  });

  it('v3 里是旧默认 280 ⇒ 不迁移,回落到新默认 300', () => {
    localStorage.setItem('workbench.listPanel.width.v3', '280');
    const { container } = render(<WorkbenchListPanel />);
    const section = container.querySelector('section') as HTMLElement;
    expect(section.style.width).toBe('300px');
  });
});

describe('主区文献列(双列)分隔条拖拽', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('文献列(PDF 区域)宽度在拖拽过程中实时跟随鼠标', () => {
    const { container } = render(<WorkbenchContentPanel />);
    const separator = container.querySelector('[role="separator"]') as HTMLElement;
    expect(separator).toBeTruthy();
    // 分隔条左边那个 div 就是文献列(承载 width 的元素)
    const readerCol = separator.previousElementSibling as HTMLElement;
    expect(readerCol.style.width).toBe('640px');

    const end = drag(separator, 1000, 900); // 向左拖 100px ⇒ 文献列收窄 100px
    expect(readerCol.style.width).toBe('540px');

    end();
    expect(readerCol.style.width).toBe('540px');
  });
});
