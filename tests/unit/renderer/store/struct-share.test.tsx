// tests/unit/renderer/store/struct-share.test.tsx
//
// 守 r258「列表刷新不许把整表换成新对象」契约 ——
//   IPC 快照的**结构共享**:内容没变的条目沿用上一轮的对象引用。
//
// ── 被守卫的缺陷(假绿优化)─────────────────────────────────────────
//   两个列表 store(notes / literature)的 load() 都把 IPC 回来的快照**整
//   表替换**进 state。IPC 走 structured clone ⇒ 每次回来的都是**全新对
//   象**(内容一模一样也是新引用)。于是:
//
//     ① store.notes / store.items 每轮换引用;
//     ② 组件用 `useShallow(s => s.notes)` 订阅 —— useShallow 的浅比是
//        **逐元素 Object.is** ⇒ 元素全是新引用 ⇒ 浅比恒为「不等」⇒
//        **useShallow 从来没生效过**(两处组件注释里写的「浅比较元素相同
//        时不重渲」是**假绿**:元素引用从不相同);
//     ③ 每次 NOTES_CHANGED / LITERATURE_CHANGED(自动保存、外部改盘、网
//        盘同步落盘、另一个窗口写盘)⇒ 整个可见列表 + 每一行都重渲。
//
// ── 本测锁五件事 ───────────────────────────────────────────────────
//   A. store 层:内容完全相同的二次 load ⇒ `notes` **数组引用都不变**
//      (不只是元素,连数组都是旧的)—— 这是 useShallow 能 bail out 的前提;
//   B. store 层:一条笔记变了 ⇒ 变的那条是**新对象**,其余条目**沿用旧
//      引用**(行级 React.memo 只重渲那一条);
//   C. store 层:顺序变了 ⇒ 数组是新数组,但**元素全部沿用旧引用**;
//   D. **组件层(本轮的性能契约本体)**:订阅 `useShallow(s => s.notes)`
//      的组件,在一次「内容完全相同」的 load() 之后**渲染次数不变**
//      —— 修前每次广播都重渲;
//   E. 文献域同款(items 引用不变)。
//
// 文献域与笔记域的 useShallow 订阅点:
//   NotesList.tsx:94 / LiteratureList.tsx:104。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { useShallow } from 'zustand/react/shallow';

vi.mock('../../../../src/renderer/src/store/workspace', () => ({
  useWorkspaceStore: {
    getState: () => ({
      pendingFocusNote: { hasPending: false, payload: null },
      consumeFocusNoteRequest: () => {},
    }),
  },
}));
vi.mock('../../../../src/renderer/src/lib/toast', () => ({
  useToast: {
    getState: () => ({ show: () => {} }),
  },
}));

import { useNotesStore } from '../../../../src/renderer/src/store/notes';
import { useLiteratureStore } from '../../../../src/renderer/src/store/literature';
import type { LiteratureResource, StandaloneNoteSummary } from '../../../../src/shared/types';

function summary(id: string, over: Partial<StandaloneNoteSummary> = {}): StandaloneNoteSummary {
  return {
    id,
    relPath: `${id}.md`,
    filename: `${id}.md`,
    title: null,
    tags: null,
    mtime: 1000,
    ...over,
  };
}

function litItem(id: string, over: Partial<LiteratureResource> = {}): LiteratureResource {
  return {
    id: id as LiteratureResource['id'],
    kind: 'literature',
    title: id,
    mtime: 1000,
    size: 10,
    indexedAt: 0,
    absPath: `C:/lit/${id}.pdf`,
    relPath: `${id}.pdf`,
    rootId: null,
    extractStatus: 'filename-only',
    ...over,
  } as LiteratureResource;
}

interface MockApi {
  listNotes: ReturnType<typeof vi.fn>;
  listLiterature: ReturnType<typeof vi.fn>;
  onNotesChanged: ReturnType<typeof vi.fn>;
  onLiteratureChanged: ReturnType<typeof vi.fn>;
}

function setupMockApi(): MockApi {
  const api: MockApi = {
    listNotes: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    listLiterature: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    onNotesChanged: vi.fn().mockReturnValue(() => {}),
    onLiteratureChanged: vi.fn().mockReturnValue(() => {}),
  };
  // 注意:只**挂** api,不要整体替换 window —— jsdom 环境下 window 就是
  // document 的宿主,整体替换会把 react-dom 依赖的 window/document 一起
  // 抹掉(实测报 "Right-hand side of 'instanceof' is not an object")。
  const w = globalThis as unknown as { window: { api?: MockApi } };
  w.window.api = api;
  useNotesStore.setState({
    notes: [],
    selectedIds: new Set<string>(),
    selectedId: null,
    activeNoteFull: null,
    anchorId: null,
    clipboard: null,
    lastError: null,
    displayOrderById: {},
  });
  useLiteratureStore.setState({
    items: [],
    selectedId: null,
    loading: false,
    lastError: null,
    selectedIds: new Set<string>(),
    anchorId: null,
    clipboard: null,
    displayOrderById: {},
  });
  return api;
}

describe('列表快照的结构共享(r258)', () => {
  let api: MockApi;

  beforeEach(() => {
    api = setupMockApi();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('A 内容完全相同的二次 load ⇒ notes 数组引用都不变', async () => {
    api.listNotes.mockResolvedValue({ ok: true, data: [summary('a'), summary('b')] });
    await useNotesStore.getState().load();
    const first = useNotesStore.getState().notes;
    expect(first).toHaveLength(2);

    // IPC 再发一次「一模一样」的内容(structured clone ⇒ 全是新对象)
    api.listNotes.mockResolvedValue({ ok: true, data: [summary('a'), summary('b')] });
    await useNotesStore.getState().load();
    const second = useNotesStore.getState().notes;

    expect(second, '内容没变却换数组引用 ⇒ useShallow 的浅比永远判「不等」').toBe(first);
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
  });

  it('B 一条笔记变了 ⇒ 变的那条换新对象,其余沿用旧引用', async () => {
    api.listNotes.mockResolvedValue({ ok: true, data: [summary('a'), summary('b')] });
    await useNotesStore.getState().load();
    const first = useNotesStore.getState().notes;

    api.listNotes.mockResolvedValue({
      ok: true,
      data: [summary('a', { mtime: 2000, title: 'A' }), summary('b')],
    });
    await useNotesStore.getState().load();
    const second = useNotesStore.getState().notes;

    expect(second, '有一条变了 ⇒ 数组必须换新引用').not.toBe(first);
    expect(second[0], '变的那条必须是新对象').not.toBe(first[0]);
    expect(second[1], '没变的那条必须沿用旧引用(行级 memo 才不会白失效)').toBe(first[1]);
  });

  it('C 顺序变了 ⇒ 新数组,但元素全部沿用旧引用', async () => {
    api.listNotes.mockResolvedValue({ ok: true, data: [summary('a'), summary('b')] });
    await useNotesStore.getState().load();
    const first = useNotesStore.getState().notes;

    api.listNotes.mockResolvedValue({ ok: true, data: [summary('b'), summary('a')] });
    await useNotesStore.getState().load();
    const second = useNotesStore.getState().notes;

    expect(second).not.toBe(first);
    expect(second[0]).toBe(first[1]);
    expect(second[1]).toBe(first[0]);
  });

  it('D 组件层:内容相同的 load ⇒ useShallow 订阅者不重渲(本轮的性能契约)', async () => {
    api.listNotes.mockResolvedValue({ ok: true, data: [summary('a'), summary('b')] });

    let renders = 0;
    function Probe(): JSX.Element {
      const notes = useNotesStore(useShallow((s) => s.notes));
      renders += 1;
      return <div data-testid="count">{notes.length}</div>;
    }

    render(<Probe />);
    await act(async () => {
      await useNotesStore.getState().load();
    });
    const afterFirst = renders;
    expect(afterFirst).toBeGreaterThan(0);

    // 第二次:IPC 内容一模一样(新对象)—— 组件**不该**重渲
    api.listNotes.mockResolvedValue({ ok: true, data: [summary('a'), summary('b')] });
    await act(async () => {
      await useNotesStore.getState().load();
    });

    expect(
      renders,
      '内容一个字没变却整表重渲 —— 这就是 useShallow 一直没生效的代价',
    ).toBe(afterFirst);
  });

  it('F 带 tags 的笔记:tags 内容相同也算「没变」(数组要逐元素比)', async () => {
    api.listNotes.mockResolvedValue({ ok: true, data: [summary('a', { tags: ['x', 'y'] })] });
    await useNotesStore.getState().load();
    const first = useNotesStore.getState().notes;

    // tags 经 IPC clone 后是**新数组**,但内容一样 —— 必须判为「没变」
    api.listNotes.mockResolvedValue({ ok: true, data: [summary('a', { tags: ['x', 'y'] })] });
    await useNotesStore.getState().load();
    const second = useNotesStore.getState().notes;

    expect(second, 'tags 数组是新对象但内容一样 ⇒ 必须判为「没变」').toBe(first);
  });

  it('E 文献域同款:内容相同的 load ⇒ items 数组引用不变', async () => {
    api.listLiterature.mockResolvedValue({ ok: true, data: [litItem('x'), litItem('y')] });
    await useLiteratureStore.getState().load({ force: true });
    const first = useLiteratureStore.getState().items;
    expect(first).toHaveLength(2);

    api.listLiterature.mockResolvedValue({ ok: true, data: [litItem('x'), litItem('y')] });
    await useLiteratureStore.getState().load({ force: true });
    const second = useLiteratureStore.getState().items;

    expect(second).toBe(first);
    expect(second[0]).toBe(first[0]);
  });
});
