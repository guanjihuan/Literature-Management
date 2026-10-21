// tests/unit/renderer/components/codemirror-history-semantics.test.ts
//
// 守「笔记撤销 / 重做」所依赖的 **CodeMirror 6 真实语义**(用真库,不用假实现)。
//
// 为什么要有这层:markdown-editor-history.test.tsx 里 CodeMirror 是被 mock 掉的,
// 它只能证明「我们的代码传了正确的参数」;证明不了「这些参数在真 CodeMirror 上
// 真的产生我们想要的结果」。若哪天 CodeMirror 改了 history 的语义(例如
// addToHistory:false 不再清栈 / setState 不再重置 history),mock 版测试照样全绿,
// 而真机上会悄悄退化成「跨笔记撤销污染」。这层就是那个沉默退化的警报器。
//
// 锁的三条真实语义(本轮实现的前提):
//   1. history 是挂在 EditorState 上的 StateField ⇒ view.setState(新 state)
//      ⇒ 撤销栈**归零**(这是「切笔记清空撤销栈」唯一可靠的实现方式);
//   2. 整段替换 + Transaction.addToHistory.of(false) ⇒ 外部灌入的正文不进栈;
//   3. 关键场景:笔记 A 里敲了字 → 切到笔记 B(setState)→ 在 B 里按撤销
//      ⇒ **撤不了任何东西、也不能把 A 的字撤回来**(跨笔记污染 = 数据事故:
//      撤回来的 A 内容会被 autosave 写进 B)。
//
// 变异思路(哪几处改动会红):
//   - 把「切文档」从 setState 改成普通 dispatch ⇒ 例 3 红(B 里 undo 会撤掉 A 的字);
//   - 去掉 addToHistory.of(false) ⇒ 例 2 红;
//   - 断言写反(把「栈归零」写成「栈保留」)⇒ 例 1、例 2 红。
import { describe, expect, it } from 'vitest';
import { EditorState, Transaction } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undoDepth, redoDepth, undo, redo } from '@codemirror/commands';

/** 造一个挂载在 jsdom 里的真 CodeMirror 视图。 */
function mount(doc: string): EditorView {
  const host = document.createElement('div');
  document.body.appendChild(host);
  return new EditorView({
    state: EditorState.create({ doc, extensions: [history()] }),
    parent: host,
  });
}

/** 模拟一次用户击键(带 userEvent,CodeMirror 才会把它记进撤销栈)。 */
function type(view: EditorView, text: string): void {
  view.dispatch({ changes: { from: view.state.doc.length, insert: text }, userEvent: 'input.type' });
}

describe('CodeMirror 6 真实语义:撤销栈', () => {
  it('1. setState(新 state)⇒ 撤销栈归零 + 正文/DOM 换成新文档', () => {
    const view = mount('第一篇');
    type(view, '改过了');
    expect(undoDepth(view.state), '敲字后有 1 层可撤').toBe(1);

    view.setState(EditorState.create({ doc: '第二篇', extensions: [history()] }));

    expect(view.state.doc.toString(), '正文换成新文档').toBe('第二篇');
    expect(undoDepth(view.state), '撤销栈必须归零').toBe(0);
    expect(redoDepth(view.state), '重做栈也必须归零').toBe(0);
    expect(view.dom.textContent, 'DOM 显示的也是新正文').toContain('第二篇');
    expect(view.contentDOM, 'contentDOM 仍在(焦点/光标依赖它)').toBeTruthy();

    view.destroy();
  });

  it('2. 整段替换 + addToHistory:false ⇒ 外部灌入的正文不进撤销栈', () => {
    const view = mount('abc');
    type(view, 'X');
    expect(undoDepth(view.state)).toBe(1);

    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: 'ZZZ' },
      annotations: Transaction.addToHistory.of(false),
    });

    expect(view.state.doc.toString()).toBe('ZZZ');
    expect(undoDepth(view.state), '外部替换后旧事件被 mapping 吃掉 ⇒ 栈空').toBe(0);
    expect(undo(view), '没有可撤的东西时 undo 命令返回 false').toBe(false);

    view.destroy();
  });

  it('3. 跨笔记:在 A 里敲的字,切到 B 之后按撤销撤不回来(数据污染防线)', () => {
    const view = mount('A 的正文');
    type(view, '!!!');
    expect(view.state.doc.toString()).toBe('A 的正文!!!');
    expect(undoDepth(view.state)).toBe(1);

    // 切到笔记 B:重建 state(本轮实现里由 docToken 变化触发)
    view.setState(EditorState.create({ doc: 'B 的正文', extensions: [history()] }));
    expect(view.state.doc.toString()).toBe('B 的正文');

    // 在 B 里按撤销 ⇒ 什么也撤不了,B 的正文一个字都不能少
    expect(undo(view), 'B 里没有可撤的编辑 ⇒ undo 返回 false').toBe(false);
    expect(view.state.doc.toString(), 'B 的正文未被 A 的编辑污染').toBe('B 的正文');

    // B 里的新编辑可以正常撤销(撤销功能本身没被 setState 弄坏)
    type(view, '?');
    expect(undoDepth(view.state)).toBe(1);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('B 的正文');

    view.destroy();
  });

  it('4. undo / redo 命令真实生效(undo 改回正文、redo 再改回来)', () => {
    const view = mount('abc');
    type(view, 'X');

    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('abc');
    expect(redoDepth(view.state), '撤销后有 1 层可重做').toBe(1);

    expect(redo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('abcX');

    view.destroy();
  });
});
