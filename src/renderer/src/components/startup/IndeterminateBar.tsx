// 不确定进度条 — 没有 count/total 时使用,做"在跑但不知道多久"的视觉提示
// animate-pulse 由 globals.css 的 prefers-reduced-motion 兜底自动停掉
import { useTranslation } from 'react-i18next';

export function IndeterminateBar() {
  const { t } = useTranslation();
  return (
    <div
      className="w-full h-1 bg-bg-hover rounded-full overflow-hidden"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={0}
      aria-label={t('common.indeterminate')}
    >
      <div className="h-full w-1/3 bg-accent/70 rounded-full animate-pulse" />
    </div>
  );
}
