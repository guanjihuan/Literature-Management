// tests/unit/renderer/components/search/search-panel-slice-consistency.test.tsx
//
// 守 audit-r77「渲染行集合 == 键盘可达集合」契约
// (src/renderer/src/components/search/SearchPanel.tsx 头注指向本文件,
//  原先标 🔒(守卫缺失))。
//
// 旧实现的 bug:section 渲染用的是**未 slice** 的 noteHits / fileHits,
// 而键盘导航用的 flatHits 是 **slice(0, 50)** 之后的集合 —— 两者只在
// 「主进程恰好也返回 50 条」时才相等。一旦主进程 limit 调大:
//
//   * 屏幕上多出一批行(section 头还按未截断的 count 虚报),
//   * 但 ArrowDown 永远走不到它们(flatHits 只有 50 条)⇒
//     「鼠标能点、键盘到不了」的行,SR 用户(只能靠键盘)直接看不到。
//
// 本测锁的用户可见结果:
//   1. 渲染出来的命中行数 == 面板上限(50),不多不少;
//   2. section 头的 count 与**该 section 实际渲染的行数**一致(不虚报);
//   3. 键盘从第一行一路走到最后,停下的那一行就是**屏幕上最后一行**
//     (渲染集 == 可达集);
//   4. 命中数不足上限时,渲染行数 == 命中数(不被误截断)。
//
// 退化后的用户可见后果:
//   - 1/3 退化 ⇒ 底部几行鼠标能点、键盘永远到不了;SR 用户无法定位这些结果;
//   - 2 退化 ⇒ section 头写着「文献 30」,实际只列了 20 条,用户以为自己看全了。
//
// 变异思路(哪几处改动会红):
//   - section 改回用未 slice 的 noteHits / fileHits ⇒ 例 1、2、3 红;
//   - MAX_VISIBLE_RESULTS 与渲染集解耦(比如渲染不限量)⇒ 例 1 红;
//   - section count 用未截断的数量 ⇒ 例 2 红。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, screen, cleanup, waitFor } from '@testing-library/react';

// i18n:面板走 useTranslation;section 头走 i18next.t 的 count 插值 ——
//   把 count 一起渲染出来,才能断言「count 与实际行数一致」。
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

const MAX_VISIBLE = 50;

function noteHits(n: number): SearchHit[] {
  return Array.from({ length: n }, (_, i) => ({
    kind: 'note' as const,
    id: `note-${i}`,
    relPath: `note-${i}.md`,
    title: `笔记 ${i}`,
    snippet: `片段 ${i}`,
    score: 1,
  }));
}

function fileHits(n: number): SearchHit[] {
  return Array.from({ length: n }, (_, i) => ({
    kind: 'file' as const,
    id: `file-${i}`,
    relPath: `file-${i}.pdf`,
    title: `文献 ${i}`,
    snippet: `片段 ${i}`,
    score: 1,
  }));
}

/** 所有渲染出来的命中行(Overlay 走 Portal,行在 document.body 里)。 */
function optionEls(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
}

/** 输入查询词 → 面板 300ms debounce 后才发 IPC → 等结果渲染完。 */
async function search(text: string, hits: SearchHit[]) {
  (window as unknown as { api: unknown }).api = {
    search: vi.fn().mockResolvedValue({ ok: true, data: hits }),
  };
  render(<SearchPanel open onClose={() => {}} />);
  const input = screen.getByLabelText('search.inputAria') as HTMLInputElement;
  fireEvent.change(input, { target: { value: text } });
  await waitFor(() => expect(optionEls().length).toBeGreaterThan(0), { timeout: 3000 });
  return input;
}

describe('SearchPanel:渲染集 == 键盘可达集(audit-r77)', () => {
  beforeEach(() => {
    notesSelect.mockClear();
    literatureSelect.mockClear();
    setActive.mockClear();
    requestFocusNote.mockClear();
  });
  afterEach(() => {
    cleanup();
  });

  it('1. 命中数超过上限时,渲染行数被截到上限(不多渲染)', async () => {
    await search('关键词', [...noteHits(30), ...fileHits(30)]);

    expect(optionEls()).toHaveLength(MAX_VISIBLE);
  });

  it('2. section 头的 count 与该 section 实际渲染的行数一致(不虚报)', async () => {
    await search('关键词', [...noteHits(30), ...fileHits(30)]);

    const noteRows = optionEls().filter((el) => el.id.startsWith('search-hit-note-'));
    const fileRows = optionEls().filter((el) => el.id.startsWith('search-hit-file-'));

    // 截断后:notes 30 条全留,files 只留前 20 条
    expect(noteRows).toHaveLength(30);
    expect(fileRows).toHaveLength(20);

    const body = document.body.textContent ?? '';
    expect(body).toContain('search.sectionNotes:30');
    expect(body).toContain('search.sectionLibrary:20');
  });

  it('3. 键盘走到底,停下的就是屏幕上最后一行(渲染集 == 可达集)', async () => {
    const input = await search('关键词', [...noteHits(30), ...fileHits(30)]);

    // 一路按到底(远超行数,验证不会越界/绕回)
    for (let i = 0; i < MAX_VISIBLE + 20; i++) {
      fireEvent.keyDown(input, { key: 'ArrowDown' });
    }

    const rows = optionEls();
    const last = rows[rows.length - 1]!;
    // 当前 active 行 = 最后一行
    const active = rows.filter((el) => el.getAttribute('aria-selected') === 'true');
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(last.id);
    // 且 input 的 aria-activedescendant 指向这一行
    expect(input.getAttribute('aria-activedescendant')).toBe(last.id);
    expect(document.getElementById(input.getAttribute('aria-activedescendant')!)).not.toBeNull();
  });

  it('3b. 每一次 ArrowDown 之后,active 指向的行都真实存在(不悬空)', async () => {
    const input = await search('关键词', [...noteHits(30), ...fileHits(30)]);

    for (let i = 0; i < MAX_VISIBLE + 5; i++) {
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      const id = input.getAttribute('aria-activedescendant');
      expect(id, 'aria-activedescendant 不能为空').toBeTruthy();
      expect(document.getElementById(id!), `第 ${i} 次 ArrowDown 后指向的行必须存在`).not.toBeNull();
    }
  });

  it('4. 命中数不足上限时,渲染行数 == 命中数(不被误截断)', async () => {
    await search('关键词', [...noteHits(3), ...fileHits(2)]);

    expect(optionEls()).toHaveLength(5);
    const body = document.body.textContent ?? '';
    expect(body).toContain('search.sectionNotes:3');
    expect(body).toContain('search.sectionLibrary:2');
  });
});
