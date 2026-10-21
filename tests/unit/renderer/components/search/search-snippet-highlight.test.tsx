// tests/unit/renderer/components/search/search-snippet-highlight.test.tsx
//
// 守 r194「搜索结果预览把 <mark> 标签当普通文字显示」契约。
//
// 现象:主进程 FTS5 的 snippet() 产出的是「命中片段包在 <mark> / </mark>
// 里」的字符串;旧实现直接在结果行渲染 `{hit.snippet}` —— React 把它当
// 纯文本 ⇒ 用户看到的预览是
//
//   本文介绍<mark>学习</mark>模型的基...
//
// 即标签的字面量,而不是高亮。命中预览是搜索面板里最显眼的输出,这个
// 缺陷等于「高亮功能从未生效」。
//
// 本测锁三件事:
//   1. 用户可见结果:命中片段渲染成真正的 <mark> 元素,文本里不再出现
//      "<mark>" 字面量;
//   2. 安全:片段正文来自用户写的笔记,渲染路径**不得**把它当 HTML 解析
//      (dangerouslySetInnerHTML)—— 笔记里的 "<script>" 只能是文本;
//   3. 边界:缺标记 / 只有半个标记 / 空串都不崩、不丢字。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { SearchSnippet, splitSearchSnippet } from '../../../../../src/renderer/src/components/search/SearchSnippet';

// i18n:面板走 useTranslation / i18next.t —— 只关心结构,不关心文案
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock('i18next', () => ({
  t: (k: string) => k,
}));

// store:面板只在「点中命中项」时读 store.getState(),渲染期不读 ——
// 这里给最小桩,避免把整个 notes/literature store 的 IPC 副作用拖进测试
vi.mock('../../../../../src/renderer/src/store/notes', () => ({
  useNotesStore: { getState: () => ({ select: vi.fn() }) },
}));
vi.mock('../../../../../src/renderer/src/store/literature', () => ({
  useLiteratureStore: { getState: () => ({ select: vi.fn() }) },
}));
vi.mock('../../../../../src/renderer/src/store/workspace', () => ({
  useWorkspaceStore: { getState: () => ({ setActive: vi.fn(), requestFocusNote: vi.fn() }) },
}));

const MARKED = '本文介绍<mark>学习</mark>模型的基本原理';

describe('splitSearchSnippet(r194)', () => {
  it('无标记 → 单个非命中段', () => {
    expect(splitSearchSnippet('纯文本')).toEqual([{ text: '纯文本', hit: false }]);
  });
  it('有标记 → 命中段与上下文段分开', () => {
    expect(splitSearchSnippet(MARKED)).toEqual([
      { text: '本文介绍', hit: false },
      { text: '学习', hit: true },
      { text: '模型的基本原理', hit: false },
    ]);
  });
  it('空串 → 空数组', () => {
    expect(splitSearchSnippet('')).toEqual([]);
  });
  it('只有开始标记 → 剩余整段算命中,不丢字', () => {
    expect(splitSearchSnippet('前缀<mark>尾巴')).toEqual([
      { text: '前缀', hit: false },
      { text: '尾巴', hit: true },
    ]);
  });
  it('只有结束标记 → 当普通文本(不吞字)', () => {
    expect(splitSearchSnippet('尾巴</mark>')).toEqual([{ text: '尾巴</mark>', hit: false }]);
  });
});

describe('SearchSnippet 渲染(r194)', () => {
  afterEach(() => {
    cleanup();
  });

  it('命中片段渲染成真正的 <mark> 元素,标签不再字面量出现', () => {
    const { container } = render(<SearchSnippet snippet={MARKED} />);
    const marks = container.querySelectorAll('mark');
    expect(marks).toHaveLength(1);
    expect(marks[0]!.textContent).toBe('学习');
    // 可见文本 = 原文去掉标记
    expect(container.textContent).toBe('本文介绍学习模型的基本原理');
    // 字面量不得出现在可见文本里
    expect(container.textContent).not.toContain('<mark>');
    expect(container.textContent).not.toContain('</mark>');
  });

  it('笔记正文里的 <script> 只作为文本显示,不被解析成元素', () => {
    const nasty = '正文<script>alert(1)</script>结尾<mark>命中</mark>';
    const { container } = render(<SearchSnippet snippet={nasty} />);
    // 没有任何 script 元素落进 DOM
    expect(container.querySelector('script')).toBeNull();
    // 内容以文本形式完整保留
    expect(container.textContent).toContain('<script>alert(1)</script>');
    expect(container.querySelectorAll('mark')).toHaveLength(1);
  });

  it('空片段 → 不渲染任何内容且不崩', () => {
    const { container } = render(<SearchSnippet snippet="" />);
    expect(container.textContent).toBe('');
  });
});

// === 面板级:用户实际看到的东西 ===
describe('SearchPanel 命中行(r194)', () => {
  const hit = {
    kind: 'note' as const,
    id: 'note-1',
    relPath: 'a.md',
    title: '深度学习综述',
    snippet: MARKED,
    score: 1,
  };
  beforeEach(() => {
    (window as unknown as { api: unknown }).api = {
      search: vi.fn().mockResolvedValue({ ok: true, data: [hit] }),
    };
  });
  afterEach(() => {
    cleanup();
  });

  it('命中行渲染出 <mark> 元素,预览里没有标签字面量', async () => {
    const { SearchPanel } = await import(
      '../../../../../src/renderer/src/components/search/SearchPanel'
    );
    render(<SearchPanel open onClose={() => {}} />);
    // 输入查询词(面板 300ms debounce 后才发 IPC)
    // Overlay 走 Portal 渲染到 document.body —— input 不在 container 里
    const input = document.querySelector('input')!;
    fireEvent.change(input, { target: { value: '学习' } });
    await waitFor(
      () => {
        expect(document.querySelectorAll('mark').length).toBeGreaterThan(0);
      },
      { timeout: 3000 },
    );
    expect(document.querySelector('mark')!.textContent).toBe('学习');
    // 整个面板的可读文本里都不该出现标签字面量
    expect(document.body.textContent).not.toContain('<mark>');
    expect(document.body.textContent).not.toContain('</mark>');
  });
});
