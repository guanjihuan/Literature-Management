// useRadioGroup:WAI-ARIA radio group roving tabindex + 方向键导航
//
// 与 ui/Tabs.tsx 同源(都是「同一组里只有一个选中」的交互模式),但比 Tabs
// 抽象一层 —— Tabs 把 children 写死成 <button role="tab">,这里是 generic
// 返回 spread props,让调用方决定容器/选项的视觉与文本。
//
// 设计原则(与 Tabs 一致):
//   - 容器 role=radiogroup,焦点在 active 选项 (tabIndex=0),其余 tabIndex=-1。
//     Tab 进/出 radiogroup 单次跳跃,不逐项 tab。
//   - 方向键(ArrowLeft/Right 或 ArrowUp/Down,看 group 方向)移动选择;Home/End
//     跳首/尾。rAF 焦点回调避免 layout jitter。
//   - 单选项(1 个)时 preventDefault 会拦截默认按键 → 不处理。Tabs.tsx:38
//     guard。
//   - 不抢 Space/Enter —— 让原生 button activation 处理,避免 toggle button
//     与 radiogroup 语义冲突。
//
// 用法:
//   const { getContainerProps, getItemProps } = useRadioGroup(
//     tabs, active, setActive,
//   );
//   return (
//     <div {...getContainerProps()}>
//       {tabs.map((t) => (
//         <button {...getItemProps(t.id)}>{t.label}</button>
//       ))}
//     </div>
//   );

import { useCallback, useMemo, useRef, type KeyboardEventHandler } from 'react';

interface UseRadioGroupOptions<T extends { id: string }> {
  tabs: readonly T[];
  active: string;
  onChange: (id: string) => void;
  /**
   * 方向键方向 —— 默认 horizontal(只接受 ArrowLeft/Right)。
   * vertical 用于语言/主题 preset 这种纵向布局,接受 ArrowUp/Down。
   */
  orientation?: 'horizontal' | 'vertical' | 'both';
}

interface RadioGroupProps {
  role: 'radiogroup';
  onKeyDown: KeyboardEventHandler<HTMLDivElement>;
}

interface RadioItemProps {
  selected: boolean;
  onClick: () => void;
  ref: (el: HTMLButtonElement | null) => void;
}

export function useRadioGroup<T extends { id: string }>({
  tabs,
  active,
  onChange,
  orientation = 'horizontal',
}: UseRadioGroupOptions<T>): {
  getContainerProps: () => RadioGroupProps;
  getItemProps: (id: string) => RadioItemProps;
} {
  // ref map 锁定每个选项的 DOM —— 方向键切换时 rAF 调焦点
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const getContainerProps = useCallback(
    (): RadioGroupProps => ({
      role: 'radiogroup',
      onKeyDown: (e) => {
        const len = tabs.length;
        if (len === 0) return;
        const idx = tabs.findIndex((t) => t.id === active);
        if (idx < 0) return;
        let next = idx;
        const acceptHorizontal = orientation === 'horizontal' || orientation === 'both';
        const acceptVertical = orientation === 'vertical' || orientation === 'both';
        if (acceptHorizontal && e.key === 'ArrowRight') next = (idx + 1) % len;
        else if (acceptHorizontal && e.key === 'ArrowLeft') next = (idx - 1 + len) % len;
        else if (acceptVertical && e.key === 'ArrowDown') next = (idx + 1) % len;
        else if (acceptVertical && e.key === 'ArrowUp') next = (idx - 1 + len) % len;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = len - 1;
        else return;
        if (next === idx) return;
        e.preventDefault();
        const nextId = tabs[next].id;
        onChange(nextId);
        requestAnimationFrame(() => {
          refs.current[nextId]?.focus();
        });
      },
    }),
    [tabs, active, onChange, orientation],
  );

  const getItemProps = useCallback(
    (id: string): RadioItemProps => {
      const selected = id === active;
      return {
        selected,
        onClick: () => onChange(id),
        ref: (el) => {
          refs.current[id] = el;
        },
      };
    },
    [active, onChange],
  );

  return useMemo(() => ({ getContainerProps, getItemProps }), [getContainerProps, getItemProps]);
}
