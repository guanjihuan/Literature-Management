// RadioChip — radiogroup 选项的视觉/语义原子
//
// 用途:SettingsPage 4 组互斥按钮组(theme / language / themePreset / font)
//   改用 radiogroup 语义后,选项外观保持原 <Button variant="primary|secondary">
//   切换(主色按钮 = 选中,次色按钮 = 未选)。新 radiogroup 需要 role="radio"
//   + aria-checked + roving tabIndex,而项目内 <Button> 是 plain function
//   不 forwardRef(无法被 useRadioGroup 的 ref map 绑定),因此抽这个最小原子。
//
// 设计取舍:
//   - 视觉尺寸与原 <Button size="sm"> 一致(h-7 px-3 text-xs)。
//   - 直接渲染原生 <button> —— role="radio" 需要 <button> 元素(其他元素
//     加 role 也能用,但 ARIA Authoring Practices 指南偏好 button)。
//   - 不接 size/variant prop —— 视觉只要一个固定"小芯片"档位,样式集中
//     在 .selected/.idle 两种状态。如果未来需要更多 variant,再扩 prop。
//
//   whitespace-nowrap 防御:
//     修复 (2026-10-15):LibraryList sidebar 280px 宽度下,filter chip
//     "全部""收藏"因 .text-xs 14px + 24px padding + 40px 按钮宽度 →
//     文字仅剩 16px 容纳 2 个 14px 中文字 → 垂直换行显示成竖排。
//     加 nowrap 兜底,即使将来 caller 写错 class 也不会"全\n部"叠起来。
//     caller 真要可换行显式传 whitespace-normal 覆盖。

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { clsx } from '../../lib/clsx';

export interface RadioChipProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'role' | 'tabIndex' | 'aria-checked' | 'type'
> {
  /**
   * audit round 17 (2026-09-15):A11Y-H1/M1 — `selected` 是 radiogroup 状态
   *   的唯一来源。`role` / `aria-checked` / `tabIndex` 由本组件从 selected
   *   内部派生,不允许 caller override —— 避免漂移(调用方传 role="button"
   *   会破坏 SR 语义)。这样 `<RadioChip {...useRadioGroup().getItemProps(id)}>`
   *   直接 spread 即可,无需 destructure aria-checked。
   */
  selected: boolean;
  children: ReactNode;
}

export const RadioChip = forwardRef<HTMLButtonElement, RadioChipProps>(function RadioChip(
  { selected, children, className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={selected ? 0 : -1}
      className={clsx(
        'inline-flex items-center gap-1.5 h-7 px-3 rounded text-xs font-medium transition-colors duration-120',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent',
        // whitespace-nowrap 防 chip 文字在窄宽度下被强制换行成竖排显示
        // (修复 (2026-10-15):旧实现未加 nowrap,LibraryList 280px sidebar
        //  下 .text-xs 14px 文字 + 24px padding → "全部" 挤成竖排)。
        'whitespace-nowrap',
        selected
          ? 'bg-bg-active text-fg border border-border-subtle'
          : 'text-fg-secondary hover:text-fg hover:bg-bg-hover border border-transparent',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});
