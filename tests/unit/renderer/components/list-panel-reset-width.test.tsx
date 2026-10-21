// tests/unit/renderer/components/list-panel-reset-width.test.tsx
//
// 守 r240「恢复默认宽度」按钮的行为契约。
//
// 背景:左侧列表面板(WorkbenchListPanel)的宽度可拖拽,默认值在 r132/r175/r238
//   三轮里来回调过(320→240→280)。用户拖过分隔条之后没有显式途径回退到默认
//   —— 唯一的手势是「双击分隔条」(VerticalResizeHandle 的 onDoubleClick),
//   那是隐藏手势,用户不会知道它存在。r240 加了一个显式按钮。
//
// 本测锁(行为级,不测实现细节):
//   A. 按钮真实存在、可点、且**不在 tablist 内部** —— tablist 的 a11y 结构
//      只能含 tab;按钮塞进去会让 NVDA 念出一堆无关项(与 Tabs 的 roving
//      tabindex 约定也冲突:Tab 键到不了它)。
//   B. 点一下 ⇒ 面板宽度回到默认(不是回落到「上次拖拽前的值」)。
//   C. 复位**会落盘**(localStorage 写成默认值)⇒ 重启后仍生效,不是一次性
//      的视觉回弹(hook 的 [width] effect 负责写盘)。
//   D. 已经在默认值时点按钮 ⇒ 不抛错、宽度不变(幂等)。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';

// i18n:只关心交互与键名,不在乎文案
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

// workspace store:ListPanel 只用 active / setActive
vi.mock('../../../../src/renderer/src/store/workspace', () => {
  const state = { active: 'library', setActive: vi.fn() };
  const useWorkspaceStore = ((selector?: (s: unknown) => unknown) =>
    selector ? selector(state) : state) as unknown as {
    (selector?: (s: unknown) => unknown): unknown;
    getState: () => unknown;
  };
  useWorkspaceStore.getState = () => state;
  return { useWorkspaceStore };
});

// 懒加载的列表组件:本测不关心列表内容,换掉避免 react-virtuoso / IPC 噪声
vi.mock('../../../../src/renderer/src/components/literature/LiteratureList', () => ({
  LiteratureList: () => <div data-testid="lit-list" />,
}));
vi.mock('../../../../src/renderer/src/components/notes/NotesList', () => ({
  NotesList: () => <div data-testid="notes-list" />,
}));

import { WorkbenchListPanel } from '../../../../src/renderer/src/components/layout/WorkbenchListPanel';
import {
  LIST_PANEL_DEFAULT,
  LIST_PANEL_WIDTH_KEY,
} from '../../../../src/renderer/src/components/layout/list-panel-width';

const RESET_LABEL = 'workbench.listPanelResetWidth';

function renderPanel() {
  const { container } = render(<WorkbenchListPanel />);
  const section = container.querySelector('section') as HTMLElement;
  const button = container.querySelector(`button[aria-label="${RESET_LABEL}"]`) as HTMLElement;
  return { container, section, button };
}

describe('左侧列表面板「恢复默认宽度」按钮(r240)', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('按钮存在,且在 tablist **之外**(不污染 tablist 的 a11y 结构)', () => {
    const { container, button } = renderPanel();
    expect(button).toBeTruthy();
    expect(container.querySelector('[role="tablist"]')).toBeTruthy();
    // 按钮不能是 tablist 的后代
    expect(container.querySelector(`[role="tablist"] button[aria-label="${RESET_LABEL}"]`)).toBeNull();
    // 也不能被塞进 tabpanel(那是列表内容的容器)
    expect(container.querySelector(`[role="tabpanel"] button[aria-label="${RESET_LABEL}"]`)).toBeNull();
  });

  it('点按钮 ⇒ 宽度回到默认值(从用户拖过的宽度回退)', () => {
    // 模拟用户拖到 400(偏好已落盘)
    localStorage.setItem(LIST_PANEL_WIDTH_KEY, '400');
    const { section, button } = renderPanel();
    expect(section.style.width).toBe('400px');

    fireEvent.click(button);
    expect(section.style.width).toBe(`${LIST_PANEL_DEFAULT}px`);
  });

  it('复位会落盘 ⇒ 重启后仍是默认值(不是一次性视觉回弹)', () => {
    localStorage.setItem(LIST_PANEL_WIDTH_KEY, '400');
    const { button } = renderPanel();

    fireEvent.click(button);
    expect(localStorage.getItem(LIST_PANEL_WIDTH_KEY)).toBe(String(LIST_PANEL_DEFAULT));
  });

  it('已经在默认值时点按钮 ⇒ 幂等(宽度不变,不抛错)', () => {
    const { section, button } = renderPanel();
    expect(section.style.width).toBe(`${LIST_PANEL_DEFAULT}px`);

    fireEvent.click(button);
    expect(section.style.width).toBe(`${LIST_PANEL_DEFAULT}px`);
    expect(localStorage.getItem(LIST_PANEL_WIDTH_KEY)).toBe(String(LIST_PANEL_DEFAULT));
  });

  it('复位目标始终是**当前**默认值常量(不是硬编码的旧数字)', () => {
    // 语义锁:按钮复位到 list-panel-width.ts 里的默认值 ——
    // 以后默认值再变(r240 之后可能还有 r24x),按钮自动跟随,不会退回旧数字。
    localStorage.setItem(LIST_PANEL_WIDTH_KEY, '400');
    const { section, button } = renderPanel();
    fireEvent.click(button);
    expect(section.style.width).toBe(`${LIST_PANEL_DEFAULT}px`);
    expect(LIST_PANEL_DEFAULT).toBeGreaterThan(0);
  });
});
