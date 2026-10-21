// tests/unit/renderer/components/standalone-editor-id-drift.test.tsx
//
// 守 r192「保存时 id 漂移」在**编辑器**这一侧的行为契约。
//
// 场景(用户可复现):
//   1. 用户打开一篇笔记,改了标题(标记 dirty);
//   2. 自动保存触发 —— 主进程把 frontmatter id 重钉为路径哈希,返回**新 id**;
//   3. 用户**在保存往返期间**又敲了几个字(新内容还没落盘);
//   4. renderer 拿到新 id,编辑器收到的 note prop 的 id 变了。
//
// 旧行为(两处都丢字):
//   - 编辑器把「id 变了」当成**切到另一篇笔记**:用**已死的旧 id** 去 flush
//     (主进程已删掉旧 byId 键)⇒ 必撞 NOT_FOUND ⇒ 正文只进 failedDrafts
//     (旧 id 键)⇒ 再也读不回来;
//   - flush 之后 setBody(note.body) / setTitle(note.title) 把用户在保存之后
//     新敲的字**直接擦掉**(note.body 是保存那一刻的快照,不含第 3 步的字)。
//
// 本测锁(行为级,只锁用户可见的行为,不锁实现):
//   1. 同一个 relPath、id 变了 ⇒ **不得**再用旧 id 发起保存;
//   2. 本地正文 / 标题**不被**回滚(用户保存后敲的字还在);
//   3. 反面对照:换成**另一篇**笔记(relPath 不同)⇒ 仍然照旧 flush 旧笔记
//     (不能把「切笔记」这条路一起关掉)。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, screen, act, cleanup } from '@testing-library/react';

// i18n:只关心交互,不关心文案 —— key 原样返回
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
//   1) 切笔记 flush 前查「旧笔记还在不在列表里」(mustContain 旧 id,否则
//      走 skip 分支,测不到死 id flush);
//   2) ⌘S 通道读 selectedId(本测不走)。
vi.mock('../../../../src/renderer/src/store/notes', () => {
  const state = {
    notes: [{ id: 'oldid', relPath: 'a.md' }],
    selectedId: 'oldid',
  };
  return {
    useNotesStore: {
      getState: () => state,
    },
  };
});

// MarkdownEditor 是 CodeMirror(jsdom 里不可测)⇒ 换成普通 textarea,
//   行为等价(受控 value + onChange(string))。
vi.mock('../../../../src/renderer/src/components/editor/MarkdownEditor', () => ({
  MarkdownEditor: (props: { value: string; onChange: (v: string) => void }) =>
    (
      <textarea
        data-testid="body-editor"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    ),
}));

import { StandaloneNoteEditorCore } from '../../../../src/renderer/src/components/notes/StandaloneNoteEditorCore';
import type { StandaloneNote } from '../../../../src/shared/types';

const OLD_ID = 'oldid';
const NEW_ID = 'newid';

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

describe('StandaloneNoteEditorCore:id 漂移 ≠ 切笔记(r192)', () => {
  beforeEach(() => {
    cleanup();
    // 假定时器:autosave 防抖(默认 1.5s)不能在测试里自己 fire ——
    //   本测只关心「手动点保存」这一条路径。
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('同一文件换了 id:不得用旧 id 发起保存,且本地标题不被回滚', async () => {
    let resolveSave: (() => void) | undefined;
    const onSave = vi.fn(
      (_id: string, _body: string, _title: string) =>
        new Promise<void>((res) => {
          resolveSave = res;
        }),
    );

    const { rerender } = render(
      <StandaloneNoteEditorCore note={note(OLD_ID, 'a.md', 'B1')} onSave={onSave} titleEditable />,
    );

    const titleInput = screen.getByLabelText('common.noteTitleAria') as HTMLInputElement;
    const bodyInput = screen.getByTestId('body-editor') as HTMLTextAreaElement;

    // 1. 改标题 + 改正文 → dirty
    fireEvent.change(titleInput, { target: { value: 'T2' } });
    fireEvent.change(bodyInput, { target: { value: 'B2' } });
    expect(titleInput.value).toBe('T2');

    // 2. 手动保存(autosave 被假定时器压住)→ onSave 以**旧 id** 发起
    fireEvent.click(screen.getByRole('button', { name: /common\.save/ }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]![0]).toBe(OLD_ID);
    expect(onSave.mock.calls[0]![1]).toBe('B2');

    // 3. 保存往返期间用户又敲了字(这些字**还没落盘**)
    fireEvent.change(titleInput, { target: { value: 'T3' } });
    fireEvent.change(bodyInput, { target: { value: 'B3' } });

    // 4. 保存落地 —— 主进程把 fm.id 重钉后返回新 id
    await act(async () => {
      resolveSave?.();
    });

    // 5. renderer 拿到新 id(store 已重映射)⇒ 编辑器收到的 note 换了 id,
    //    但**同一个文件**(relPath 不变),body/title 是保存那一刻的快照。
    rerender(
      <StandaloneNoteEditorCore
        note={note(NEW_ID, 'a.md', 'B2', 'T2')}
        onSave={onSave}
        titleEditable
      />,
    );

    // 断言 1:不得拿旧 id(已死)再发起一次保存
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(
      onSave.mock.calls.some((call) => call[0] === OLD_ID && call[1] !== 'B2'),
      '漂移后不得用旧 id 发起 flush',
    ).toBe(false);

    // 断言 2:用户保存后敲的字不能被回滚
    expect((screen.getByLabelText('common.noteTitleAria') as HTMLInputElement).value).toBe('T3');
    expect((screen.getByTestId('body-editor') as HTMLTextAreaElement).value).toBe('B3');
  });

  it('反面对照:真的换到另一篇笔记(relPath 不同)⇒ 仍然照旧把旧笔记 flush 掉', async () => {
    const onSave = vi.fn((_id: string, _body: string, _title: string) => Promise.resolve());

    const { rerender } = render(
      <StandaloneNoteEditorCore note={note(OLD_ID, 'a.md', 'B1')} onSave={onSave} titleEditable />,
    );

    const titleInput = screen.getByLabelText('common.noteTitleAria') as HTMLInputElement;
    fireEvent.change(titleInput, { target: { value: 'T2' } });

    // 切到**另一篇**笔记 —— 旧笔记必须被 flush(否则这段字就丢了)
    rerender(
      <StandaloneNoteEditorCore note={note('other', 'b.md', 'X1')} onSave={onSave} titleEditable />,
    );

    const flushCalls = onSave.mock.calls.filter((call) => call[0] === OLD_ID);
    expect(flushCalls.length, '切到另一篇笔记时,旧笔记必须照旧 flush').toBe(1);
    expect(flushCalls[0]![2]).toBe('T2');
  });
});
