// SettingsPage 原子组件 — 共享 Section/Label/ChromeToggle 壳
//
// 设计动机:
//   SettingsPage 主体专注"表单编排",原子 UI 抽到这里。这些组件都是设置页
//   专用,没有外部消费者。
//
// i18n:
//   ChromeToggle 内部不硬编码文案,调用方(SettingsPage)用 t() 组好文案,
//   通过 props 注入。这里只负责"渲染什么" / "状态语义",不碰 i18n hook,
//   避免 leaf 组件耦合翻译框架。
//
// 导出:
//   Section        — 设置分组的标题 + 内容容器
//   Label          — 字段上方的小写大写标题
//   ChromeToggle   — StatusBar 的"显示/隐藏"开关
import type { ReactNode } from 'react';

// === 原子 UI ===

/** 设置分组 — 上方 small-cap 标题 + 下方内容
 *
 * audit round 17 (2026-09-15):A11Y-H1 — `id` prop 透传到 <h3>,给 radiogroup
 *   提供 aria-labelledby 锚点(WAI-ARIA 1.2 要求 radiogroup 必有可访问名)。
 *   不传 id 时维持既有 h3 结构,所有既有 caller 零行为变化。
 */
export function Section({
  icon,
  title,
  children,
  id,
  // audit 2026-09-16 r18:M10 — 库路径 / 数据路径切换时整个 section 进入
  //   异步等待,加 aria-busy 让 SR 用户听到「操作进行中」而不是「按钮
  //   卡死」。
  'aria-busy': ariaBusy,
}: {
  icon?: ReactNode;
  title: string;
  children: ReactNode;
  id?: string;
  'aria-busy'?: boolean;
}) {
  return (
    <section aria-busy={ariaBusy}>
      <h3
        id={id}
        className="text-xs font-semibold text-fg-secondary uppercase tracking-wider mb-3 flex items-center gap-1.5"
      >
        {icon && <span className="text-fg-tertiary">{icon}</span>}
        {title}
      </h3>
      {children}
    </section>
  );
}

/** 字段上方的小标题(small-cap + tracking-wider),可附 icon
 *  支持 htmlFor 与输入控件关联(屏幕阅读器 / 焦点跳转 / 单击 label 激活输入)
 *
 * audit round 17 (2026-09-15):A11Y-H1/M1 — `id` prop 透传到 <label>,给嵌套
 *   在 Section 里的 radiogroup(主题预设 / 字体) 提供 aria-labelledby 锚点。
 *   不传 id 时维持既有 label 结构,所有既有 caller 零行为变化。
 */
export function Label({
  children,
  icon,
  htmlFor,
  id,
}: {
  children: ReactNode;
  icon?: ReactNode;
  htmlFor?: string;
  id?: string;
}) {
  return (
    <label
      id={id}
      htmlFor={htmlFor}
      className="block text-2xs font-medium text-fg-tertiary uppercase tracking-wider mb-1.5 flex items-center gap-1"
    >
      {icon}
      {children}
    </label>
  );
}

/**
 * Chrome 可见性开关 — 显示/隐藏状态指示。
 * 与 Button 风格的 primary/secondary 区分:这里强调"状态"而不是"动作"。
 *
 * i18n:`visibleLabel` / `hiddenLabel` 由调用方 t() 注入,
 * 避免本组件耦合 i18n hook。
 */
export function ChromeToggle({
  label,
  value,
  onToggle,
  visibleLabel,
  hiddenLabel,
}: {
  label: string;
  value: boolean;
  onToggle: () => void;
  visibleLabel: string;
  hiddenLabel: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={value}
      className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-md border border-border-subtle bg-bg-surface hover:bg-bg-hover hover:border-border-strong transition-colors duration-120 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
    >
      <span className="text-sm text-fg">{label}</span>
      <span
        className={
          'inline-flex items-center gap-1 text-2xs font-medium uppercase tracking-wider ' +
          (value ? 'text-warning' : 'text-success')
        }
      >
        <span
          className={'w-1.5 h-1.5 rounded-full ' + (value ? 'bg-warning' : 'bg-success')}
          aria-hidden="true"
        />
        {value ? hiddenLabel : visibleLabel}
      </span>
    </button>
  );
}
