// tests/unit/renderer/components/ui/tabs-keyboard-nav.test.tsx
//
// 守 Tabs 的 **WAI-ARIA tab pattern 键盘契约**(src/renderer/src/components/ui/Tabs.tsx
// 头注指向本文件,audit-r111 登记,本轮补齐 —— 原先标 🔒(守卫缺失))。
//
// 这条契约全站只有 Tabs 一处实现,漏了不会有第二个实现提醒你:
//   1. ← / → 在 tab 间移动(带环绕),Home / End 跳首尾;
//   2. **roving tabindex** —— 只有 selected 的 tab tabIndex=0,其余 -1,
//      整个 tablist 在 Tab 序列里只占一个停靠点;
//   3. 选中态随键盘移动,且**焦点跟着走**(WAI-ARIA 要求焦点与 selection
//      同步,否则 SR 读到的选中项与视觉焦点不一致);
//   4. active 指向一个不存在的 tab ⇒ 键盘处理整体 no-op(不吞默认行为);
//   5. 单 tab 列表:←/→/Home/End 算回原位 ⇒ **不** preventDefault
//      (否则会吞掉 textarea 里方向键移动光标等默认行为,audit 2026-09-07)。
//
// 变异思路:每条断言钉一个具体会被改坏的点(环绕 / roving / 焦点跟随 /
// no-op 分支 / 单 tab 不拦默认)。
import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { render, fireEvent, act } from '@testing-library/react';
import { Tabs } from '../../../../../src/renderer/src/components/ui/Tabs';

const TABS = [
  { id: 'a', label: 'A' },
  { id: 'b', label: 'B' },
  { id: 'c', label: 'C' },
];

/** rAF 在 jsdom 里是 ~16ms 的定时器,键盘切换后要把那一帧跑完。 */
async function flushFrame() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 40));
  });
}

function renderTabs(active = 'b', tabs = TABS) {
  const onChange = vi.fn();
  const { container, unmount } = render(
    <Tabs tabs={tabs} active={active} onChange={onChange} ariaLabel="模式" />,
  );
  const list = container.querySelector('[role="tablist"]');
  if (!list) throw new Error('Tabs 未渲染 tablist');
  return { list, onChange, container, unmount };
}

/**
 * 受控外壳 —— Tabs 是受控组件(active 由 caller 持有),键盘导航的
 * **环绕**行为只有在 active 真的跟着变时才能观察到。静态 active 恒为
 * 'b' 时,每次 → 都只能算出同一个 next,环绕是看不见的。
 */
function renderControlled(initial = 'b', tabs = TABS) {
  const onChange = vi.fn();
  function Harness() {
    const [active, setActive] = useState(initial);
    return (
      <Tabs
        tabs={tabs}
        active={active}
        onChange={(id) => {
          onChange(id);
          setActive(id);
        }}
        ariaLabel="模式"
      />
    );
  }
  const { container, unmount } = render(<Harness />);
  const list = container.querySelector('[role="tablist"]');
  if (!list) throw new Error('Tabs 未渲染 tablist');
  return { list, onChange, container, unmount };
}

function tabButtons(container: HTMLElement) {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
}

describe('Tabs 键盘导航契约(audit-r111 补齐)', () => {
  it('→ 前进一档(到末尾后环绕回首),← 后退一档(到首位后环绕到末)', () => {
    const { list, onChange, unmount } = renderControlled('b');
    fireEvent.keyDown(list, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('c');

    fireEvent.keyDown(list, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('a'); // 环绕

    fireEvent.keyDown(list, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('c'); // 反向环绕
    expect(onChange).toHaveBeenCalledTimes(3);
    unmount();
  });

  it('Home / End 跳到首 / 尾', () => {
    const { list, onChange, unmount } = renderTabs('b');
    fireEvent.keyDown(list, { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith('c');
    fireEvent.keyDown(list, { key: 'Home' });
    expect(onChange).toHaveBeenLastCalledWith('a');
    unmount();
  });

  it('roving tabindex:只有 selected 的 tab 可 Tab 进入,其余 -1', () => {
    const { container, unmount } = renderTabs('b');
    const btns = tabButtons(container);
    expect(btns.map((b) => b.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
    unmount();
  });

  it('键盘切换后焦点跟到新选中的 tab(WAI-ARIA:焦点与 selection 同步)', async () => {
    const { list, container, unmount } = renderTabs('b');
    fireEvent.keyDown(list, { key: 'ArrowRight' });
    await flushFrame();
    const btns = tabButtons(container);
    // 组件是受控的(active 不变则仍渲染旧选中态),但**焦点**已经移到 c
    expect(document.activeElement).toBe(btns[2]);
    unmount();
  });

  it('active 指向不存在的 tab ⇒ 键盘处理整体 no-op(不吞默认行为)', () => {
    const { list, onChange, unmount } = renderTabs('missing');
    const ev = fireEvent.keyDown(list, { key: 'ArrowRight' });
    expect(onChange).not.toHaveBeenCalled();
    expect(ev).toBe(true); // preventDefault 未被调用 ⇒ 返回 true
    unmount();
  });

  it('单 tab 列表:←/→/Home/End 不 preventDefault、不触发 onChange', () => {
    const one = [{ id: 'only', label: 'O' }];
    const { list, onChange, unmount } = renderTabs('only', one);
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) {
      const ev = fireEvent.keyDown(list, { key });
      expect(ev, `${key} 不应被 preventDefault 拦下`).toBe(true);
    }
    expect(onChange).not.toHaveBeenCalled();
    unmount();
  });

  it('非导航键(Enter / 空格 / 普通字符)完全不管', () => {
    const { list, onChange, unmount } = renderTabs('b');
    for (const key of ['Enter', ' ', 'x', 'Tab']) {
      fireEvent.keyDown(list, { key });
    }
    expect(onChange).not.toHaveBeenCalled();
    unmount();
  });

  it('ARIA 接线:tablist/tab 角色、aria-selected、id 与 aria-controls 配对', () => {
    const { container, unmount } = renderTabs('b');
    const list = container.querySelector('[role="tablist"]');
    expect(list?.getAttribute('aria-label')).toBe('模式');
    const btns = tabButtons(container);
    expect(btns.map((b) => b.id)).toEqual(['tab-a', 'tab-b', 'tab-c']);
    expect(btns.map((b) => b.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    expect(btns.map((b) => b.getAttribute('aria-controls'))).toEqual([
      'panel-a',
      'panel-b',
      'panel-c',
    ]);
    unmount();
  });

  it('鼠标点击某个 tab ⇒ onChange(该 id)', () => {
    const { container, onChange, unmount } = renderTabs('a');
    const btns = tabButtons(container);
    fireEvent.click(btns[2]);
    expect(onChange).toHaveBeenCalledWith('c');
    unmount();
  });
});
