// tests/unit/renderer/components/standalone-editor-note-moved.test.tsx
//
// 守 audit 2026-10-21(P0 数据丢失):「笔记被搬走 / 改名」时,编辑器里**未落盘**
//   的内容必须落到**新 id** 上,而不是主进程已经删掉的旧 id。
//
// 旧行为(两条路都丢字,且**永久**丢):
//   1. 主进程的笔记 id = relPath 的哈希(standalone.ts repin 规则)⇒ 搬移/改名
//      后同一个文件换了 id,旧 id 在 byId 里被 delete ⇒ 成了**死键**;
//   2. 编辑器判「id 变了 = 换了另一篇笔记」用的是 relPath(r192 的漂移判据)
//      ⇒ 搬移/改名**必然**改 relPath ⇒ 必然被判成「用户切了笔记」;
//   3. 于是按**旧 id** flush ⇒ 主进程 NOT_FOUND ⇒ 内容只进 failedDrafts
//      (**旧 id 键**)⇒ 而笔记现在的新 id 取不到那份草稿 ⇒ 这段字永久消失。
//
// 本测锁(行为级,只锁用户可见的行为):
//   M1. 搬移:flush 必须打到**新 id**;本地正文不得被搬移前的快照回滚。
//   M2. 改名(full 为 null ⇒ 编辑器整条链卸载):flush 同样打到**新 id**。
//   M3. 对照:真的切到**另一篇**笔记(没有重映射)⇒ 仍然照旧 flush 旧 id。
//   M4. store 层:搬移后 notes[] 里不得留着死 id(否则右侧渲染「笔记已不可用」,
//      而且编辑器被卸载 ⇒ 未落盘内容只能走卸载 flush)。
//   M5. store 层:搬移后的保存不得带 expectedMtime —— 主进程 repin 重写了文件,
//      磁盘 mtime 必然变,带搬移前的旧 mtime 必报**假 CONFLICT**(「文件被外部
//      修改」,其实是我们自己搬的)。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, screen, act, cleanup } from '@testing-library/react';

// i18n:只关心交互,不关心文案 —— key 原样返回
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

// workspace store:编辑器只用到 pendingSaveActiveNote.version(⌘S 通道)
//   + consumeSaveActiveNoteRequest();本测不走 ⌘S,后者恒 false。
//   注意:编辑器是**当 hook 用**的(useWorkspaceStore(selector))⇒ mock 必须是
//   可调用的,不能只给 getState。
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

// toast:store 的 CONFLICT 分支会弹 toast,本测不让它真的弹。
vi.mock('../../../../src/renderer/src/lib/toast', () => ({
  useToast: { getState: () => ({ show: vi.fn() }) },
}));

// MarkdownEditor 是 CodeMirror(jsdom 里不可测)⇒ 换成普通 textarea,
//   行为等价(受控 value + onChange(string))。
vi.mock('../../../../src/renderer/src/components/editor/MarkdownEditor', () => ({
  MarkdownEditor: (props: { value: string; onChange: (v: string) => void }) => (
    <textarea
      data-testid="body-editor"
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
    />
  ),
}));

import { useNotesStore } from '../../../../src/renderer/src/store/notes';
import { resetNoteIdRemap } from '../../../../src/renderer/src/lib/note-id-remap';
import { StandaloneNoteEditorCore } from '../../../../src/renderer/src/components/notes/StandaloneNoteEditorCore';
import type { StandaloneNote } from '../../../../src/shared/types';

const OLD_ID = 'old-note';
const NEW_ID = 'new-note';

interface MockApi {
  writeNote: ReturnType<typeof vi.fn>;
  readNote: ReturnType<typeof vi.fn>;
  listNotes: ReturnType<typeof vi.fn>;
  renameNoteFile: ReturnType<typeof vi.fn>;
  onNotesChanged: ReturnType<typeof vi.fn>;
}

function note(id: string, relPath: string, body: string, title = 'T1', mtime = 111): StandaloneNote {
  return {
    id,
    relPath,
    filename: relPath.split('/').pop() ?? relPath,
    title,
    tags: null,
    mtime,
    body,
  };
}

let api: MockApi;

function setupApi(): void {
  api = {
    writeNote: vi.fn((id: string, body: string, title: string) =>
      Promise.resolve({ ok: true, data: note(id, 'a.md', body, title, 222) }),
    ),
    readNote: vi.fn(),
    listNotes: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    renameNoteFile: vi.fn(),
    onNotesChanged: vi.fn().mockReturnValue(() => {}),
  };
  (window as unknown as { api: MockApi }).api = api;
}

function seedStore(n: StandaloneNote): void {
  useNotesStore.setState({
    notes: [
      {
        id: n.id,
        relPath: n.relPath,
        filename: n.filename,
        title: n.title,
        tags: n.tags,
        mtime: n.mtime,
      },
    ],
    selectedId: n.id,
    selectedIds: new Set<string>([n.id]),
    anchorId: n.id,
    activeNoteFull: n,
    loadingFull: false,
    clipboard: null,
    lastError: null,
    displayOrderById: {},
  });
}

describe('笔记被搬走/改名:未落盘内容必须落到新 id(audit 2026-10-21 P0)', () => {
  beforeEach(() => {
    cleanup();
    // 登记表是模块级的 ⇒ 每个用例重来,别让上一个用例的映射串进来。
    resetNoteIdRemap();
    setupApi();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.clearAllMocks();
  });

  it('M1. 搬移:未落盘内容必须按新 id 落盘,且本地正文不被搬移前的快照回滚', () => {
    const target = note(OLD_ID, 'a.md', 'B0');
    seedStore(target);

    const onSave = (id: string, body: string, title: string): Promise<void> =>
      useNotesStore.getState().save(id, body, title).then(() => undefined);

    const { rerender } = render(
      <StandaloneNoteEditorCore note={target} onSave={onSave} titleEditable />,
    );

    // 用户在搬移前敲了字(还没落盘)
    fireEvent.change(screen.getByTestId('body-editor'), { target: { value: 'B1' } });

    // 搬移:主进程 fs.rename + repin ⇒ id 变了;store 收到 idRemap
    act(() => {
      useNotesStore.getState().applyMoveRemap(
        new Map([[OLD_ID, { id: NEW_ID, relPath: 'sub/a.md' }]]),
      );
    });

    // 父组件按新 store 状态重渲(真实路径:selectedId / activeNoteFull 都换了)
    const st = useNotesStore.getState();
    expect(st.activeNoteFull?.id, 'store 必须把 activeNoteFull 换到新 id').toBe(NEW_ID);
    rerender(
      <StandaloneNoteEditorCore note={st.activeNoteFull!} onSave={onSave} titleEditable />,
    );

    // 断言 1:flush 必须打到**新 id**(旧 id 已是主进程死键)
    const calls = api.writeNote.mock.calls;
    expect(calls.length, '搬移后必须补落盘一次').toBeGreaterThan(0);
    expect(
      calls.every((c) => c[0] !== OLD_ID),
      '绝不能按旧 id 写 —— 那是主进程的死键(必撞 NOT_FOUND ⇒ 永久丢字)',
    ).toBe(true);
    expect(calls[0]![0], '必须按新 id 写').toBe(NEW_ID);
    expect(calls[0]![1], '必须带上用户刚敲的正文').toBe('B1');

    // 断言 2:本地正文不得被「搬移前」的 note.body 回滚(否则用户刚敲的字消失)
    expect((screen.getByTestId('body-editor') as HTMLTextAreaElement).value).toBe('B1');
  });

  it('M2. 改名(full 清空 ⇒ 编辑器卸载):未落盘内容同样必须按新 id 落盘', async () => {
    const target = note(OLD_ID, 'a.md', 'B0');
    seedStore(target);

    const renamed = note(NEW_ID, 'renamed.md', 'B0');
    api.renameNoteFile.mockResolvedValue({ ok: true, data: renamed });
    api.listNotes.mockResolvedValue({
      ok: true,
      data: [
        {
          id: NEW_ID,
          relPath: 'renamed.md',
          filename: 'renamed.md',
          title: renamed.title,
          tags: null,
          mtime: 222,
        },
      ],
    });

    const onSave = (id: string, body: string, title: string): Promise<void> =>
      useNotesStore.getState().save(id, body, title).then(() => undefined);

    const { rerender } = render(
      <StandaloneNoteEditorCore note={target} onSave={onSave} titleEditable />,
    );

    fireEvent.change(screen.getByTestId('body-editor'), { target: { value: 'B1' } });

    // 改名:主进程 repin frontmatter id ⇒ 旧 id 成死键
    await act(async () => {
      await useNotesStore.getState().renameFile(OLD_ID, 'renamed.md');
    });

    // 真实路径:activeNoteFull 被清空 ⇒ NotesView 渲染 Skeleton ⇒ 编辑器卸载
    rerender(<div />);

    const calls = api.writeNote.mock.calls;
    expect(calls.length, '改名后必须补落盘一次').toBeGreaterThan(0);
    expect(calls[0]![0], '必须按新 id 写').toBe(NEW_ID);
    expect(calls[0]![1], '必须带上用户刚敲的正文').toBe('B1');
  });

  it('M3. 对照:真的切到另一篇笔记(无重映射)⇒ 仍然照旧 flush 旧 id', () => {
    const target = note(OLD_ID, 'a.md', 'B0');
    seedStore(target);

    const onSave = (id: string, body: string, title: string): Promise<void> =>
      useNotesStore.getState().save(id, body, title).then(() => undefined);

    const { rerender } = render(
      <StandaloneNoteEditorCore note={target} onSave={onSave} titleEditable />,
    );

    fireEvent.change(screen.getByTestId('body-editor'), { target: { value: 'B1' } });

    // 切到**另一篇**笔记(没有重映射登记)
    rerender(
      <StandaloneNoteEditorCore note={note('other', 'c.md', 'X0')} onSave={onSave} titleEditable />,
    );

    const calls = api.writeNote.mock.calls;
    expect(calls.length, '切笔记时旧笔记必须被 flush').toBeGreaterThan(0);
    expect(calls[0]![0], '切笔记 ⇒ 照旧写回旧 id(旧笔记还活着)').toBe(OLD_ID);
    expect(calls[0]![1]).toBe('B1');
  });

  it('M4. 搬移后 notes[] 里不得留着死 id(否则右侧渲染「笔记已不可用」)', () => {
    const target = note(OLD_ID, 'a.md', 'B0');
    seedStore(target);

    act(() => {
      useNotesStore.getState().applyMoveRemap(
        new Map([[OLD_ID, { id: NEW_ID, relPath: 'sub/a.md' }]]),
      );
    });

    const st = useNotesStore.getState();
    expect(
      st.notes.some((n) => n.id === OLD_ID),
      '列表里不得留着死 id(点它必然 NOT_FOUND)',
    ).toBe(false);
    const moved = st.notes.find((n) => n.id === NEW_ID);
    expect(moved, '列表里必须有新 id 那一行').toBeTruthy();
    expect(moved?.relPath, '新行的 relPath 必须跟着搬').toBe('sub/a.md');
  });

  it('M5. 搬移后的保存不得带 expectedMtime(否则必报假 CONFLICT)', async () => {
    const target = note(OLD_ID, 'a.md', 'B0', 'T1', 111);
    seedStore(target);

    act(() => {
      useNotesStore.getState().applyMoveRemap(
        new Map([[OLD_ID, { id: NEW_ID, relPath: 'sub/a.md' }]]),
      );
    });

    await act(async () => {
      await useNotesStore.getState().save(NEW_ID, 'B1', 'T1');
    });

    const call = api.writeNote.mock.calls.at(-1)!;
    expect(call[0]).toBe(NEW_ID);
    expect(
      call[3],
      '搬移后磁盘 mtime 必然变(repin 重写了文件)⇒ 不得再拿旧 mtime 比对',
    ).toBeUndefined();
  });
});
