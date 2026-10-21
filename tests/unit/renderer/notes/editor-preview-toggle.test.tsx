// tests/unit/renderer/notes/editor-preview-toggle.test.tsx
//
// 守 audit-r133「原始文本 ↔ 渲染显示」双模式切换的**用户可见**行为契约
// (src/renderer/src/components/notes/StandaloneNoteEditorCore.tsx 头注
//  指向本文件,原先标 🔒(守卫缺失))。
//
// 背景:2026-09-06 的 Typora 原地渲染(装饰层自动隐藏非活动行标记)被用户报障
// 「显示存在很大问题」(符号忽隐忽现 / 内容跳动 / 表格任务列表装饰缺失)⇒
// 装饰层整体删除,改成「默认原始文本 + 头栏按钮切到只读渲染视图」。
//
// 本测锁的契约(全部从用户可见结果出发):
//   1. 默认是**原始文本**编辑器,不是渲染视图;
//   2. 头栏 toggle 按一次 → 只读渲染视图(markdown-it 真渲染);再按 → 回原始文本;
//   3. **切换往返不丢内容**:body 由 Core 持有,不经过编辑器实例 ⇒ 往返后
//      正文一字不差,「未保存」状态也还在;
//   4. 预览显示的是 Core 持有的**最新** body,不是 note.body 快照;
//   5. 新建 / 拖入笔记(initialFocus='body')时,即便上一轮停在渲染视图,
//      也要切回原始文本 —— 否则用户没有地方打字。
//
// 退化后的用户可见后果:
//   - 3 退化 ⇒ 用户切一次视图,刚写的一段字消失(丢字级别);
//   - 4 退化 ⇒ 预览显示旧正文,用户以为改动没生效;
//   - 5 退化 ⇒ 新建笔记后光标无处落,只能再手动点一次 toggle。
//
// 变异思路(哪几处改动会红):
//   - previewOn 初值改 true / toggle 语义反转 ⇒ 例 1、2 红;
//   - <MarkdownReader source={body}> 改成 source={note?.body} ⇒ 例 4 红;
//   - toggle 时 setBody('') 或每次重挂编辑器实例 ⇒ 例 3 红;
//   - 删掉 initialFocus effect 里的 setPreviewOn(false) ⇒ 例 5 红。
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, fireEvent, screen, cleanup, waitFor } from '@testing-library/react';

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

/**
 * 渲染视图**真的渲染完了** —— Suspense + lazy import + markdown-it 动态加载
 * 都是异步的。注意:article 元素在 markdown-it 到位**之前**就已经挂载
 * (此时正文区是空的),所以不能只等 article 存在,必须等到 markdown 渲染出的
 * 标题元素出现(:not(.sr-only) 排除 reader 给 SR 用的那个隐藏 h1)。
 */
async function waitForPreview() {
  await waitFor(
    () => expect(document.querySelector('article h1:not(.sr-only)')).not.toBeNull(),
    { timeout: 3000 },
  );
}

function editorValue(): string {
  return (screen.getByTestId('body-editor') as HTMLTextAreaElement).value;
}

afterEach(() => {
  cleanup();
});

describe('StandaloneNoteEditorCore:原始文本 ↔ 渲染显示 双模式(audit-r133)', () => {
  it('1. 默认是原始文本编辑器,不是渲染视图', () => {
    render(<StandaloneNoteEditorCore note={note('n1', 'a.md', BODY)} onSave={async () => {}} titleEditable />);

    // 源码编辑器在场
    expect(screen.getByTestId('body-editor')).toBeTruthy();
    expect(editorValue()).toBe(BODY);
    // 渲染视图不在场(它是 lazy 的,默认根本不加载)
    expect(document.querySelector('article')).toBeNull();
    // toggle 按钮此刻的语义是「切到渲染显示」
    expect(screen.getByTestId('note-mode-toggle').getAttribute('aria-label')).toBe(
      'notes.modePreviewAria',
    );
  });

  it('2. 按 toggle 切到只读渲染视图,再按一次切回原始文本', async () => {
    render(<StandaloneNoteEditorCore note={note('n1', 'a.md', BODY)} onSave={async () => {}} titleEditable />);
    const toggle = screen.getByTestId('note-mode-toggle');

    fireEvent.click(toggle);
    await waitForPreview();

    // 渲染视图在场:markdown 被真渲染成 h1
    expect(document.querySelector('article h1:not(.sr-only)')!.textContent).toBe('标题');
    // 原始文本编辑器不在场(两模式互斥,不是分屏)
    expect(screen.queryByTestId('body-editor')).toBeNull();
    // 按钮语义反转
    expect(screen.getByTestId('note-mode-toggle').getAttribute('aria-label')).toBe(
      'notes.modeSourceAria',
    );

    fireEvent.click(screen.getByTestId('note-mode-toggle'));
    expect(screen.getByTestId('body-editor')).toBeTruthy();
    expect(document.querySelector('article')).toBeNull();
  });

  it('3. 切换往返不丢内容:正文一字不差', async () => {
    render(<StandaloneNoteEditorCore note={note('n1', 'a.md', BODY)} onSave={async () => {}} titleEditable />);

    fireEvent.click(screen.getByTestId('note-mode-toggle'));
    await waitForPreview();
    fireEvent.click(screen.getByTestId('note-mode-toggle'));

    expect(editorValue()).toBe(BODY);
  });

  it('4. 预览显示的是编辑后的最新正文,不是 note.body 快照', async () => {
    render(<StandaloneNoteEditorCore note={note('n1', 'a.md', BODY)} onSave={async () => {}} titleEditable />);

    // 改一段正文
    fireEvent.change(screen.getByTestId('body-editor'), {
      target: { value: '# 标题\n\n改过的正文' },
    });

    fireEvent.click(screen.getByTestId('note-mode-toggle'));
    await waitForPreview();

    expect(document.querySelector('article')!.textContent).toContain('改过的正文');
    expect(document.querySelector('article')!.textContent).not.toContain('正文内容');
  });

  it('5. 切换往返不改变保存状态:未保存标记仍在', async () => {
    render(<StandaloneNoteEditorCore note={note('n1', 'a.md', BODY)} onSave={async () => {}} titleEditable />);

    // 初始:已保存(进入笔记时 Core 标 'saved')
    expect(screen.getByRole('status').textContent).toContain('notes.saveIdle');

    // 改一个字 ⇒ 未保存
    fireEvent.change(screen.getByTestId('body-editor'), { target: { value: 'X' } });
    expect(screen.getByRole('status').textContent).toContain('notes.saveDirty');

    // 来回切一次视图 ⇒ 仍然是未保存(切换本身不该落盘,也不该谎报已保存)。
    // 刻意**不** await 预览挂载:autosave 防抖 1500ms 一旦 fire,指示器会
    // 正常地翻成「已保存」,那不是本例要断言的东西(保存语义另有守卫)。
    fireEvent.click(screen.getByTestId('note-mode-toggle'));
    fireEvent.click(screen.getByTestId('note-mode-toggle'));

    expect(screen.getByRole('status').textContent).toContain('notes.saveDirty');
  });

  it('6. 换笔记且要求聚焦正文时,即便停在渲染视图也切回原始文本', async () => {
    const { rerender } = render(
      <StandaloneNoteEditorCore
        note={note('n1', 'a.md', BODY)}
        onSave={async () => {}}
        titleEditable
      />,
    );

    // 用户停在渲染视图
    fireEvent.click(screen.getByTestId('note-mode-toggle'));
    await waitForPreview();
    expect(document.querySelector('article')).not.toBeNull();

    // 父组件新建 / 拖入后要求光标落正文
    rerender(
      <StandaloneNoteEditorCore
        note={note('n2', 'b.md', '新笔记正文')}
        onSave={async () => {}}
        titleEditable
        initialFocus="body"
      />,
    );

    // 必须回到原始文本 —— 否则用户没有地方打字
    expect(screen.getByTestId('body-editor')).toBeTruthy();
    expect(document.querySelector('article')).toBeNull();
    expect(editorValue()).toBe('新笔记正文');
  });
});
