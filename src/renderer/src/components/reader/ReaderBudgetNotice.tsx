// src/renderer/src/components/reader/ReaderBudgetNotice.tsx
//
// perf r259:大文件「降级渲染」提示条。
//
// 背景:阅读器对超过预算的大文件只对前一段做高亮 / markdown 渲染,其余
// 按纯文本呈现(见 lib/reader-budget.ts)。**内容不丢**,但用户有权知道
// 「后面那段没有高亮 / 没有排版」—— 否则「代码不高亮」会被当成 bug。
//
// 附带一个「在系统应用打开」出口:想要完整语法高亮 / 完整排版的用户可以
// 交给系统应用(浏览器 / VS Code),而不是在应用里被降级。
import { Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button';

interface ReaderBudgetNoticeProps {
  /** 提示正文(已由调用方用 i18n 拼好)。 */
  message: string;
  /** 「在系统应用打开」回调;不给就不渲染按钮。 */
  onOpenExternal?: () => void;
}

export function ReaderBudgetNotice({ message, onOpenExternal }: ReaderBudgetNoticeProps) {
  const { t } = useTranslation();
  return (
    <div
      className="flex items-center gap-2 px-4 py-2 border-b border-border-subtle bg-bg-surface text-xs text-fg-secondary"
      role="status"
    >
      <Info size={14} className="shrink-0 text-warning" aria-hidden="true" />
      <span className="flex-1">{message}</span>
      {onOpenExternal && (
        <Button type="button" variant="secondary" size="sm" onClick={onOpenExternal}>
          {t('reader.openExternal')}
        </Button>
      )}
    </div>
  );
}
