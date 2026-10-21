// tests/unit/renderer/layout/library-reader-flex-chain.test.tsx
//
// 守「文献列 → Reader」的**flex 高度链**契约
// (src/renderer/src/components/layout/WorkbenchContentPanel.tsx r120 头注指向本文件)。
//
// 背景(audit-r120 的真实故障):文献列的承载容器一度是**块级**容器,
//   子 reader(PDF / Image / Markdown / Code / Plain)的根节点高度全靠
//   flex-1 撑 —— 块级父下 flex-1 直接失效,iframe 的 h-full 百分比解析
//   失败,回退 UA 默认 300×150 ⇒ PDF 塌成一条 150px 横条并报障。
//
// 契约(每一层都在用户可见的后果上):
//
//   1. 承载 Reader 的那层容器必须是 **flex + flex-col**:
//      - 少 flex   ⇒ 子 reader 的 flex-1 不生效(高度塌成内容高)
//      - 少 flex-col ⇒ flex-1 沿主轴(横轴)分配,高度反而撑不开
//   2. 该容器还要带 **flex-1 + min-h-0**:
//      - 少 flex-1 ⇒ 它不吃掉剩余高度,reader 被挤到容器顶部
//      - 少 min-h-0 ⇒ overflow 逃逸,PDF 内容把主区撑出滚动条
//   3. 从 reader 根往上的**每一层祖先都必须是 flex 容器** ——
//      中间任何一层退化成块级,整条链的高度计算就断在那儿。
//   4. 双列形态下,文献列容器自身也要是 flex 列(min-h-0 同样不能少)。
//
// 变异思路(下列任一改动会红):
//   - 把 LibraryPanel 里 Reader 外层的 className 去掉 flex / flex-col
//   - 去掉该层的 flex-1 或 min-h-0
//   - 双列分支里给文献列容器换成块级(去掉 flex flex-col)
//   - 把单列分支的包裹层换成块级
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, act } from '@testing-library/react';

// i18n:只关心布局链,不关心文案
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

// --- 三个 store 的最小可订阅替身 -------------------------------------------
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

// 阅读器替身:复刻真 PDFReader 的根节点形态 ——
//   根:  flex-1 flex flex-col   (高度靠 flex-1 撑)
//   内层: relative flex-1 min-h-0 overflow-hidden (iframe 的定位上下文)
vi.mock('../../../../src/renderer/src/components/reader/Reader', () => ({
  Reader: () => (
    <div data-testid="reader-root" className="flex-1 flex flex-col overflow-hidden">
      <div data-testid="reader-stage" className="relative flex-1 min-h-0 overflow-hidden">
        <iframe data-testid="reader-frame" title="doc" />
      </div>
    </div>
  ),
}));
vi.mock('../../../../src/renderer/src/components/notes/NotesView', () => ({
  NotesView: () => <div data-testid="notes-view" />,
}));

import { WorkbenchContentPanel } from '../../../../src/renderer/src/components/layout/WorkbenchContentPanel';

const LIT_ITEM = { id: 'l1', absPath: 'C:/papers/a.pdf' };

async function flushLazy(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function hasClass(el: Element, cls: string): boolean {
  return el.classList.contains(cls);
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

describe('文献列 → Reader 的 flex 高度链(单列形态)', () => {
  it('承载 Reader 的容器是 flex 列 + flex-1 + min-h-0', async () => {
    stores.literature.set({ items: [LIT_ITEM], selectedId: 'l1' });
    render(<WorkbenchContentPanel />);
    await flushLazy();

    const readerRoot = screen.getByTestId('reader-root');
    const host = readerRoot.parentElement as HTMLElement;

    expect(hasClass(host, 'flex'), '承载 Reader 的容器必须是 flex 容器').toBe(true);
    expect(hasClass(host, 'flex-col'), '必须是 flex 列 —— 否则子 reader 的 flex-1 撑不开高度').toBe(
      true,
    );
    expect(hasClass(host, 'flex-1'), '必须吃掉剩余高度').toBe(true);
    expect(hasClass(host, 'min-h-0'), '必须 min-h-0 —— 否则 PDF 内容把主区撑出滚动条').toBe(true);
  });

  it('从 reader 根往上的每一层祖先都是 flex 容器(链不能断)', async () => {
    stores.literature.set({ items: [LIT_ITEM], selectedId: 'l1' });
    const { container } = render(<WorkbenchContentPanel />);
    await flushLazy();

    const readerRoot = screen.getByTestId('reader-root');
    const panelRoot = container.firstElementChild as HTMLElement;

    const chain: HTMLElement[] = [];
    let cur: HTMLElement | null = readerRoot.parentElement;
    while (cur) {
      chain.push(cur);
      if (cur === panelRoot) break;
      cur = cur.parentElement;
    }
    // 走到了主区根容器(没走丢)
    expect(chain[chain.length - 1]).toBe(panelRoot);
    expect(chain.length).toBeGreaterThanOrEqual(2);

    for (const el of chain) {
      expect(hasClass(el, 'flex'), `祖先 <${el.className}> 不是 flex 容器 —— 高度链在此断裂`).toBe(
        true,
      );
    }
  });
});

describe('文献列 → Reader 的 flex 高度链(双列形态)', () => {
  it('双列时文献列容器本身是 flex 列 + min-h-0', async () => {
    stores.literature.set({ items: [LIT_ITEM], selectedId: 'l1' });
    stores.notes.set({ selectedId: 'n1' });
    render(<WorkbenchContentPanel />);
    await flushLazy();

    const separator = document.querySelector('[role="separator"]') as HTMLElement;
    expect(separator).toBeTruthy();
    const readerCol = separator.previousElementSibling as HTMLElement;

    expect(hasClass(readerCol, 'flex')).toBe(true);
    expect(hasClass(readerCol, 'flex-col')).toBe(true);
    expect(hasClass(readerCol, 'min-h-0')).toBe(true);
  });

  it('双列时承载 Reader 的容器同样是 flex 列 + flex-1 + min-h-0', async () => {
    stores.literature.set({ items: [LIT_ITEM], selectedId: 'l1' });
    stores.notes.set({ selectedId: 'n1' });
    render(<WorkbenchContentPanel />);
    await flushLazy();

    const host = screen.getByTestId('reader-root').parentElement as HTMLElement;
    expect(hasClass(host, 'flex')).toBe(true);
    expect(hasClass(host, 'flex-col')).toBe(true);
    expect(hasClass(host, 'flex-1')).toBe(true);
    expect(hasClass(host, 'min-h-0')).toBe(true);
  });

  it('双列时笔记列吃掉剩余宽度(flex-1),文献列按固定宽度', async () => {
    stores.literature.set({ items: [LIT_ITEM], selectedId: 'l1' });
    stores.notes.set({ selectedId: 'n1' });
    render(<WorkbenchContentPanel />);
    await flushLazy();

    const separator = document.querySelector('[role="separator"]') as HTMLElement;
    const readerCol = separator.previousElementSibling as HTMLElement;
    const notesCol = separator.nextElementSibling as HTMLElement;

    expect(hasClass(notesCol, 'flex-1')).toBe(true);
    expect(hasClass(notesCol, 'min-h-0')).toBe(true);
    // 文献列宽是持久化的固定值(不是百分比)
    expect(readerCol.style.width).toBe('640px');
  });
});
