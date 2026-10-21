// tests/unit/renderer/layout/workbench-content-decoupled-columns.test.tsx
//
// 守 WorkbenchContentPanel 的**主区 / 左栏 Tab 解耦**契约
// (src/renderer/src/components/layout/WorkbenchContentPanel.tsx 头注指向本文件)。
//
// 契约(2026-10-18 改造后的形态):
//
//   1. 主区**不跟左栏 Tab 切换**,只跟两个模块各自的「打开态」
//      (literature.selectedId / notes.selectedId)走:
//        两边都没开 → 空态(身份才取 active)
//        开一个     → 该模块单列占满
//        两个都开   → 双列(文献在左 ┃ NotesView 在右)
//      退化(又用 active 门控 panel 分支)⇒ 用户开着文献去点笔记 Tab,
//      文献被顶掉、读者位置丢失 —— 这正是这次改造要消灭的现象。
//
//   2. **有打开态时,切 active 一律不许动主区**。
//      退化 ⇒ 切 Tab 把正在读的东西顶掉(用户明确报障的现象)。
//
//   3. 关列按钮只清**本模块**的打开态,不动 active、也不动另一列:
//        双列关一列 → 另一列自动占满
//        单列关列   → 主区落回空态(身份取当前 Tab)
//
// 变异思路(下列任一改动会红):
//   - 把 litFile !== null && selectedId 的分支改回看 active
//   - 在「有打开态」的分支里读 active(例如按 active 决定渲染哪列)
//   - closePanel 里额外改 active / 额外清另一模块的 selectedId
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, screen, act } from '@testing-library/react';

// i18n:只关心结构,不关心文案(键原样返回即可)
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

// --- 三个 store 的最小可订阅替身 -------------------------------------------
// 真 zustand store 有订阅语义(状态一变,订阅该 selector 的组件重渲)。
// 这里用 useSyncExternalStore 复刻这一点 —— 否则「切 active 后主区不动」
// 根本测不出来(不重渲 ⇒ DOM 当然一样,变成空过)。
const stores = vi.hoisted(() => {
  function makeStore<T extends object>(initial: T) {
    let state = initial;
    const listeners = new Set<() => void>();
    return {
      get: () => state,
      set: (patch: Partial<T>) => {
        state = { ...state, ...patch };
        for (const l of listeners) l();
      },
      subscribe: (l: () => void) => {
        listeners.add(l);
        return () => {
          listeners.delete(l);
        };
      },
    };
  }
  const workspace = makeStore<{ active: 'library' | 'notes' }>({ active: 'library' });
  const notes = makeStore<{ selectedId: string | null; select: (id: string | null) => void }>({
    selectedId: null,
    select: () => {},
  });
  notes.set({
    select: (id: string | null) => {
      notes.set({ selectedId: id });
    },
  });
  const literature = makeStore<{
    items: { id: string; absPath: string }[];
    selectedId: string | null;
    select: (id: string | null) => void;
  }>({ items: [], selectedId: null, select: () => {} });
  literature.set({
    select: (id: string | null) => {
      literature.set({ selectedId: id });
    },
  });
  return { workspace, notes, literature };
});

vi.mock('../../../../src/renderer/src/store/workspace', async () => {
  const { useSyncExternalStore } = await import('react');
  const store = stores.workspace;
  const useWorkspaceStore = <T,>(selector: (s: { active: 'library' | 'notes' }) => T): T =>
    useSyncExternalStore(store.subscribe, () => selector(store.get()));
  return { useWorkspaceStore };
});

vi.mock('../../../../src/renderer/src/store/notes', async () => {
  const { useSyncExternalStore } = await import('react');
  const store = stores.notes;
  const useNotesStore = <T,>(
    selector: (s: { selectedId: string | null; select: (id: string | null) => void }) => T,
  ): T => useSyncExternalStore(store.subscribe, () => selector(store.get()));
  useNotesStore.getState = () => store.get();
  return { useNotesStore };
});

vi.mock('../../../../src/renderer/src/store/literature', async () => {
  const { useSyncExternalStore } = await import('react');
  const store = stores.literature;
  const useLiteratureStore = <T,>(
    selector: (s: {
      items: { id: string; absPath: string }[];
      selectedId: string | null;
      select: (id: string | null) => void;
    }) => T,
  ): T => useSyncExternalStore(store.subscribe, () => selector(store.get()));
  useLiteratureStore.getState = () => store.get();
  return { useLiteratureStore };
});

// 懒加载的阅读器 / 笔记视图:本测只关心主区结构,换掉避免 IPC / CodeMirror 噪声
vi.mock('../../../../src/renderer/src/components/reader/Reader', () => ({
  Reader: () => <div data-testid="reader" />,
}));
vi.mock('../../../../src/renderer/src/components/notes/NotesView', () => ({
  NotesView: () => <div data-testid="notes-view" />,
}));

import { WorkbenchContentPanel } from '../../../../src/renderer/src/components/layout/WorkbenchContentPanel';

const LIT_ITEM = { id: 'l1', absPath: 'C:/papers/a.pdf' };

// Reader / NotesView 都是 React.lazy —— 首次渲染只出 Suspense 占位,
// 组件本体要等动态 import 的 promise 落地才出现。断言「不存在」之前
// 也必须 flush,否则「还没加载出来」会被误当成「不存在」(假绿)。
// 改 store 状态会触发订阅组件重渲 —— 必须包在 act 里,
// 否则 React 报「update not wrapped in act」并且重渲落在断言之后。
function setActive(active: 'library' | 'notes'): void {
  act(() => {
    stores.workspace.set({ active });
  });
}

async function flushLazy(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  stores.workspace.set({ active: 'library' });
  stores.notes.set({ selectedId: null });
  stores.literature.set({ items: [], selectedId: null });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('主区形态由「打开态」决定,不由左栏 Tab 决定', () => {
  it('文献开着、笔记没开 ⇒ 单列文献(没有笔记列)', async () => {
    stores.literature.set({ items: [LIT_ITEM], selectedId: 'l1' });
    render(<WorkbenchContentPanel />);
    await flushLazy();

    expect(screen.getByTestId('reader')).toBeTruthy();
    expect(screen.queryByTestId('notes-view')).toBeNull();
    expect(document.querySelector('[role="separator"]')).toBeNull();
  });

  it('笔记开着、文献没开 ⇒ 单列笔记(没有文献列)', async () => {
    stores.notes.set({ selectedId: 'n1' });
    render(<WorkbenchContentPanel />);
    await flushLazy();

    expect(screen.getByTestId('notes-view')).toBeTruthy();
    expect(screen.queryByTestId('reader')).toBeNull();
    expect(document.querySelector('[role="separator"]')).toBeNull();
  });

  it('两边都开着 ⇒ 双列 + 分隔条', async () => {
    stores.literature.set({ items: [LIT_ITEM], selectedId: 'l1' });
    stores.notes.set({ selectedId: 'n1' });
    render(<WorkbenchContentPanel />);
    await flushLazy();

    expect(screen.getByTestId('reader')).toBeTruthy();
    expect(screen.getByTestId('notes-view')).toBeTruthy();
    expect(document.querySelector('[role="separator"]')).toBeTruthy();
  });

  it('文献 selectedId 命中不到 items ⇒ 按「没打开」处理(冷挂载竞态)', async () => {
    stores.literature.set({ items: [], selectedId: 'l1' });
    render(<WorkbenchContentPanel />);
    await flushLazy();

    expect(screen.queryByTestId('reader')).toBeNull();
    expect(screen.queryByTestId('notes-view')).toBeNull();
  });
});

describe('有打开态时切 active:主区必须原样不动', () => {
  it('文献开着时切到笔记 Tab ⇒ 仍然是文献列(DOM 一字不变)', async () => {
    stores.literature.set({ items: [LIT_ITEM], selectedId: 'l1' });
    const { container } = render(<WorkbenchContentPanel />);
    await flushLazy();
    const before = container.innerHTML;

    setActive('notes');

    expect(container.innerHTML).toBe(before);
    expect(screen.getByTestId('reader')).toBeTruthy();
    expect(screen.queryByTestId('notes-view')).toBeNull();
  });

  it('笔记开着时切到文献 Tab ⇒ 仍然是笔记列(DOM 一字不变)', async () => {
    stores.notes.set({ selectedId: 'n1' });
    const { container } = render(<WorkbenchContentPanel />);
    await flushLazy();
    const before = container.innerHTML;

    setActive('library');

    expect(container.innerHTML).toBe(before);
    expect(screen.getByTestId('notes-view')).toBeTruthy();
    expect(screen.queryByTestId('reader')).toBeNull();
  });

  it('双列时切 active ⇒ 仍是双列(DOM 一字不变)', async () => {
    stores.literature.set({ items: [LIT_ITEM], selectedId: 'l1' });
    stores.notes.set({ selectedId: 'n1' });
    const { container } = render(<WorkbenchContentPanel />);
    await flushLazy();
    const before = container.innerHTML;

    setActive('notes');

    expect(container.innerHTML).toBe(before);
    expect(screen.getByTestId('reader')).toBeTruthy();
    expect(screen.getByTestId('notes-view')).toBeTruthy();
  });
});

describe('空态身份只在「都没打开」时跟随左栏 Tab', () => {
  it('都没打开 + active=notes ⇒ 笔记空态', async () => {
    setActive('notes');
    render(<WorkbenchContentPanel />);
    await flushLazy();
    expect(screen.getByText('notes.viewEmptyTitle')).toBeTruthy();
    expect(screen.queryByText('literature.viewEmptyTitle')).toBeNull();
  });

  it('都没打开 + active=library ⇒ 文献空态', async () => {
    setActive('library');
    render(<WorkbenchContentPanel />);
    await flushLazy();
    expect(screen.getByText('literature.viewEmptyTitle')).toBeTruthy();
    expect(screen.queryByText('notes.viewEmptyTitle')).toBeNull();
  });
});

describe('关列按钮:只关本列,不动 active,不动另一列', () => {
  it('双列关掉文献列 ⇒ 笔记列仍在,主区回到单列', async () => {
    stores.literature.set({ items: [LIT_ITEM], selectedId: 'l1' });
    stores.notes.set({ selectedId: 'n1' });
    render(<WorkbenchContentPanel />);
    await flushLazy();

    fireEvent.click(screen.getByLabelText('literature.closePanelAria'));

    expect(stores.literature.get().selectedId).toBeNull();
    expect(screen.queryByTestId('reader')).toBeNull();
    expect(screen.getByTestId('notes-view')).toBeTruthy();
    expect(document.querySelector('[role="separator"]')).toBeNull();
  });

  it('双列关掉笔记列 ⇒ 文献列仍在', async () => {
    stores.literature.set({ items: [LIT_ITEM], selectedId: 'l1' });
    stores.notes.set({ selectedId: 'n1' });
    render(<WorkbenchContentPanel />);
    await flushLazy();

    fireEvent.click(screen.getByLabelText('notes.closePanelAria'));

    expect(stores.notes.get().selectedId).toBeNull();
    expect(screen.getByTestId('reader')).toBeTruthy();
    expect(screen.queryByTestId('notes-view')).toBeNull();
  });

  it('关列不会顺手切走左栏 Tab(active 不变)', async () => {
    setActive('notes');
    stores.literature.set({ items: [LIT_ITEM], selectedId: 'l1' });
    stores.notes.set({ selectedId: 'n1' });
    render(<WorkbenchContentPanel />);
    await flushLazy();

    fireEvent.click(screen.getByLabelText('notes.closePanelAria'));

    expect(stores.workspace.get().active).toBe('notes');
  });

  it('单列关掉 ⇒ 主区落回空态(身份取当前 Tab)', async () => {
    setActive('notes');
    stores.notes.set({ selectedId: 'n1' });
    render(<WorkbenchContentPanel />);
    await flushLazy();
    expect(screen.getByTestId('notes-view')).toBeTruthy();

    fireEvent.click(screen.getByLabelText('notes.closePanelAria'));

    expect(screen.queryByTestId('notes-view')).toBeNull();
    expect(screen.getByText('notes.viewEmptyTitle')).toBeTruthy();
  });
});
