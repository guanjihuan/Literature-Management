// tests/unit/renderer/components/markdown-editor-sync-cost.test.tsx
//
// 守 r247「每次击键造两份全文字符串」的修复契约 ——
//   MarkdownEditor 的「value → view 同步」这一步不得再把整篇正文
//   (doc.toString())重新构一遍。
//
// 背景(用户诉求「使用流畅,不要有卡顿」):
//   旧实现在**每次击键**做两次全文字符串构建:
//     ① updateListener:`onChangeRef.current(u.state.doc.toString())`
//        —— 必需(要把新正文交给上层),O(全文长);
//     ② effect [value]:`view.state.doc.toString() !== value`
//        —— 又造一份同样的全文字符串,只为了回答「doc 是不是已经等于
//           value?」;而答案几乎恒为「相等」(value 就是 ① 刚发上去的那份)
//           ⇒ 整次 O(n) 构建 + 比较纯属浪费。
//   10 万字笔记 = 每次击键多造一个 10 万字符的字符串,连续输入时
//   GC 压力明显(整串不可增量复用)。
//
// 修法:lastEmittedRef 记「本编辑器最后一次自己发出去的正文」;
//   value === lastEmitted ⇒ doc 里已经是它 ⇒ O(1) 短路,连 toString 都不调。
//
// 本测锁两个可观测量:
//   A. 击键 N 次 ⇒ doc.toString() 调用次数 = 1(mount 时的初始比对)+ N(每次
//      击键 listener 那一次)—— **effect 那一步必须是 0 次**;
//   B. 外部改 value(切笔记 / 外部写 body)⇒ 仍必须走完整比较并 dispatch
//      (短路不能把外部改动吃掉)。
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { useState } from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

// ── 假 CodeMirror ─────────────────────────────────────────────────────────
// 够用即可:只实现本组件用到的那几个 API,并把 updateListener 的回调
// 暴露出来,让测试能手动「敲一次键」。
const cm = vi.hoisted(() => {
  const api = {
    doc: '',
    toStringCalls: 0,
    dispatches: [] as Array<unknown>,
    listeners: [] as Array<(u: unknown) => void>,
    view: null as null | { state: unknown; dispatch: (tr: unknown) => void },
    // 撤销栈深度(假 CodeMirror 专用)—— 供 undoDepth/redoDepth 回答
    undoDepth: 0,
    redoDepth: 0,
    makeDoc() {
      return {
        get length() {
          return api.doc.length;
        },
        toString() {
          api.toStringCalls += 1;
          return api.doc;
        },
      };
    },
    reset() {
      api.doc = '';
      api.toStringCalls = 0;
      api.dispatches = [];
      api.listeners = [];
      api.view = null;
      api.undoDepth = 0;
      api.redoDepth = 0;
    },
  };
  return api;
});

vi.mock('@codemirror/state', () => ({
  EditorState: {
    create({ doc, extensions }: { doc: string; extensions: unknown[] }) {
      cm.doc = doc;
      cm.listeners = [];
      for (const ext of extensions) {
        const e = ext as { __kind?: string; __fn?: (u: unknown) => void };
        if (e && e.__kind === 'updateListener' && typeof e.__fn === 'function') {
          cm.listeners.push(e.__fn);
        }
      }
      return { doc: cm.makeDoc(), extensions };
    },
  },
  // 撤销栈相关:外部灌入的正文必须带 addToHistory:false(不进撤销栈)
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
    dispatch(tr: { changes?: { insert?: string } }) {
      cm.dispatches.push(tr);
      if (tr && tr.changes) {
        cm.doc = tr.changes.insert ?? cm.doc;
        this.state = { doc: cm.makeDoc() };
        for (const l of cm.listeners) l({ docChanged: true, state: this.state });
      }
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
  // 撤销栈深度 —— 编辑器每次状态变化都会问一次(按钮 enabled 态的来源)
  undoDepth: () => cm.undoDepth,
  redoDepth: () => cm.redoDepth,
  undo: () => true,
  redo: () => true,
}));

vi.mock('@codemirror/lang-markdown', () => ({
  markdown: () => ({ __kind: 'markdown' }),
  markdownLanguage: { __kind: 'markdownLanguage' },
}));

import { MarkdownEditor } from '../../../../src/renderer/src/components/editor/MarkdownEditor';

/** 模拟一次击键:doc 变了 ⇒ CodeMirror 触发 updateListener。 */
function type(text: string): void {
  cm.doc = text;
  for (const l of cm.listeners) l({ docChanged: true, state: cm.view?.state });
}

function Harness({ initial }: { initial: string }) {
  const [v, setV] = useState(initial);
  return (
    <>
      <MarkdownEditor value={v} onChange={setV} />
      <output data-testid="out">{v}</output>
    </>
  );
}

/** 受控 harness:同一个编辑器实例上换 value(模拟外部改 body / 换笔记)。 */
function Controlled({ value }: { value: string }) {
  return <MarkdownEditor value={value} onChange={() => {}} />;
}

describe('perf r247:MarkdownEditor 击键同步成本', () => {
  beforeEach(() => {
    cm.reset();
  });

  it('连击 N 次 ⇒ doc.toString() 只在「mount 比对 + 每次击键的 listener」被调,effect 那一步为 0', async () => {
    const { getByTestId } = render(<Harness initial="hello" />);
    await waitFor(() => expect(cm.view).not.toBeNull());
    // mount:创建 view 后比对一次(initialDoc === value ⇒ 不 dispatch)
    expect(cm.toStringCalls, 'mount 只应比对一次').toBe(1);

    for (const text of ['hello!', 'hello!!', 'hello!!!']) {
      act(() => {
        type(text);
      });
      expect(getByTestId('out').textContent, '击键内容必须真的到了上层').toBe(text);
    }

    // 3 次击键 ⇒ listener 3 次 + mount 1 次 = 4
    // 旧实现 = 4 + 3(effect 每次再构一份全文)= 7
    expect(cm.toStringCalls, '同步 effect 不得再构全文').toBe(4);
  });

  it('外部改 value ⇒ 仍走完整比较并 dispatch(短路不能吃掉外部改动)', async () => {
    const { rerender } = render(<Controlled value="hello" />);
    await waitFor(() => expect(cm.view).not.toBeNull());

    rerender(<Controlled value="外部写进来的正文" />);

    await waitFor(() => expect(cm.dispatches.length).toBeGreaterThan(0));
    const tr = cm.dispatches[0] as { changes: { insert: string } };
    expect(tr.changes.insert, '外部正文必须被 dispatch 进编辑器').toBe('外部写进来的正文');
    expect(cm.doc).toBe('外部写进来的正文');
  });
});
