// 删除/操作前确认 — 与 Modal 同款节奏(背景遮罩 + 缩放动画),但更紧凑
// 副作用收敛到 Overlay:ESC/焦点/滚动锁/焦点陷阱
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Info } from 'lucide-react';
import { Button } from '../ui/Button';
import { Overlay } from '../ui/Overlay';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  const resolvedConfirm = confirmLabel ?? t('common.confirm');
  const resolvedCancel = cancelLabel ?? t('common.cancel');
  const titleId = useId();
  const messageId = useId();
  // audit round 17 (2026-09-15):A11Y-H3 — 初始焦点放在「安全动作」上。
  //   非 danger → Confirm(主操作);danger → Cancel(防误删,符合 macOS/Win 平台
  //   约定)。
  // audit 2026-09-16 r18:H2 — ref 改 data-attr + autoFocusSelector,绕过
  //   <Button> 不 forwardRef / span 不 focusable 的尴尬组合。原 initialFocusRef
  //   接到 span → no-op → fallback 到 panelRef.current.focus() 落空,焦点
  //   跑到 panel div 上,r17 "聚焦安全动作" 完全失效。
  const initialFocusSelector = danger
    ? '[data-confirm-cancel] [data-confirm-button]'
    : '[data-confirm-confirm] [data-confirm-button]';
  if (!open) return null;
  const Icon = danger ? AlertTriangle : Info;
  const iconWrap = danger ? 'bg-danger/10 text-danger' : 'bg-accent-dim text-accent';

  return (
    <Overlay
      open={open}
      onClose={onCancel}
      closeOnEscape
      closeOnBackdrop
      autoFocusSelector={initialFocusSelector}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={message ? messageId : undefined}
        // VSCode 风格:圆角从 rounded-xl → rounded-lg
        className="bg-bg-surface border border-border-subtle rounded-md shadow-modal p-5 max-w-sm w-full mx-4 animate-in zoom-in-95 duration-150"
      >
        <div className="flex items-start gap-3 mb-4">
          <div
            className={`w-9 h-9 rounded flex items-center justify-center flex-shrink-0 ${iconWrap}`}
          >
            <Icon size={16} aria-hidden="true" />
          </div>
          <div className="flex-1 min-w-0 pt-0.5">
            {/* V1.5 (audit fix #19):补上 uppercase tracking-wider,跟全站面板标题节奏一致 */}
            <h2
              id={titleId}
              className="text-sm font-semibold uppercase tracking-wider text-fg leading-snug"
            >
              {title}
            </h2>
            {message && (
              <p id={messageId} className="text-xs text-fg-secondary mt-1.5 leading-relaxed">
                {message}
              </p>
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          {/* <Button> 不 forwardRef —— 用 span + data-attr 让 autoFocusSelector
              通过 querySelector 找到真按钮。r18:H2 把焦点真正落到按钮上。 */}
          <span data-confirm-cancel>
            <Button data-confirm-button variant="ghost" onClick={onCancel} size="md">
              {resolvedCancel}
            </Button>
          </span>
          <span data-confirm-confirm>
            <Button
              data-confirm-button
              variant={danger ? 'danger' : 'primary'}
              onClick={onConfirm}
              size="md"
            >
              {resolvedConfirm}
            </Button>
          </span>
        </div>
      </div>
    </Overlay>
  );
}
