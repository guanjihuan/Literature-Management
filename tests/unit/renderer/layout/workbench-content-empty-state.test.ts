// tests/unit/renderer/layout/workbench-content-empty-state.test.ts
//
// 守 WorkbenchContentPanel 的**空态契约**
// (src/renderer/src/components/layout/WorkbenchContentPanel.tsx 头注指向本文件)。
//
// 契约两条:
//
//   1. 【行为级】两个模块都没打开时,主区给空态,身份跟随左栏 active:
//        active='notes'   → 笔记空态(notes.viewEmptyTitle / notes.viewEmptyDesc)
//        active='library' → 文献空态(literature.viewEmptyTitle / …)
//      空态是 role="status" + aria-live="polite"(读屏用户听得见「未选中」,
//      但不打断当前播报 —— 旧状态若变成 assertive 会在用户读文献时插播)。
//      视觉身份跟随模块色(notes 蓝 / library 紫),用户一眼知道该点左边哪一栏。
//
//   2. 【源码顺序】文件里**第一个** <EmptyState … liveRegion="polite" />
//      必须属于 NotesEmptyState(第二个才是 LibraryEmptyState)。
//      退化(把两个 EmptyState 的定义顺序对调 / 把 library 的搬前面)⇒
//      顺序型守卫取样会打到 library 块上,「笔记空态先播报」的约定被打偏,
//      而且后续任何按「第一个 EmptyState」取样的工具都会静默取错。
//
// 变异思路(下列任一改动会红):
//   - 把 LibraryEmptyState 的定义搬到 NotesEmptyState 前面
//   - 把 liveRegion="polite" 改成 "assertive" / 去掉
//   - 把 notes 空态的 title / description 换成 literature 的键
//   - 把 accent="notes" 改成 accent="library"(模块色身份串了)
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, act } from '@testing-library/react';
import { createElement } from 'react';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// i18n:键原样返回 —— 空态文案本身就是契约的一部分(直接断言键名)
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

// 本文件是 .ts(指针指定)⇒ 不用 JSX,mock 组件用 createElement 造。
vi.mock('../../../../src/renderer/src/components/reader/Reader', async () => {
  const { createElement } = await import('react');
  return { Reader: () => createElement('div', { 'data-testid': 'reader' }) };
});
vi.mock('../../../../src/renderer/src/components/notes/NotesView', async () => {
  const { createElement } = await import('react');
  return { NotesView: () => createElement('div', { 'data-testid': 'notes-view' }) };
});

import { WorkbenchContentPanel } from '../../../../src/renderer/src/components/layout/WorkbenchContentPanel';

const SRC_PATH = resolve(
  process.cwd(),
  'src/renderer/src/components/layout/WorkbenchContentPanel.tsx',
);

/** 去掉注释(行注释 + 块注释),保留字符串字面量。
 *  源码头部注释里写着「取样只认裸名字」,但注释一旦写到同样的字面组合
 *  就会把取样起点带偏 —— 与其指望人不写,不如让取样器自己跳过注释。 */
function stripComments(src: string): string {
  let out = '';
  let state: 'code' | 'line' | 'block' | 'sq' | 'dq' = 'code';
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (state === 'code') {
      if (c === '/' && next === '/') {
        state = 'line';
        i += 2;
        continue;
      }
      if (c === '/' && next === '*') {
        state = 'block';
        i += 2;
        continue;
      }
      if (c === "'") {
        state = 'sq';
      } else if (c === '"') {
        state = 'dq';
      }
      out += c;
      i += 1;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'code';
        out += '\n';
      }
      i += 1;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && next === '/') {
        state = 'code';
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    // 字符串内部
    if (c === '\\') {
      out += src.slice(i, i + 2);
      i += 2;
      continue;
    }
    if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"')) state = 'code';
    out += c;
    i += 1;
  }
  return out;
}

/** 从 <EmptyState 开始取到**配平的**自闭合标签。
 *  属性里的 icon={<NotebookPen … />} 自带一个 '/>' —— 直接找第一个 '/>'
 *  会在 icon 处截断,取不到 title / liveRegion。 */
function extractJsxElement(src: string, start: number): string {
  let curly = 0;
  let angle = 0;
  let paren = 0;
  for (let i = start; i < src.length; i += 1) {
    const c = src[i]!;
    if (c === '{') curly += 1;
    else if (c === '}') curly -= 1;
    else if (c === '<') angle += 1;
    else if (c === '>') angle -= 1;
    else if (c === '(') paren += 1;
    else if (c === ')') paren -= 1;
    else if (
      c === '/' &&
      src[i + 1] === '>' &&
      curly === 0 &&
      angle === 0 &&
      paren === 0
    ) {
      return src.slice(start, i + 2);
    }
  }
  return src.slice(start);
}

function extractEmptyStateBlocks(src: string): string[] {
  const blocks: string[] = [];
  const re = /<EmptyState\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    blocks.push(extractJsxElement(src, m.index));
    re.lastIndex = m.index + 1;
  }
  return blocks;
}

// NotesView / Reader 都是 React.lazy —— 组件本体要等动态 import 落地。
// 「断言不存在」之前也必须 flush,否则「还没加载出来」会被误当成「不存在」。
async function flushLazy(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function setActive(active: 'library' | 'notes'): void {
  act(() => {
    stores.workspace.set({ active });
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

describe('空态:身份跟随左栏 Tab(两个模块都没打开时)', () => {
  it('active=notes ⇒ 笔记空态', () => {
    setActive('notes');
    render(createElement(WorkbenchContentPanel));
    expect(screen.getByText('notes.viewEmptyTitle')).toBeTruthy();
    expect(screen.getByText('notes.viewEmptyDesc')).toBeTruthy();
    expect(screen.queryByText('literature.viewEmptyTitle')).toBeNull();
  });

  it('active=library ⇒ 文献空态', () => {
    setActive('library');
    render(createElement(WorkbenchContentPanel));
    expect(screen.getByText('literature.viewEmptyTitle')).toBeTruthy();
    expect(screen.getByText('literature.viewEmptyDesc')).toBeTruthy();
    expect(screen.queryByText('notes.viewEmptyTitle')).toBeNull();
  });

  it('空态是 polite live region(读屏播报但不打断)', () => {
    setActive('notes');
    render(createElement(WorkbenchContentPanel));
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
  });

  it('空态视觉身份跟随模块色(notes 蓝 / library 紫)', () => {
    setActive('notes');
    const { unmount } = render(createElement(WorkbenchContentPanel));
    const notesIconBox = screen.getByRole('status').firstElementChild as HTMLElement;
    expect(notesIconBox.getAttribute('style')).toContain('--module-notes-rgb');
    unmount();

    setActive('library');
    render(createElement(WorkbenchContentPanel));
    const libIconBox = screen.getByRole('status').firstElementChild as HTMLElement;
    expect(libIconBox.getAttribute('style')).toContain('--module-library-rgb');
  });

  it('有打开态时不出现空态', async () => {
    stores.notes.set({ selectedId: 'n1' });
    render(createElement(WorkbenchContentPanel));
    await flushLazy();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText('notes.viewEmptyTitle')).toBeNull();
  });
});

describe('源码顺序:第一个 polite EmptyState 必须是笔记空态', () => {
  const source = readFileSync(SRC_PATH, 'utf8');
  const blocks = extractEmptyStateBlocks(stripComments(source));

  it('文件里恰好两个 EmptyState', () => {
    expect(blocks).toHaveLength(2);
  });

  it('两个都声明 liveRegion="polite"', () => {
    for (const b of blocks) expect(b).toContain('liveRegion="polite"');
  });

  it('第一个是笔记空态(title/desc/accent 都是 notes)', () => {
    expect(blocks[0]).toContain('notes.viewEmptyTitle');
    expect(blocks[0]).toContain('notes.viewEmptyDesc');
    expect(blocks[0]).toContain('accent="notes"');
    expect(blocks[0]).not.toContain('literature.viewEmptyTitle');
  });

  it('第二个是文献空态(title/desc/accent 都是 library)', () => {
    expect(blocks[1]).toContain('literature.viewEmptyTitle');
    expect(blocks[1]).toContain('literature.viewEmptyDesc');
    expect(blocks[1]).toContain('accent="library"');
    expect(blocks[1]).not.toContain('notes.viewEmptyTitle');
  });

  it('取样器不会被注释里的同名字面量带偏(自检)', () => {
    // 构造一份「注释里先出现 polite EmptyState」的样本 —— 真源码也可能
    // 以后被人加注释写进同样的字面量,取样器必须只认代码里的。
    const sample = `
// <EmptyState liveRegion="polite" title={'library.viewEmptyTitle'} />
function NotesEmptyState() {
  return <EmptyState liveRegion="polite" title={t('notes.viewEmptyTitle')} />;
}
`;
    const sampled = extractEmptyStateBlocks(stripComments(sample));
    expect(sampled).toHaveLength(1);
    expect(sampled[0]).toContain('notes.viewEmptyTitle');
    expect(sampled[0]).not.toContain('library.viewEmptyTitle');
  });
});
