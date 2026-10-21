// tests/unit/renderer/components/search/SearchPanel.test.tsx
//
// 守 audit-r33「搜索面板键盘交互」契约
// (src/renderer/src/components/search/SearchPanel.tsx 头注指向本文件,
//  原先标 🔒(守卫缺失);r33 修订后的单一 handler 版本)。
//
// r32 的 split-callback 设计(<input> 上的 handler 把焦点挪到
// <div role="listbox">,再由 listbox 上的另一份 handler 接管)看似遵循
// a11y 模式,实际违反 WAI-ARIA combobox 规范,并造成**用户可见**故障:
//
//   用户打完 "react" 按 ↓(焦点被挪到 listbox)→ 再打 "hooks"
//   ⇒ 字符进不了 input(div 不接受文字输入)⇒ 关键词停在 "react",
//      用户以为自己搜的是 "reacthooks",实际搜的是 "react"。
//
// 本测锁的契约(全部用户可见):
//   1. 焦点**全程**留在 input:ArrowDown / ArrowUp / Enter 之后
//      document.activeElement 仍是 input;
//   2. 虚拟选中项由 input 的 aria-activedescendant 跟踪,
//      对应行 aria-selected="true";
//   3. ArrowDown / ArrowUp 到边界不越界(不悬空、不绕回);
//   4. Enter 打开**当前 active** 的命中项:
//      笔记 → 选中笔记 + 切到 notes 面板 + 请求聚焦该笔记;
//      文献 → 选中该文献(id 走 litResourceId)+ 切到 library 面板;
//      两种情况都关闭搜索面板;
//   5. IME 组字过程中按 Enter / 方向键**不**当成"打开命中项"
//      (否则误导航 + 误关面板,关键词还停在 stale 状态);
//   6. combobox 语义:input role=combobox + aria-controls 指向真实存在的
//      listbox + aria-expanded 随有无结果变化。
//
// 退化后的用户可见后果:
//   - 1 退化 ⇒ 打完词按一下 ↓ 就再也打不出字了(搜索面板不可用);
//   - 4 退化 ⇒ 回车打开的是第一行而不是用户选中的那一行(跳错文件);
//   - 5 退化 ⇒ 中文输入法选词(回车上屏)会直接跳走并关掉面板。
//
// 变异思路(哪几处改动会红):
//   - 在 input 的 keydown 里加 listboxRef.current?.focus() ⇒ 例 1 红;
//   - 把 aria-activedescendant 从 input 挪走 / 删掉 ⇒ 例 2、3 红;
//   - Enter 用 flatHits[0] 而不是 flatHits[activeIdx] ⇒ 例 4 红;
//   - 删掉 e.nativeEvent.isComposing 守卫 ⇒ 例 5 红;
//   - listbox 去掉 id / input 去掉 aria-controls ⇒ 例 6 红。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, screen, cleanup, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock('i18next', () => ({
  t: (k: string, opts?: { count?: number }) =>
    opts && typeof opts.count === 'number' ? `${k}:${opts.count}` : k,
}));

const notesSelect = vi.fn();
const literatureSelect = vi.fn();
const setActive = vi.fn();
const requestFocusNote = vi.fn();

vi.mock('../../../../../src/renderer/src/store/notes', () => ({
  useNotesStore: { getState: () => ({ select: notesSelect }) },
}));
vi.mock('../../../../../src/renderer/src/store/literature', () => ({
  useLiteratureStore: { getState: () => ({ select: literatureSelect }) },
}));
vi.mock('../../../../../src/renderer/src/store/workspace', () => ({
  useWorkspaceStore: {
    getState: () => ({ setActive, requestFocusNote }),
  },
}));

import { SearchPanel } from '../../../../../src/renderer/src/components/search/SearchPanel';
import type { SearchHit } from '../../../../../src/shared/types';

const NOTE_HIT: SearchHit = {
  kind: 'note',
  id: 'note-1',
  relPath: 'a.md',
  title: '深度学习综述',
  snippet: '片段',
  score: 1,
};
const FILE_HIT: SearchHit = {
  kind: 'file',
  id: 'file-1',
  relPath: 'b.pdf',
  title: '某论文',
  snippet: '片段',
  score: 1,
};
const NOTE2_HIT: SearchHit = {
  kind: 'note',
  id: 'note-2',
  relPath: 'c.md',
  title: '另一篇笔记',
  snippet: '片段',
  score: 1,
};

function optionEls(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
}

/** 输入查询词 → 300ms debounce → IPC → 结果渲染完。 */
async function openWith(hits: SearchHit[], onClose = vi.fn()) {
  (window as unknown as { api: unknown }).api = {
    search: vi.fn().mockResolvedValue({ ok: true, data: hits }),
  };
  render(<SearchPanel open onClose={onClose} />);
  const input = screen.getByLabelText('search.inputAria') as HTMLInputElement;
  fireEvent.change(input, { target: { value: '关键词' } });
  await waitFor(() => expect(optionEls().length).toBeGreaterThan(0), { timeout: 3000 });
  return { input, onClose };
}

describe('SearchPanel:键盘交互(audit-r33 单一 handler 契约)', () => {
  beforeEach(() => {
    notesSelect.mockClear();
    literatureSelect.mockClear();
    setActive.mockClear();
    requestFocusNote.mockClear();
  });
  afterEach(() => {
    cleanup();
  });

  it('1. 焦点全程留在 input(方向键 / 回车之后都不挪走)', async () => {
    const { input } = await openWith([NOTE_HIT, FILE_HIT]);
    input.focus();

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(document.activeElement, 'ArrowDown 后焦点必须还在 input').toBe(input);

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(document.activeElement, 'ArrowUp 后焦点必须还在 input').toBe(input);

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(document.activeElement, 'Enter 后焦点必须还在 input').toBe(input);
  });

  it('2. 虚拟选中项由 aria-activedescendant 跟踪,对应行 aria-selected=true', async () => {
    const { input } = await openWith([NOTE_HIT, FILE_HIT]);

    expect(input.getAttribute('role')).toBe('combobox');
    // 初始 activeIdx = 0 ⇒ 第一行
    expect(input.getAttribute('aria-activedescendant')).toBe('search-hit-note-1');
    expect(optionEls()[0]!.getAttribute('aria-selected')).toBe('true');
    expect(optionEls()[1]!.getAttribute('aria-selected')).toBe('false');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe('search-hit-file-1');
    expect(optionEls()[1]!.getAttribute('aria-selected')).toBe('true');
    expect(optionEls()[0]!.getAttribute('aria-selected')).toBe('false');
  });

  it('3. 方向键到边界不越界(不悬空、不绕回)', async () => {
    const { input } = await openWith([NOTE_HIT, FILE_HIT]);

    // 已在第一行,再按 ArrowUp ⇒ 仍是第一行
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input.getAttribute('aria-activedescendant')).toBe('search-hit-note-1');

    // 已在最后一行,再按 ArrowDown ⇒ 仍是最后一行
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe('search-hit-file-1');
    expect(document.getElementById('search-hit-file-1')).not.toBeNull();
  });

  it('4a. Enter 打开当前 active 的**笔记**命中:选中 + 切面板 + 请求聚焦 + 关面板', async () => {
    // 刻意让 active 落在**第二条**(不是第一条)—— 抓「回车总是打开第一行」的回归
    const { input, onClose } = await openWith([NOTE_HIT, NOTE2_HIT, FILE_HIT]);

    fireEvent.keyDown(input, { key: 'ArrowDown' }); // active = 第二行(另一篇笔记)
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(notesSelect).toHaveBeenCalledWith(NOTE2_HIT.id);
    expect(notesSelect).not.toHaveBeenCalledWith(NOTE_HIT.id);
    expect(requestFocusNote).toHaveBeenCalledWith(NOTE2_HIT.id);
    expect(setActive).toHaveBeenCalledWith('notes');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('4b. Enter 打开当前 active 的**文献**命中:按 litResourceId 选中 + 切到 library', async () => {
    const { input, onClose } = await openWith([NOTE_HIT, NOTE2_HIT, FILE_HIT]);

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' }); // active = 第三行(file)
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(literatureSelect).toHaveBeenCalledWith('lit:file-1');
    expect(setActive).toHaveBeenCalledWith('library');
    expect(notesSelect).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('5. IME 组字中按 Enter / 方向键不当作打开命中项(不跳走、不关面板)', async () => {
    const { input, onClose } = await openWith([NOTE_HIT, FILE_HIT]);

    // isComposing = true:用户正在用输入法上屏选词
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(notesSelect).not.toHaveBeenCalled();
    expect(literatureSelect).not.toHaveBeenCalled();
    expect(onClose, 'IME 组字时回车不得关面板').not.toHaveBeenCalled();

    // 方向键同理放行:active 不动
    fireEvent.keyDown(input, { key: 'ArrowDown', isComposing: true });
    expect(input.getAttribute('aria-activedescendant')).toBe('search-hit-note-1');
  });

  it('6. combobox 语义:aria-controls 指向真实存在的 listbox,aria-expanded 随结果变化', async () => {
    const { input } = await openWith([NOTE_HIT, FILE_HIT]);

    expect(input.getAttribute('aria-controls')).toBe('search-listbox');
    const listbox = document.getElementById('search-listbox');
    expect(listbox).not.toBeNull();
    expect(listbox!.getAttribute('role')).toBe('listbox');
    // 有结果 ⇒ 展开
    expect(input.getAttribute('aria-expanded')).toBe('true');
    // listbox 不抢焦点(不参与 tab 序列)
    expect(listbox!.hasAttribute('tabindex')).toBe(false);
  });

  it('7. Escape 关闭搜索面板', async () => {
    const { onClose } = await openWith([NOTE_HIT]);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
