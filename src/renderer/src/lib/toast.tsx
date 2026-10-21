// src/renderer/src/lib/toast.tsx
//
// V1.5 (2026-09-02):toast 视觉微调与状态栏高度变化对齐(26→24),关闭按钮焦点环用
//   accent 而非 white/80(在 dark 主题下 white/80 显得割裂,统一用 token)。
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';
import { CheckCircle2, AlertCircle, AlertTriangle, Info, X } from 'lucide-react';
import type { ToastEventType } from '@shared/types';
import { Z } from './z-layers';

// audit-r92:union 不再手抄 —— 派生自 @shared/types TOAST_EVENT_TYPES 单源
// tuple(ToastEventType)。原内联 4 元组是跨 main/preload/renderer 5 处手抄
// 之一,加成员时 preload 边界白名单若漏改会静默丢事件(见 types.ts r92 注)。
export type ToastType = ToastEventType;

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  /** 自动消失时长(ms);0 = 不自动消失(仅手动关闭) */
  duration: number;
}

interface ToastState {
  toasts: Toast[];
  show: (t: { type: ToastType; message: string; duration?: number }) => void;
  dismiss: (id: string) => void;
}

// audit 2026-09-07:硬上限 —— 长任务中(网络抖动 / autosave 持续失败 / 扫描失败喷错)
//   会瞬时累积十几条 toast,每条都跑 setTimeout 计时 + 渲染,DOM 节点变胖还
//   盖住底部 statusbar。超出上限时丢最旧的(信息时效最低),用户也不会真的
//   一条条读完满屏通知。错误 6、其它 4 与各自默认时长大致成正比,够看。
const MAX_TOASTS = 6;
const TRIM_KEEP = 4;

const DEFAULT_DURATION: Record<ToastType, number> = {
  info: 3500,
  success: 2500,
  warning: 5000, // 警告保留稍久 —— 比 info 长但短于 error,信息密度介于两者之间
  error: 6000, // 错误保留更久,给用户阅读时间
};

let counter = 0;
const newId = () => `t${++counter}`;

export const useToast = create<ToastState>((set) => ({
  toasts: [],
  show: (t) =>
    set((s) => {
      // audit 2026-09-07:截断超量 toast —— 见 MAX_TOASTS 注释。
      // 策略:加新之后,如果超 MAX_TOASTS,丢最旧的若干条,保留最新
      //   MAX_TOASTS - TRIM_KEEP 条;典型路径"网络抖动喷 10 条 err"最后
      //   只剩 TRIM_KEEP = 4 条,够看不会满屏。保留的是最新的若干条,符合
      //   用户"刚发生的事更重要"的心智模型。
      // audit-r76 (2026-10-17):截断算术修正 —— 旧式 slice(len - (MAX-KEEP))
      //   = slice(len - 2),7 条时只留 2 条,与注释宣称的「4 + 1 = 5」自相
      //   矛盾(留的数量应该与 len 无关,恒为 MAX-KEEP = 2 → 还是不对;设计
      //   意图是截后留 TRIM_KEEP 条,即 slice(len - TRIM_KEEP) = slice(MAX-KEEP))。
      //   修正为 next.slice(MAX_TOASTS - TRIM_KEEP):从索引 2 起留 5 条
      //   (next.length 恒为 MAX+1 = 7,丢最旧 2 条,留 TRIM_KEEP+1 = 5 条)。
      // audit 2026-10-21 (r252):duration 的默认值必须**在展开之后**兜底。
      //   旧写法 `{ id, duration: DEFAULT_DURATION[t.type], ...t }` 里,`...t`
      //   排在后面 ⇒ 只要调用方**带着这个 key**(哪怕值是 undefined)就把默认值
      //   覆盖成 undefined。IPC 那条路正好如此:ToastPushPayload.duration 是
      //   **可选**字段,preload 守卫放行 undefined,renderer 侧再写一遍
      //   `duration: payload.duration` ⇒ key 存在、值 undefined ⇒ 默认时长
      //   被清成 undefined ⇒ ToastItem 里 `toast.duration <= 0` 对 undefined
      //   为 false(不早退)⇒ `setTimeout(dismiss, undefined)` ≈ 0ms ⇒
      //   **toast 0 毫秒闪没**(用户根本来不及看)。
      //   修法:`??` 兜底(不是 `||` —— duration=0 是「不自动消失」的合法值,
      //   必须原样保留)。
      const next = [
        ...s.toasts,
        { ...t, id: newId(), duration: t.duration ?? DEFAULT_DURATION[t.type] },
      ];
      if (next.length <= MAX_TOASTS) return { toasts: next };
      const trimmed = next.slice(MAX_TOASTS - TRIM_KEEP);
      return { toasts: trimmed };
    }),
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export interface ToastContainerProps {
  /**
   * 容器 bottom CSS 值(像素串)。调用方根据 StatusBar 显隐计算后传入。
   *   显示 → 'calc(var(--statusbar-h) + 8px)' = 32px(让出 24 + 呼吸 8)
   *   隐藏 → '8px'(贴屏底 + 呼吸 8)
   * 为什么不自己读 store:workspace store 反向 import 本文件的 useToast,
   *   此处再 import workspace 会闭环 → layering.test 硬不变式打破。落到 App
   *   层组装,本组件保持纯展示无 store 依赖。
   */
  bottomOffset: string;
}

export function ToastContainer({ bottomOffset }: ToastContainerProps) {
  const toasts = useToast((s) => s.toasts);
  const { t } = useTranslation();
  return (
    // 通知落点改为右下:top-right 与 TitleBar 右上控件冲突。
    // bottom 抬高到状态栏上方:状态栏高 24px(--statusbar-h,V1.5 改紧凑),再留 8px 呼吸 → 32px。
    // 这样 toast 不与 TitleBar / StatusBar 重叠,鼠标移过去还能 hover。
    // audit 2026-09-08:原注释列 "AI · 3 分钟前 / 未保存数 / 主题切换" —— AI
    //   状态指示 (useAIHealthStore) 与 unsavedCount (useUnsavedStore) 2026-09
    //   整体下线,StatusBar 中区只剩"扫描 / 字数"。同步删过时措辞,避免
    //   读者按字面去找已经不存在的指示器。
    // audit-r145b:bottom 由 App 层根据 statusBarHidden 计算后经 prop 传入,
    //   本组件保持纯展示无 store 依赖,避免与 workspace store 形成 import 闭环。
    <div
      className="fixed right-4 flex flex-col-reverse gap-2 max-w-md pointer-events-none"
      style={{ bottom: bottomOffset, zIndex: Z.toast }}
      role="region"
      aria-label={t('common.notificationAria')}
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}

function ToastItem({ toast }: { toast: Toast }) {
  const dismiss = useToast((s) => s.dismiss);
  const { t } = useTranslation();
  // hover-pause:错误通知常常携带较长文案,用户移到上面要读完时却被计时器
  // 自动消失很烦。鼠标进入暂停,离开恢复计时;duration<=0 永不自动消失的不参与。
  // audit 2026-09-07:resume 时保留已过时间 —— 之前 pause → resume 直接重启
  //   duration ms 计时器,用户读 5s 后离开还会再停 6s(原本应只停 1s)。改用
  //   pausedAtRef 记录暂停时刻,resume 时扣掉暂停时长。
  const [paused, setPaused] = useState(false);
  const pausedAtRef = useRef<number | null>(null);
  const remainingRef = useRef<number>(toast.duration);
  useEffect(() => {
    if (toast.duration <= 0) return;
    if (paused) return;
    // resume:把之前暂停扣掉的时长从剩余里减掉;首次 mount 直接用 duration
    const remaining = remainingRef.current;
    const t = setTimeout(() => dismiss(toast.id), remaining);
    return () => clearTimeout(t);
  }, [toast.id, toast.duration, dismiss, paused]);
  // audit 2026-09-10:useLayoutEffect 取代 render-time 写 ref —— React 19
  //   concurrent 模式下 render 可被中断 + 重试,render 阶段 Date.now() 写
  //   ref 会让暂停时长被算两次(两次 render 各自看到 paused=true → 各自
  //   算 elapsed,resume 路径下 cumulative error 累加)。useLayoutEffect 在
  //   commit 之后、paint 之前同步跑,render 中断不会重跑这里。
  useLayoutEffect(() => {
    if (paused && pausedAtRef.current === null) {
      pausedAtRef.current = Date.now();
    }
    if (!paused && pausedAtRef.current !== null) {
      const elapsed = Date.now() - pausedAtRef.current;
      pausedAtRef.current = null;
      if (elapsed > 0) {
        remainingRef.current = Math.max(0, remainingRef.current - elapsed);
      }
    }
  }, [paused]);

  const Icon =
    toast.type === 'success'
      ? CheckCircle2
      : toast.type === 'error'
        ? AlertCircle
        : toast.type === 'warning'
          ? AlertTriangle
          : Info;

  // 颜色与图标:error/success 用饱和色背景 + 白字;info 用表面色 + 主文字
  // audit round 8 (2026-09-14):palete 三层 ternary 改 Record —— ToastType 加
  //   新成员(如 'warning')时,Record 的 satisfies ToastType 强制收窄,TS 会
  //   因缺 key 报错,杜绝"加新 type 但 palette 漏配 → 静默用 info 兜底"。
  // audit 2026-09-16 r21:M15 — 加 'warning' 类型:amber/橙底色 + 警告三角。
  //   用于"导入成功但 frontmatter 解析失败"等"软失败"路径(操作成功但有
  //   副作用问题),让用户在不阻塞的情况下知道有副作用。
  const PALETTE: Record<ToastType, string> = {
    // r247:实心 toast 底改走 strong 档 —— 原色在 Dracula(#50FA7B 绿 / #F1FA8C 黄)、
    //   Nord(#EBCB8B)、Gruvbox(#FABD2F)这些鲜亮配色里压白字只有 1.1~1.7:1,
    //   提示条根本读不清。strong 档是同一色相压深到 white ≥ 4.8:1 的版本
    //   (见 globals.css「状态色两槽」注释 + theme-presets-contrast.test.ts)。
    error: 'bg-danger-strong text-white',
    success: 'bg-success-strong text-white',
    warning: 'bg-warning-strong text-white',
    info: 'bg-bg-surface text-fg border border-border-subtle',
  } satisfies Record<ToastType, string>;
  const palette = PALETTE[toast.type];

  return (
    <div
      data-testid="toast"
      role={toast.type === 'error' ? 'alert' : 'status'}
      aria-live={toast.type === 'error' ? 'assertive' : 'polite'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className={`pointer-events-auto px-3.5 py-2.5 rounded-md shadow-lg text-xs flex items-start gap-2.5 animate-in slide-up-fade ${palette}`}
    >
      <Icon size={14} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
      <span className="flex-1 leading-snug">{toast.message}</span>
      <button
        type="button"
        onClick={() => dismiss(toast.id)}
        aria-label={t('common.notificationCloseAria')}
        // V1.5:close 按钮焦点环用 accent(token)而非 white/80 ——
        //   dark 主题下 white/80 焦点环显得与 toast 整体色系脱节,统一用主题色。
        // audit 2026-09-16 r18:H8 — 起点 24×24 兜底(w-5/h-5 被 min-* 压过)。
        // audit-r150a-deps (2026-10-19) a11y 联动:同 H 家族升级 —— r150a 主
        //   批修了 Kbd CloseButton / Button size='lg' / StartupOverlay Cancel,
        //   这处 toast close 是 inline 同款,仍低于 WCAG 2.5.5 AAA 44×44 一档。
        //   toast 是用户主动关闭反馈的高频入口(比一般 inline X 优先级高:
        //   背景上下文紧迫 + 短时屏幕抢占),提到 44 满足 AAA。容器 px-3.5
        //   py-2.5 flex items-start —— 卡片高度从 ~30px 增至 ~52px,
        //   flex 自适应不裁剪;移除 -mr-1(close 改 44 后 -4px 偏移与原视觉
        //   节奏冲突),改 flex-shrink-0 保 44px 触摸区不被父 flex 缩掉。
        //   去掉 ! —— 父 .btn 不复盖此元素,! specificity 已无意义。
        className="min-w-[44px] min-h-[44px] inline-flex items-center justify-center flex-shrink-0 rounded opacity-70 hover:opacity-100 transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        <X size={12} aria-hidden="true" />
      </button>
    </div>
  );
}
