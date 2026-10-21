// 阅读器统一错误展示 — 用 EmptyState 共享视觉节奏(与 ReaderEmpty 对齐),
// 按钮文案走 i18n,警告图标用 module-tone yellow
//
// 设计动机 (2026-09-03):之前是 bespoke markup + 3 处硬编码中文
//   (重新扫描 / 重试 / 在系统应用打开)—— 不仅 i18n 漂移,且跟
//   EmptyState / ErrorFallback 视觉节奏不同(icon box / 字号 / 描边)。
//   改用 EmptyState 后:icon box 一致 / 字号一致 / 行动按钮走 action 槽。
//   警告色不进 EmptyState accent prop(accent 限定 module-key),
//   直接在 icon 元素自身上挂 text-warning,与 ErrorFallback 的 text-danger 平行。
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '../ui/chrome';
import { Button } from '../ui/Button';

// audit 2026-09-08:从 export 改非 export —— 0 外部 caller,只本文件
//   ReaderError 引用。
// audit-r63:删 onRescan —— library 退役后无 caller,死 prop。
interface ReaderErrorProps {
  title: string;
  description?: string;
  onRetry?: () => void;
  onOpenExternal?: () => void;
}

export function ReaderError({
  title,
  description,
  onRetry,
  onOpenExternal,
}: ReaderErrorProps) {
  const { t } = useTranslation();
  return (
    <EmptyState
      size="lg"
      icon={<AlertTriangle size={26} className="text-warning" aria-hidden="true" />}
      title={title}
      description={description}
      // 主操作在前:Retry(网络抖动)/ OpenExternal(系统兜底)。
      // 排版上 retry 始终居中(最常见动作)。
      action={
        <div className="flex items-center justify-center gap-2 flex-wrap">
          {onRetry && (
            <Button type="button" variant="primary" size="sm" onClick={onRetry}>
              {t('reader.errorRetry')}
            </Button>
          )}
          {onOpenExternal && (
            <Button type="button" variant="secondary" size="sm" onClick={onOpenExternal}>
              {t('reader.errorOpenExternal')}
            </Button>
          )}
        </div>
      }
    />
  );
}
