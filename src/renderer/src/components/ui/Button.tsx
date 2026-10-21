// 通用按钮 - Linear 风格
// 行为锁 tests/unit/renderer/components/ui/button-contract.test.tsx(audit-r118,本轮补齐)
import { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { clsx } from '../../lib/clsx';

interface ButtonProps {
  children: ReactNode;
  onClick?: () => void;
  type?: 'button' | 'submit' | 'reset';
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'xs' | 'sm' | 'md' | 'lg';
  disabled?: boolean;
  /**
   * audit-r143 (2026-10-19) MED:加载态 —— 传 true 后:
   *   1. 按钮自动 disabled(防止异步动作期间被重复点击)
   *   2. 内容前插入 Loader2 旋转图标,文字不变(避免宽度跳变)
   *   3. aria-busy=true 让 SR 知道按钮正在处理
   *   4. 移除了 onClick 行为(防尾部漏检)
   * 多个 caller 原本用 `disabled={busy}` + 自己外置 spinner,现统一收敛
   * 到本 prop —— 视觉与行为步调一致,不需要每个 caller 重复造轮子。
   */
  loading?: boolean;
  className?: string;
  title?: string;
  'aria-label'?: string;
  // audit 2026-09-16 r18:H2 — 透传 data-* 属性,让 ConfirmDialog 的
  //   autoFocusSelector 能通过 querySelector 命中真按钮(避开 Button
  //   不 forwardRef 的历史包袱)。
  [dataAttr: `data-${string}`]: unknown;
}

export function Button({
  children,
  onClick,
  type = 'button',
  variant = 'secondary',
  size = 'sm',
  disabled = false,
  loading = false,
  className,
  title,
  'aria-label': ariaLabel,
  ...rest
}: ButtonProps) {
  // 把 data-* 透传到 <button>;其余按键白名单外的 prop 类型被 [dataAttr] 吃掉。
  const dataAttrs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (k.startsWith('data-')) dataAttrs[k] = v;
  }
  // loading 自动覆盖 disabled(避免 caller 同时传两份易踩异步窗口)
  const isDisabled = disabled || loading;
  return (
    <button
      type={type}
      // 加载期主动屏蔽 onClick,即便 disabled 被浏览器旁路也兜底
      onClick={isDisabled ? undefined : onClick}
      disabled={isDisabled}
      title={title}
      aria-label={ariaLabel}
      aria-busy={loading || undefined}
      className={clsx(
        'btn',
        // V1.5 (2026-09-02):按钮高度 / padding 微调,与 VSCode / Linear 紧凑风对齐
        //   xs 6→24,sm 7→26,md 8→30;padding 收紧;圆角 4→4(保持小圆角)
        // audit-r150 (2026-10-19) a11y:加 lg 档 h-11(44px)——
        //   WCAG 2.5.5 AAA 触摸目标最低 44×44。专给主动作按钮(Modal
        //   确认 / ErrorFallback retry / 关键 save)使用,默认仍是 sm
        //   保持视觉密度。
        size === 'xs' && 'h-6 px-1.5 text-xs',
        size === 'sm' && 'h-[26px] px-2 text-xs',
        size === 'md' && 'h-[30px] px-2.5 text-sm',
        size === 'lg' && 'h-11 px-3 text-sm',
        variant === 'primary' && 'btn-primary',
        variant === 'secondary' && 'btn-secondary',
        variant === 'ghost' && 'btn-ghost',
        variant === 'danger' && 'btn-danger',
        // 加载态视觉:微微透明 + 不可点 cursor,跟 disabled 节奏一致
        loading && 'opacity-80 cursor-not-allowed',
        className,
      )}
      {...dataAttrs}
    >
      {loading && (
        <Loader2
          size={12}
          className="animate-spin flex-shrink-0"
          aria-hidden="true"
        />
      )}
      {children}
    </button>
  );
}
