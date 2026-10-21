// 阅读器加载态:Reader 主分发器 / 子阅读器共用
//
// 之前只是"加载中…" 居中 + spinner,占位面积小且不暗示内容形状。
// 改为"标题占位 + 8 行文本占位":用户视觉上有"马上看到内容"的预期,
// 同时跨 PDF/Markdown/Code/Text 各类型都能给出统一骨架。
//
// 适用 Suspense fallback(子阅读器 lazy chunk 加载)与 readerNode idle 状态。
//
// polish(2026-08-25):min-h-[320px] —— 父容器是 flex-1 时两者都填满,无高度差;
// 父容器不是 flex-1(罕见,如嵌入到尺寸未定的容器)时给一个稳定最小高度,
// 避免切换到内容时高度从 ~220px 跳到 ~400px+ 的视觉闪屏。
import { useTranslation } from 'react-i18next';
import { Skeleton, SkeletonLines } from '../ui/Skeleton';

export function ReaderLoading({ message }: { message?: string }) {
  const { t } = useTranslation();
  return (
    <div
      className="flex-1 min-h-[320px] flex flex-col p-6 gap-4"
      aria-busy="true"
      role="status"
      // audit round 17 (2026-09-15):A11Y-L4 — 跨 SR 引擎一致:aria-busy=true
      //   在 NVDA 上自动暗示 live,但 VoiceOver / TalkBack 不一定跟。加
      //   aria-live=polite 显式公告「加载中」+ 标题占位骨架,内容就绪时 SR
      //   自然切到新节点(Reader 正文 article),不会卡在 loading 状态。
      aria-live="polite"
      aria-label={message ?? t('common.loading')}
    >
      {/* 顶部"标题"占位 */}
      <Skeleton variant="title" />
      {/* 元信息行:作者 / 日期 / 字数 */}
      <Skeleton className="h-3 w-1/3" />
      {/* 正文行 — 8 行比 6 行更接近真实阅读器的视觉密度 */}
      <SkeletonLines rows={8} />
    </div>
  );
}
