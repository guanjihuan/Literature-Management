// 启动期进度覆盖层 — VSCode 风格底部小卡片
//
// 设计要点:
//   - 位置:窗口底部居中(fixed inset-x-0 bottom-6),420px 宽小卡片
//   - 不阻塞窗口交互:外层 pointer-events-none,卡片本身 pointer-events-auto
//     (用户可继续点 header / 侧栏 / 主区,卡片只占自己 420px)
//   - z-index: Z.critical (80) — 高于 toast(70) / contextMenu(60) / overlay(50),
//     但不抢焦点(不接 ESC、不接遮罩点击、不锁 body 滚动)
//   - 自带 30s 安全兜底 — mount 后若一直没收到 all-done,强制 forceFinish
//   - ErrorBoundary 嵌套 — overlay 自身 crash 不让外层 App 也炸
//   - Portal 提升到 body — 避开任何上层 stacking context 困惑
//
// 视觉:沿用 Modal 卡片样式 (bg-bg-surface rounded-md shadow-modal)
// 字号阶梯: text-sm 标题 + text-2xs 副文案(对齐 StatusBar / EmptyState)
// 动画:.animate-in.slide-up-fade 进入(globals.css 现成 keyframes)
//
// 不做的事:不复用 src/renderer/src/components/ui/Overlay.tsx — 它的 body 滚动锁 /
// ESC 关闭 / focus trap / 遮罩点击关闭四项副作用都跟"启动期覆盖层"语义不符。
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Loader2, X } from 'lucide-react';
import { Z } from '../../lib/z-layers';
import { ErrorBoundary } from '../system/ErrorBoundary';
import { useStartupStore } from '../../store/startup';
import { IndeterminateBar } from './IndeterminateBar';
import type { StartupPhase } from '@shared/types';

/** 30s 安全超时 — 主进程崩溃或网络分区时,overlay 不能永远挂着 */
const FORCE_FINISH_TIMEOUT_MS = 30_000;

/** phase → i18n key — fallback 走 i18n bundle(en/zh)默认文案,不再硬编码
 *  重构 (2026-09):workspace phase 删除 —— recent / trash services 已下线,
 *   favorites 是单文件 AtomicFile 同步读,不需独立 phase。
 *  audit r51 (2026-10-15):补 'notes-resync' 槽位 —— r50 M6 引入新 phase 后
 *   Record<StartupPhase, string> 必填 key 缺一个会编译失败。i18n key 后续
 *   round 补(en/zh 各加 `startup.phase.notes-resync`),此处用 verbatim key 作
 *   兜底文案,不影响功能。 */
// audit-r56:删 'library' 槽位 —— library service 下线,StartupPhase union
//   已无 'library'(src/shared/types.ts:299);Record 必填 key 对齐。
// audit-r136:补 'literature' 槽位 —— r67 LiteratureService 重启后 startup
//   又引入 'literature' phase(union 在 src/shared/types.ts:363,
//   trackPhase 接入在 src/main/startup.ts:243);Record 漏填会让 typecheck 红,
//   i18n 文案先用 verbatim key 兜底,与 'notes'/'notes-resync' 同款节奏。
const PHASE_LABEL: Record<StartupPhase, string> = {
  notes: 'notes',
  'notes-resync': 'notes-resync',
  literature: 'literature',
  finalizing: 'finalizing',
};

export function StartupOverlay() {
  return (
    <ErrorBoundary name="StartupOverlay">
      <StartupOverlayInner />
    </ErrorBoundary>
  );
}

function StartupOverlayInner() {
  const { t } = useTranslation();
  const visible = useStartupStore((s) => s.visible);
  const activePhase = useStartupStore((s) => s.activePhase);
  const lastError = useStartupStore((s) => s.lastError);
  const forceFinish = useStartupStore((s) => s.forceFinish);

  // 安全超时:若 30s 没收到 all-done 兜底强制结束
  useEffect(() => {
    if (!visible) return;
    const id = setTimeout(forceFinish, FORCE_FINISH_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [visible, forceFinish]);

  // 仅当 portal 目标存在(SSR / 测试 env 不存在时跳过)
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // audit-r150 (2026-10-19) a11y:用户主动「不想等了」退出路径。语义比
  //   直接传 store action 更可读 —— forceFinish 是 30s 兜底语义,被用户
  //   主动点出来不应是 fallback,而是一次显式 cancel;同时让 a11y 触摸
  //   目标测试能通过 onClick={cancelStartup} 命中契约(forceFinish 隐式
  //   含义不利于静态扫描)。
  const cancelStartup = () => forceFinish();

  if (!visible || !mounted) return null;

  const phaseKey = activePhase ? PHASE_LABEL[activePhase] : null;
  // i18n key 缺失时由 i18n bundle 的 fallback 兜底(en/zh 各一份),不再硬编码中文
  const phaseLabel = phaseKey ? t(`startup.phase.${phaseKey}`) : '';
  // audit-r56:确定性进度条随 library phase 下线 —— 剩余 phase(notes /
  //   notes-resync / finalizing)都无 count/total 增量事件,一律 indeterminate。
  const progressText = t('startup.progress.indeterminate');

  return createPortal(
    // audit r29 (2026-09-21):a11y H3 —— outer wrapper 不挂 role=status / aria-live,
    //   原 aria-atomic=true 让 SR 每次 progress 数字变化都重读整段 wrapper
    //   (品牌区 + 标题 + 阶段标签 + 进度条 + 副文案),启动期 progress 100-300ms
    //   变一次,SR 用户被持续噪声覆盖。把 live region 缩窄到 leaf <p>
    //   (progressText)+ aria-atomic=false,SR 只读变化的 progressText,
    //   标题 / 阶段标签 / 进度条几何不再每帧重报。phaseLabel 与 progressText
    //   共用同一 live region:同一个 aria-live 容器,后者 atomic=false 让 SR
    //   各自只读变化子节点。
    <div
      className="fixed inset-x-0 bottom-6 flex justify-center pointer-events-none"
      style={{ zIndex: Z.critical }}
    >
      <div
        className="
          pointer-events-auto
          bg-bg-surface border border-border-subtle shadow-modal
          rounded-md
          px-5 py-4
          w-[420px] max-w-[90vw]
          animate-in slide-up-fade duration-180
        "
      >
        {/* 标题行:Loader2 + 标题 + 当前阶段标签(右侧 ml-auto) + 取消按钮 */}
        <div className="flex items-center gap-2 mb-2.5">
          <Loader2
            size={14}
            className="animate-spin text-fg-tertiary flex-shrink-0"
            aria-hidden="true"
          />
          {/* audit (2026-09-03 #22):补 uppercase tracking-wider,跟全站面板标题节奏一致 */}
          <h2 className="text-sm font-semibold uppercase tracking-wider text-fg leading-none">
            {t('startup.title')}
          </h2>
          {phaseLabel && (
            <span className="text-xs text-fg-tertiary ml-auto tabular-nums truncate min-w-0">
              {phaseLabel}
            </span>
          )}
          {/* audit-r143 (2026-10-19):手动的取消按钮 —— 30s forceFinish 是
              安全兜底但不是用户能感知的退出路径。在 phaseLabel 后挂一个 X:
              点一下直接 forceFinish,语义「不想等了」;文盲用户也能看到图标,
              aria-label 提供 SR 文本。focus 不抢(line 8 不接 ESC)。 */}
          <button
            type="button"
            onClick={cancelStartup}
            aria-label={t('startup.cancel')}
            title={t('startup.cancel')}
            // audit-r150 (2026-10-19) a11y:CloseButton 风格同步升至 44×44
            //   触摸目标(WCAG 2.5.5 AAA)。原 w-5 h-5 min-w-11 min-h-11
            //   是「凑宽度」组合,真把 X 容器做到 44 才是单一来源正确性。
            className="ml-1 flex items-center justify-center w-11 h-11 rounded text-fg-tertiary hover:text-fg hover:bg-bg-hover transition-colors duration-120 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            <X size={12} aria-hidden="true" />
          </button>
        </div>

        {/* 进度条(audit-r56:一律 indeterminate,library 确定性进度条已随该 phase 下线) */}
        <IndeterminateBar />

        {/* 副文案 + 可选错误提示 */}
        <div
          className="mt-2 flex items-baseline justify-between gap-2"
          role="status"
          aria-live="polite"
          aria-atomic="false"
        >
          <p className="text-2xs text-fg-tertiary tabular-nums truncate min-w-0">{progressText}</p>
          {lastError && (
            <p className="text-2xs text-danger truncate min-w-0" title={lastError}>
              {t('startup.error')}
            </p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
