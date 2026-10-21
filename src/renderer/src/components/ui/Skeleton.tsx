// Skeleton — 加载占位原语。视觉样式在 globals.css .skeleton 类(含浅深模式 + prefers-reduced-motion)。
import { clsx } from '../../lib/clsx';

type SkeletonVariant = 'text' | 'title' | 'block' | 'avatar';

export function Skeleton({
  className,
  variant = 'text',
}: {
  className?: string;
  variant?: SkeletonVariant;
}) {
  const variantClass =
    variant === 'title'
      ? 'h-5 w-2/3'
      : variant === 'block'
        ? 'h-24 w-full'
        : variant === 'avatar'
          ? 'h-9 w-9 rounded-full'
          : 'h-3 w-full';
  return <div className={clsx('skeleton', variantClass, className)} aria-hidden="true" />;
}

// 行宽交错序列(85/70/95/60/80/50/90),用固定顺序循环避免每次渲染重新随机 → 行宽抖动。
// 提到模块作用域避免每次 render 都分配新数组(7 元素 × 每次 render,加载占位场景下不值)。
const LINE_WIDTHS = [
  'w-[85%]',
  'w-[70%]',
  'w-[95%]',
  'w-[60%]',
  'w-[80%]',
  'w-[50%]',
  'w-[90%]',
] as const;

/**
 * 多行占位 — 用于 ReaderLoading 的 markdown / text 视图骨架。
 * 每行宽度按 LINE_WIDTHS 固定顺序循环,让占位看起来不那么"机械"。
 *
 * 自身 aria-hidden=true — "加载中"的语义由父容器(reader / editor outer
 * div)用 role="status" + aria-label 声明。Skeletons 是视觉占位,不是
 * 一个独立的 live region;嵌套 status role 会重复 announce。
 */
export function SkeletonLines({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={clsx('space-y-2', className)} aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className={clsx('skeleton h-3', LINE_WIDTHS[i % LINE_WIDTHS.length])} />
      ))}
    </div>
  );
}
