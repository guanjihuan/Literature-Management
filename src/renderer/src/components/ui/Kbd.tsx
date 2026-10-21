// Kbd — 键盘按键指示器原语
//
// 单一真实来源(设计意图):快捷键标注统一用此组件,避免散落的 3 套
//   样式(font-mono 有无 / 字号 / padding / bg)。现存 caller 为零
//   (chrome 处走原生 title tooltip 标注,见下方 V1.8/r124 注记),
//   CloseButton 同模块三处在用。
//
// 设计 token:
//  - 11px 字号(text-2xs),等宽
//  - 1px 描边 + bg-surface / border-subtle — 与按钮的 bg-raised 区分,
//    让 kbd 视觉上比按钮"更冷",不抢戏
//  - 6px padding-x,2px padding-y
//
// 与 CloseButton 同等地位:小工具原语,所有 chrome / 设置
// 都从这里拿。
// audit 2026-09 (V1.8) → audit-r124 再校正:原注称「Modal / Drawer 是
//   现存仅有的两个 Kbd caller(grep "<Kbd" 可验证)」—— grep 实测 0 命中:
//   Modal/Drawer/SearchPanel 三处从本模块 import 的全部是 CloseButton,
//   Kbd 组件本体在 src 无任何 caller(V1.8 校正时即已失真)。保留为公开
//   原语(零引用面契约锁家族先例 r115-r117),行为锁见
//   kbd-contract.test.tsx;将来 chrome 需要键帽标注从这里拿,别再内联。
import type { ReactNode } from 'react';
import { clsx } from '../../lib/clsx';

export function Kbd({
  children,
  className,
  /** 用于暗背景下;默认 false */
  subtle,
}: {
  children: ReactNode;
  className?: string;
  subtle?: boolean;
}) {
  return (
    <kbd
      className={clsx(
        'inline-flex items-center justify-center font-mono text-2xs leading-none px-1.5 py-0.5 rounded-sm',
        subtle
          ? 'bg-bg-surface text-fg-secondary border border-border-subtle'
          : 'bg-bg-raised text-fg-secondary border border-border-subtle',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/**
 * CloseButton — 面板头部右侧的关闭 X 按钮
 *
 * 单一真实来源:Modal / Drawer 之前各自手写一份,
 * focus-visible ring 与 aria-label 经常遗漏。集中后:
 *   - i18n:aria-label/title 由调用方通过 prop 注入(避免 hook 顺序问题)
 *   - a11y:有 focus-visible:ring(键盘用户可见)
 *   - 视觉:w-6 h-6 与面板头其它工具按钮对齐
 */
export function CloseButton({
  onClose,
  size = 13,
  className,
  /** 屏幕阅读器 / title 用的可访问名 — 强制由调用方通过 t() 注入(原默认 '关闭'
   *  是硬编码中文,在 i18n 切换时会变成 fallback 残留。Modal / Drawer
   * 两处调用方都已传 ariaLabel={t('common.close')},默认值实为死代码) */
  ariaLabel,
  /** title tooltip 文本,默认 "(Esc)" — 不走 i18n,因为这是技术提示,跨语言一致 */
  ariaHint = '(Esc)',
}: {
  onClose: () => void;
  /** X 图标尺寸,默认 13px */
  size?: number;
  className?: string;
  ariaLabel: string;
  ariaHint?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClose}
      aria-label={ariaLabel}
      title={`${ariaLabel} ${ariaHint}`.trim()}
      className={clsx(
        // audit-r150 (2026-10-19) a11y:CloseButton 触摸目标 24→44(WCAG 2.5.5
        //   AAA)。改 1 处全 Modal/Drawer/SearchPanel/NotesView rename 等
        //   头部 X 单一来源受益。min-w-11 同步防文字 X 12px 撑不开触摸区。
        'w-6 h-6 min-w-11 min-h-11 flex items-center justify-center rounded text-fg-tertiary',
        'hover:text-fg hover:bg-bg-hover',
        'transition-colors duration-120 flex-shrink-0',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
        className,
      )}
    >
      <XMarkIcon size={size} />
    </button>
  );
}

// 内联 X icon — 不引入 lucide-react 依赖,避免 kbd 包拖一整个图标库。
// 简单的 12 视图框、stroke-width 2,close 按钮的视觉与 lucide-X 几乎无差。
function XMarkIcon({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}
