// Drawer — 右侧滑出面板 (Linear / Notion 风格)
//
// 与 Modal 的区别:
//   - 不居中 — 固定在 viewport 右侧
//   - 宽度可控 (默认 512px, 可用 width prop 改)
//   - 内容区通常贯穿整个高度,没有 max-height 限制
//   - 副作用全部委托给 Overlay:ESC / 焦点陷阱 / body 滚动锁 都一致
//
// 入场动画:
//   - 面板从右侧滑入 (translate-x-full → translate-x-0)
//   - 背景 fade-in
// 复用 Tailwind 的 `animate-in slide-in-from-right + fade-in` 模式
//
// 定位:Drawer 贴右侧。Overlay 默认是 flex items-center justify-center(为 Modal 居中
// 设计的)。Drawer 通过 `className="!justify-end !items-stretch"` 把 align/justify 改成
// 贴右 + 撑满高度 — 不能用 ml-auto (panelRef 是 block 不是 flex),否则会被居中。
import { type ReactNode, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Overlay } from './Overlay';
import { CloseButton } from './Kbd';

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  /** 抽屉宽度,Tailwind class,默认 w-full max-w-lg(512px) */
  width?: string;
  /** 子标题/描述,显示在标题下面 */
  description?: string;
}

export function Drawer({
  open,
  onClose,
  title,
  children,
  footer,
  width = 'w-full max-w-lg',
  description,
}: DrawerProps) {
  const titleId = useId();
  const descId = useId();
  const { t } = useTranslation();
  if (!open) return null;
  return (
    // Overlay 默认 flex items-center justify-center (为 Modal 居中设计);
    // Drawer 要贴右侧。用 !important 覆盖 align/justify — panelRef 在 Overlay 里
    // 是普通 block 子元素,Drawer 自身的 ml-auto / w-full 无法在非 flex 父级生效,
    // 不覆盖的话 Drawer 会被居中,主窗口左右两边都露出,体感就是"被软件窗口遮挡"。
    // items-stretch 让 panelRef 撑满视口高度,h-full 把 Drawer 顶到 viewport 底;
    // justify-end 把 panelRef 推到右侧,Drawer 因此贴在右边缘。
    <Overlay
      open={open}
      onClose={onClose}
      className="!justify-end !items-stretch"
      // audit round 17 (2026-09-15):A11Y-H4 — 打开时聚焦关闭按钮,符合 WAI-ARIA
      //   dialog 约定。CloseButton 不 forwardRef,用 data-attr 选择器定位。
      // audit-r113:单层选择器命中的是 span 包装 —— 不可聚焦元素上 focus() 静默
      //   no-op,承诺从未生效(r18 在另一 dialog 组件修掉的同款形态,同轮漏了
      //   本站)。必须双层指向内部 button。
      autoFocusSelector="[data-close-button] button"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        // VSCode 风格:Drawer 不需要圆角(贴边),头部用 bg-raised 区分
        className={`bg-bg-surface border-l border-border-subtle shadow-modal h-full ${width} flex flex-col animate-in slide-in-from-right duration-200`}
      >
        {/* V1.5 (audit fix #6,7):chrome padding 从 py-2.5 收到 py-2,跟全站节奏一致 */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-border-subtle bg-bg-raised flex-shrink-0">
          <div className="min-w-0">
            <h2
              id={titleId}
              className="text-sm font-semibold uppercase tracking-wider text-fg truncate"
            >
              {title}
            </h2>
            {description && (
              <p id={descId} className="text-2xs text-fg-tertiary mt-0.5 truncate">
                {description}
              </p>
            )}
          </div>
          <span data-close-button>
            <CloseButton onClose={onClose} ariaLabel={t('common.close')} />
          </span>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
        {footer && (
          <div className="px-4 py-2 border-t border-border-subtle flex justify-end gap-2 bg-bg-raised flex-shrink-0">
            {footer}
          </div>
        )}
      </div>
    </Overlay>
  );
}
