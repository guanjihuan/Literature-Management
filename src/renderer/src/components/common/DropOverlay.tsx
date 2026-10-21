// DropOverlay — 列表区拖入覆盖层原语
//
// 单一真实来源(audit-r152 2026-10-19):此前 NotesList + LiteratureList
//   两处硬写 12-token arbitrary className + role/aria-live + Download
//   icon + 文本 span 4 件套,只差 aria-label / testId 透传。设计变更
//   (改色 / 改圆角 / 改 padding)要 2 处同步,容易漏一边。抽原语后:
//     * className 改 1 处全站生效
//     * aria 行为(role=status + aria-live=polite)集中定义,改 1 处
//       不会破坏 SR 用户拖入时的提示信号
//     * 视觉与行为步调一致,后续加 icon 变体 / 动画 也走原语
//
// 用法:
//   <DropOverlay
//     active={dragActive}
//     ariaLabel={t('notes.dropOverlay')}
//     text={t('notes.dropOverlay')}
//     testId="notes-drop-overlay"
//   />
//
//   active=false 时不渲染(走短路 return null),保持 dragActive state
//   在父组件的语义。aria-label 必传(无 fallback,防 SR 沉默)。
import { Download } from 'lucide-react';

export interface DropOverlayProps {
  /** 父组件传入的 dragActive state;false 时不渲染,直接 null */
  active: boolean;
  /** SR 用的 aria-label 文本(i18n t() 后的字符串,无 fallback) */
  ariaLabel: string;
  /** 覆盖层中央可见文本(同 ariaLabel 通常,但允许分开 i18n) */
  text: string;
  /** e2e 锚 testid,锁定原 drop overlay 唯一 id */
  testId: string;
}

export function DropOverlay({ active, ariaLabel, text, testId }: DropOverlayProps) {
  if (!active) return null;
  return (
    <div
      className="absolute inset-0 z-10 bg-accent/10 border-2 border-dashed border-accent rounded-md flex flex-col items-center justify-center gap-2 pointer-events-none"
      role="status"
      aria-live="polite"
      aria-label={ariaLabel}
      data-testid={testId}
    >
      <Download size={28} className="text-accent" aria-hidden="true" />
      <span className="text-sm font-medium text-fg">{text}</span>
    </div>
  );
}
