// tests/unit/renderer/notes/note-undo-redo.test.tsx
//
// 守「笔记编辑有撤销 / 重做按钮」这条**用户可见**契约
// (src/renderer/src/components/notes/StandaloneNoteEditorCore.tsx 头栏)。
//
// 背景:编辑器是 CodeMirror 6(history 扩展 + historyKeymap ⇒ ⌘Z/⌘Y 早就能用),
// 但**没有按钮** —— 键盘用户能用,鼠标用户完全不知道有这回事;而且
// 「能不能撤」这件事用户看不到(不知道当前这篇还能不能撤)。
//
// 本测锁的契约(从用户可见结果出发):
//   1. 头栏有「撤销 / 重做」两个按钮,带可访问名(屏幕阅读器用户能找到);
//   2. 初始(还没编辑过)两个按钮**禁用** —— 没有可撤的东西就别摆个能点的
//      按钮(点了没反应比没有更误导);
//   3. 编辑器上报「能撤 / 能重做」后,按钮相应启用;
//   4. 点按钮 ⇒ 真的调到编辑器的撤销 / 重做命令(不是摆设);
//   5. 换笔记 ⇒ 按钮回到禁用态(新文档没有可撤的编辑)且文档 token 递增
//      (编辑器据此清空上一篇的撤销栈 —— 见 markdown-editor-history.test.tsx);
//   6. 「渲染显示」模式下按钮禁用(那儿没有可撤的编辑:编辑器根本没挂载)。
//
// 变异思路(哪几处改动会红):
//   - 删掉两个按钮 ⇒ 例 1、3、4 红;
//   - disabled 恒 false(不管 canUndo/canRedo)⇒ 例 2、5 红;
//   - onClick 不调 editorApi ⇒ 例 4 红;
//   - 换笔记时不重置 canUndo/canRedo、不递增 docToken ⇒ 例 5 红。
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, fireEvent, screen, cleanup, waitFor, act } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

// workspace store:编辑器只用到 pendingSaveActiveNote.version(⌘S 通道)
//   + consumeSaveActiveNoteRequest();本测不走 ⌘S,后者恒 false。
vi.mock('../../../../src/renderer/src/store/workspace', () => {
  const state = {
    pendingSaveActiveNote: { version: 0 },
    consumeSaveActiveNoteRequest: () => false,
  };
  const useWorkspaceStore = ((selector?: (s: unknown) => unknown) =>
    selector ? selector(state) : state) as unknown as {
    (selector?: (s: unknown) => unknown): unknown;
    getState: () => unknown;
  };
  useWorkspaceStore.getState = () => state;
  return { useWorkspaceStore };
});

// notes store:编辑器只在两处读它 ——
//   1) 切笔记 flush 前查「旧笔记还在不在列表里」;
//   2) ⌘S 通道读 selectedId(本测不走)。
vi.mock('../../../../src/renderer/src/store/notes', () => {
  const state = {
    notes: [{ id: 'n1', relPath: 'a.md' }],
    selectedId: 'n1',
  };
  return {
    useNotesStore: {
      getState: () => state,
    },
  };
});

// MarkdownEditor 是 CodeMirror(jsdom 里不可测)⇒ 换成普通 textarea,
//   并把「命令式句柄」按真实实现的契约挂上去(真实实现在 effect 里挂,
//   这里在 render 里挂 —— 测试只需要父级能拿到它)。
const editorMock = vi.hoisted(() => ({
  undo: vi.fn(),
  redo: vi.fn(),
  props: null as null | {
    value: string;
    onChange: (v: string) => void;
    docToken?: number;
    onHistoryChange?: (f: { canUndo: boolean; canRedo: boolean }) => void;
    apiRef?: { current: unknown };
  },
  reset() {
    editorMock.undo.mockClear();
    editorMock.redo.mockClear();
    editorMock.props = null;
  },
}));

vi.mock('../../../../src/renderer/src/components/editor/MarkdownEditor', () => ({
  MarkdownEditor: (props: {
    value: string;
    onChange: (v: string) => void;
    docToken?: number;
    onHistoryChange?: (f: { canUndo: boolean; canRedo: boolean }) => void;
    apiRef?: { current: unknown };
  }) => {
    editorMock.props = props;
    if (props.apiRef) {
      props.apiRef.current = {
        undo: editorMock.undo,
        redo: editorMock.redo,
        canUndo: () => false,
        canRedo: () => false,
      };
    }
    return (
      <textarea
        data-testid="body-editor"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    );
  },
}));

import { StandaloneNoteEditorCore } from '../../../../src/renderer/src/components/notes/StandaloneNoteEditorCore';
import type { StandaloneNote } from '../../../../src/shared/types';

const BODY = '# 标题\n\n正文内容';

function note(id: string, relPath: string, body: string, title = 'T1'): StandaloneNote {
  return {
    id,
    relPath,
    filename: relPath.split('/').pop() ?? relPath,
    title,
    tags: null,
    mtime: 1,
    body,
  };
}

function undoBtn(): HTMLButtonElement {
  return screen.getByTestId('note-undo') as HTMLButtonElement;
}
function redoBtn(): HTMLButtonElement {
  return screen.getByTestId('note-redo') as HTMLButtonElement;
}

/** 编辑器上报能力位(真实实现里由 CodeMirror 的 history 栈深驱动)。 */
function reportHistory(canUndo: boolean, canRedo: boolean): void {
  act(() => {
    editorMock.props?.onHistoryChange?.({ canUndo, canRedo });
  });
}

afterEach(() => {
  cleanup();
  editorMock.reset();
});

describe('StandaloneNoteEditorCore:撤销 / 重做按钮', () => {
  it('1. 头栏有「撤销 / 重做」按钮,且带可访问名', () => {
    render(<StandaloneNoteEditorCore note={note('n1', 'a.md', BODY)} onSave={async () => {}} titleEditable />);

    expect(undoBtn()).toBeTruthy();
    expect(redoBtn()).toBeTruthy();
    // 可访问名 = i18n key(测试里 t() 返回 key 本身)
    expect(undoBtn().getAttribute('aria-label')).toBe('notes.undo');
    expect(redoBtn().getAttribute('aria-label')).toBe('notes.redo');
  });

  it('2. 初始没有可撤的编辑 ⇒ 两个按钮都禁用', () => {
    render(<StandaloneNoteEditorCore note={note('n1', 'a.md', BODY)} onSave={async () => {}} titleEditable />);

    expect(undoBtn().disabled, '还没编辑过就不该有一个能点的「撤销」').toBe(true);
    expect(redoBtn().disabled).toBe(true);
  });

  it('3. 编辑器上报能力位后 ⇒ 按钮相应启用', () => {
    render(<StandaloneNoteEditorCore note={note('n1', 'a.md', BODY)} onSave={async () => {}} titleEditable />);

    reportHistory(true, false);
    expect(undoBtn().disabled, '能撤了就必须能点').toBe(false);
    expect(redoBtn().disabled, '还没重做过就不该能点').toBe(true);

    reportHistory(true, true);
    expect(redoBtn().disabled).toBe(false);
  });

  it('4. 点按钮 ⇒ 真的调到编辑器的撤销 / 重做命令', () => {
    render(<StandaloneNoteEditorCore note={note('n1', 'a.md', BODY)} onSave={async () => {}} titleEditable />);

    reportHistory(true, true);
    fireEvent.click(undoBtn());
    expect(editorMock.undo).toHaveBeenCalledTimes(1);
    expect(editorMock.redo).not.toHaveBeenCalled();

    fireEvent.click(redoBtn());
    expect(editorMock.redo).toHaveBeenCalledTimes(1);
  });

  it('5. 换笔记 ⇒ 按钮回到禁用态 + 文档 token 递增(撤销栈归零)', async () => {
    const { rerender } = render(
      <StandaloneNoteEditorCore note={note('n1', 'a.md', BODY)} onSave={async () => {}} titleEditable />,
    );

    reportHistory(true, true);
    expect(undoBtn().disabled).toBe(false);
    const tokenBefore = editorMock.props?.docToken;

    rerender(
      <StandaloneNoteEditorCore
        note={note('n2', 'b.md', '第二篇')}
        onSave={async () => {}}
        titleEditable
      />,
    );

    await waitFor(() => expect(undoBtn().disabled).toBe(true));
    expect(redoBtn().disabled, '新文档没有可重做的编辑').toBe(true);
    expect(
      editorMock.props?.docToken,
      '换文档必须递增 token —— 编辑器据此清空上一篇的撤销栈',
    ).toBeGreaterThan(tokenBefore ?? -1);
  });

  it('6. 「渲染显示」模式下按钮禁用(编辑器没挂载,没有可撤的编辑)', () => {
    render(<StandaloneNoteEditorCore note={note('n1', 'a.md', BODY)} onSave={async () => {}} titleEditable />);

    reportHistory(true, true);
    expect(undoBtn().disabled).toBe(false);

    fireEvent.click(screen.getByTestId('note-mode-toggle'));

    expect(undoBtn().disabled, '渲染视图只读,没有可撤的编辑').toBe(true);
    expect(redoBtn().disabled).toBe(true);
  });
});
