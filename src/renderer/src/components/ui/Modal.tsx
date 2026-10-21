// 模态框 - Linear 风格
// 副作用(ESC/焦点/滚动锁/焦点陷阱)统一收敛到 Overlay 组件
import { ReactNode, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Overlay } from './Overlay';
import { CloseButton } from './Kbd';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
  /**
   * audit-r143 (2026-10-19) MED:对话框描述 —— dialog 元素挂 aria-describedby
   *   指向一个含「这段对话主要讲什么 / 操作后果」的 <p>(典型场景:ConfirmDialog
   *   「此操作不可撤销」说明,rename 弹窗「.md 扩展名会自动追加」等)。
   *   缺省时不挂 aria-describedby,SR 只读标题不读 body —— 用户听不到
   *   「删除会丢失数据」之类关键警示,只在视觉上看到。
   *   caller 写 false / 不传都等于「不要描述」,写 string 自动包成 <p> 渲染并接线。
   */
  description?: ReactNode;
  /**
   * 是否渲染右上角关闭按钮(默认 true)。
   *
   * audit 2026-10-04:MEDIUM —— 存在一种「必须先做决定、不能静默关掉」的弹窗
   * (LibraryPendingMigrationModal,audit-r61 已随库迁移收尾下线):它的 onClose
   * 是 noop。旧实现下 CloseButton 仍然照常渲染,于是用户看到一个**点了没反应**
   * 的 ✕,在 aria-modal 对话框里尤其突兀 —— 比「没有关闭按钮」更像 bug。
   *
   * 这类弹窗传 `dismissible={false}`:由内容自己提供出口,同时不再渲染一个
   * 假的关闭控件。Overlay 侧的 ESC / 点击遮罩仍走 onClose,语义与按钮一致
   * (都是 no-op)。示例 caller 已退役但 prop 契约保留(两分支行为锁
   * tests/unit/renderer/components/ui/modal-contract.test.tsx,audit-r117 本轮补齐)。
   */
  dismissible?: boolean;
  /**
   * audit-r124:转发给 Overlay 的初始焦点定向(此前 prop 面缺失)。
   * Overlay 进面板后 setTimeout(0) 会 focus panelRef 兜底 —— 没有定向时
   * 它会把 caller 内容里 React autoFocus 刚放好的焦点**偷走**
   * (NotesView rename 弹窗实证)。Overlay 头注承诺「Modal 可选」,
   * 本壳此前根本没接收这两个 prop,承诺悬空。优先级见 Overlay:
   * initialFocusRef > autoFocusSelector > panel 兜底。
   */
  autoFocusSelector?: string;
  initialFocusRef?: React.RefObject<HTMLElement | null>;
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = 'max-w-xl',
  dismissible = true,
  autoFocusSelector,
  initialFocusRef,
  description,
}: ModalProps) {
  const titleId = useId();
  const descId = useId();
  const { t } = useTranslation();
  if (!open) return null;
  // 简化接线:description 传 string 自动包成 <p>,传 ReactNode 原样渲染
  const descNode =
    description == null || description === false
      ? null
      : typeof description === 'string'
        ? <p id={descId} className="text-xs text-fg-tertiary mt-1.5 mb-3">{description}</p>
        : <div id={descId} className="mt-1.5 mb-3">{description}</div>;
  return (
    <Overlay open={open} onClose={onClose} autoFocusSelector={autoFocusSelector} initialFocusRef={initialFocusRef}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        // 描述存在时挂 aria-describedby(空描述 = 不挂,免得 SR 念空字符串)
        aria-describedby={descNode ? descId : undefined}
        // 圆角统一到 6px(rounded-md),与 Drawer 保持一致。
        // 之前 rounded-lg (8px) 是孤例,跨面板切换能感受到边角"变胖"。
        // audit 2026-09 (V1.8):CommandPalette / ShortcutsSheet 模块下线后,
        //   现存仅 Modal / Drawer 两个面板原语,rounded-md 同款已足够。
        className={`bg-bg-surface border border-border-subtle rounded-md shadow-modal w-full ${width} mx-4 max-h-panel flex flex-col animate-in zoom-in-95 duration-150 overflow-hidden`}
      >
        {/* V1.5 (audit fix #4,5):chrome padding 从 py-2.5 收到 py-2,跟全站节奏一致 */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-border-subtle bg-bg-raised">
          <h2 id={titleId} className="text-sm font-semibold uppercase tracking-wider text-fg">
            {title}
          </h2>
          {dismissible ? <CloseButton onClose={onClose} ariaLabel={t('common.close')} /> : null}
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          {descNode}
          {children}
        </div>
        {footer && (
          <div className="px-4 py-2 border-t border-border-subtle flex justify-end gap-2 bg-bg-raised">
            {footer}
          </div>
        )}
      </div>
    </Overlay>
  );
}
