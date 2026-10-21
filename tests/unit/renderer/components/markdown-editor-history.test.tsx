// tests/unit/renderer/components/markdown-editor-history.test.tsx
//
// 守「笔记编辑的撤销 / 重做」在**编辑器层**的三条契约:
//   1. 能力上报:doc 变了之后,编辑器把「现在能不能撤 / 能不能重做」告诉上层,
//      且**只在翻转时**上报(每次击键都上报 ⇒ 父级每次击键都重渲 = perf 回归);
//   2. 外部灌入的正文**不进撤销栈**(用户按撤销撤的是「自己敲的字」,
//      不是「外部替换进来的整篇」)⇒ dispatch 必须带 addToHistory:false;
//   3. 换文档(docToken 变化)⇒ 重建 state ⇒ 撤销栈归零 —— 否则在新笔记里
//      按「撤销」会撤掉**上一篇**笔记的字(还会被 autosave 写进新笔记,
//      跨笔记污染正文)。
//
// 第 3 条是本轮最隐蔽的一条:CodeMirror 的 history 是挂在 EditorState 上的
// StateField,切笔记只是把正文整段替换掉,旧笔记的编辑事件仍留在栈里。
// 「整段替换 + addToHistory:false」顺带清栈的路子依赖「替换范围覆盖全部
// 历史事件」—— 正文为空时替换是空操作 ⇒ 清不掉 ⇒ 必须走 setState 重建。
//
// 变异思路(哪几处改动会红):
//   - 去掉 reportHistory 调用 / 不比较翻转 ⇒ 例 1 红;
//   - 去掉 annotations(Transaction.addToHistory.of(false)) ⇒ 例 2 红;
//   - setState 路径改成普通 dispatch(或不重建) ⇒ 例 3 红。
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { useState } from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

// ── 假 CodeMirror ─────────────────────────────────────────────────────────
// 够用即可:实现本组件用到的那几个 API,并把 updateListener 的回调暴露出来,
// 让测试能手动「敲一次键」。撤销栈用两个计数器模拟:
//   undoDepth/redoDepth —— 当前栈深(> 0 即「能撤 / 能重做」);
//   EditorState.create —— 造新 state ⇒ 栈归零(真实 CodeMirror 的 history
//   是 StateField,新 state = 字段初始值 = 空栈)。
const cm = vi.hoisted(() => {
  const api = {
    doc: '',
    undoDepth: 0,
    redoDepth: 0,
    dispatches: [] as Array<{ changes?: { insert?: string }; annotations?: unknown }>,
    listeners: [] as Array<(u: unknown) => void>,
    setStates: [] as Array<{ doc: string }>,
    focusCalls: 0,
    undoCalls: 0,
    redoCalls: 0,
    view: null as null | {
      state: unknown;
      dispatch: (tr: unknown) => void;
      setState: (s: unknown) => void;
      focus: () => void;
    },
    makeDoc() {
      return {
        get length() {
          return api.doc.length;
        },
        toString() {
          return api.doc;
        },
      };
    },
    reset() {
      api.doc = '';
      api.undoDepth = 0;
      api.redoDepth = 0;
      api.dispatches = [];
      api.listeners = [];
      api.setStates = [];
      api.focusCalls = 0;
      api.undoCalls = 0;
      api.redoCalls = 0;
      api.view = null;
    },
  };
  return api;
});

vi.mock('@codemirror/state', () => ({
  EditorState: {
    create({ doc, extensions }: { doc: string; extensions: unknown[] }) {
      cm.doc = doc;
      cm.listeners = [];
      // 新 state ⇒ 撤销栈归零(history 是 StateField,新 state = 初始值)
      cm.undoDepth = 0;
      cm.redoDepth = 0;
      for (const ext of extensions) {
        const e = ext as { __kind?: string; __fn?: (u: unknown) => void };
        if (e && e.__kind === 'updateListener' && typeof e.__fn === 'function') {
          cm.listeners.push(e.__fn);
        }
      }
      return { doc: cm.makeDoc(), extensions };
    },
  },
  Transaction: {
    addToHistory: { of: (v: boolean) => ({ __kind: 'addToHistory', value: v }) },
  },
}));

vi.mock('@codemirror/view', () => {
  const facet = (kind: string) => ({
    of: (v: unknown) => ({ __kind: kind, __fn: v }),
  });
  class EditorView {
    state: unknown;
    parent: unknown;
    constructor(opts: { state: unknown; parent: unknown }) {
      this.state = opts.state;
      this.parent = opts.parent;
      cm.view = this as never;
    }
    dispatch(tr: { changes?: { insert?: string }; annotations?: unknown }) {
      cm.dispatches.push(tr);
      if (tr && tr.changes) {
        cm.doc = tr.changes.insert ?? cm.doc;
        this.state = { doc: cm.makeDoc() };
        for (const l of cm.listeners) l({ docChanged: true, state: this.state });
      }
    }
    setState(state: { doc: { toString: () => string } }) {
      cm.setStates.push({ doc: state.doc.toString() });
      cm.doc = state.doc.toString();
      this.state = state;
    }
    focus() {
      cm.focusCalls += 1;
    }
    destroy() {
      /* noop */
    }
    static theme() {
      return { __kind: 'theme' };
    }
    static lineWrapping = { __kind: 'lineWrapping' };
    static contentAttributes = facet('contentAttributes');
    static updateListener = facet('updateListener');
  }
  return {
    EditorView,
    keymap: { of: () => ({ __kind: 'keymap' }) },
    drawSelection: () => ({ __kind: 'drawSelection' }),
    dropCursor: () => ({ __kind: 'dropCursor' }),
    rectangularSelection: () => ({ __kind: 'rectangularSelection' }),
  };
});

vi.mock('@codemirror/commands', () => ({
  defaultKeymap: [],
  historyKeymap: [],
  indentWithTab: { __kind: 'indentWithTab' },
  history: () => ({ __kind: 'history' }),
  undoDepth: () => cm.undoDepth,
  redoDepth: () => cm.redoDepth,
  undo: () => {
    cm.undoCalls += 1;
    return true;
  },
  redo: () => {
    cm.redoCalls += 1;
    return true;
  },
}));

vi.mock('@codemirror/lang-markdown', () => ({
  markdown: () => ({ __kind: 'markdown' }),
  markdownLanguage: { __kind: 'markdownLanguage' },
}));

import { MarkdownEditor, type EditorHistoryFlags } from '../../../../src/renderer/src/components/editor/MarkdownEditor';

/** 模拟一次击键:doc 变了 ⇒ CodeMirror 触发 updateListener(并进撤销栈)。 */
function type(text: string): void {
  cm.doc = text;
  cm.undoDepth = 1;
  for (const l of cm.listeners) l({ docChanged: true, state: cm.view?.state });
}

describe('MarkdownEditor:撤销 / 重做(编辑器层)', () => {
  beforeEach(() => {
    cm.reset();
  });

  it('1. 能力上报:doc 变了之后上报 canUndo,只在**翻转**时上报', async () => {
    const seen: EditorHistoryFlags[] = [];
    function Harness() {
      const [v, setV] = useState('hello');
      return (
        <MarkdownEditor
          value={v}
          onChange={setV}
          onHistoryChange={(f) => seen.push(f)}
        />
      );
    }
    render(<Harness />);
    await waitFor(() => expect(cm.view).not.toBeNull());

    // 还没敲过字 ⇒ 栈是空的 ⇒ 上报一次 canUndo=false
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toEqual({ canUndo: false, canRedo: false });

    // 敲一次字 ⇒ 栈深 1 ⇒ 上报 canUndo=true
    act(() => {
      type('hello!');
    });
    expect(seen[seen.length - 1]).toEqual({ canUndo: true, canRedo: false });

    // 再敲几次 ⇒ 能力位没翻转 ⇒ **不得**再上报(否则父级每次击键都重渲)
    const countAfterFlip = seen.length;
    act(() => {
      type('hello!!');
      type('hello!!!');
    });
    expect(seen.length, '能力位没翻转就不该再上报').toBe(countAfterFlip);
  });

  it('2. 外部灌入的正文不进撤销栈(dispatch 带 addToHistory:false)', async () => {
    function Controlled({ value }: { value: string }) {
      return <MarkdownEditor value={value} onChange={() => {}} />;
    }
    const { rerender } = render(<Controlled value="hello" />);
    await waitFor(() => expect(cm.view).not.toBeNull());

    rerender(<Controlled value="外部写进来的正文" />);
    await waitFor(() => expect(cm.dispatches.length).toBeGreaterThan(0));

    const tr = cm.dispatches[0] as { annotations?: { __kind?: string; value?: boolean } };
    expect(tr.annotations?.__kind, '外部同步必须带 addToHistory 标注').toBe('addToHistory');
    expect(tr.annotations?.value).toBe(false);
  });

  it('3. 换文档(docToken 变化)⇒ 重建 state ⇒ 撤销栈归零 + 灌入新正文', async () => {
    function Controlled({ value, token }: { value: string; token: number }) {
      return <MarkdownEditor value={value} onChange={() => {}} docToken={token} />;
    }
    const { rerender } = render(<Controlled value="第一篇" token={1} />);
    await waitFor(() => expect(cm.view).not.toBeNull());

    // 用户在第一篇里敲了字 ⇒ 栈深 1
    act(() => {
      type('第一篇改过了');
    });
    expect(cm.undoDepth).toBe(1);

    // 切到第二篇(token 变)⇒ 重建 state ⇒ 栈归零
    rerender(<Controlled value="第二篇" token={2} />);
    await waitFor(() => expect(cm.setStates.length).toBe(1));
    expect(cm.setStates[0].doc).toBe('第二篇');
    expect(cm.undoDepth, '换文档后撤销栈必须归零').toBe(0);
  });

  it('4. 命令式句柄:undo / redo 走 CodeMirror 的命令,并把焦点还给编辑器', async () => {
    const apiRef: { current: import('../../../../src/renderer/src/components/editor/MarkdownEditor').MarkdownEditorApi | null } =
      { current: null };
    render(<MarkdownEditor value="hello" onChange={() => {}} apiRef={apiRef} />);
    await waitFor(() => expect(cm.view).not.toBeNull());
    expect(apiRef.current, '父级必须拿得到命令式句柄').toBeTruthy();

    act(() => {
      apiRef.current?.undo();
    });
    expect(cm.undoCalls).toBe(1);
    // 点按钮会把焦点挪到按钮上 ⇒ 撤销后必须把焦点还给编辑器,光标才看得见
    expect(cm.focusCalls).toBeGreaterThan(0);

    act(() => {
      apiRef.current?.redo();
    });
    expect(cm.redoCalls).toBe(1);
  });
});
