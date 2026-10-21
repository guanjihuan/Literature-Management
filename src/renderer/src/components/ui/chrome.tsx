// 共享 UI 原语 — 模块色映射 / 空状态
//
// 设计意图:
//   文献管理系统把"模块头 + 工具栏 + 内容区"三段式节奏下沉到 master-detail
//   组件内部,不再走统一的 PageShell —— 视觉一致性通过共享 EmptyState 一个
//   原语 + MODULE_COLOR 模块色 token 保证。本轮(V1.4-bis)进一步精简:
//   PageShell / ModuleHeader / StatCard / SectionTitle 全部下架(无 caller)。
//   audit 2026-09:ModuleIcon / LoadErrorBanner 也下架(0 调用方),只剩
//   EmptyState + MODULE_COLOR 两个出口。
//
// 重构 (2026-09):home / recent / trash 模块删除 —— core-scope refactor 精简到
//   2 模块(Library / Notes),favorites 合并进 Library。
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import type { ModuleKey } from '@shared/types';
import { clsx } from '../../lib/clsx';

// 图标尺寸归一化 —— EmptyState 按 size 档位算出一个 iconSize,
// 统一在这里 clone 覆盖,调用方就不用再关心 size。
function sizedIcon(icon: ReactNode, px: number): ReactNode {
  return isValidElement(icon)
    ? cloneElement(icon as ReactElement<{ size?: number }>, { size: px })
    : icon;
}

// ---------------------------------------------------------------------------
// 模块色映射 — 给 2 个模块一个固定色彩身份,所有视觉元素都从这里取色
// (ModuleKey 单源在 @shared/types —— r217 下沉,本组件是消费方不再是定义方)
// ---------------------------------------------------------------------------

/** 模块主色 — 用于图标徽标背景渐变、文字色等 */
const MODULE_COLOR: Record<ModuleKey, string> = {
  library: 'var(--module-library-rgb)',
  notes: 'var(--module-notes-rgb)',
};

// ---------------------------------------------------------------------------
// EmptyState — 空状态
//
// 旧实现里 6 个 view 都各自拼了一份圆形 icon + 标题 + 描述的"空状态",
// 现在统一收敛到这个组件。
//
// 学术风格(2026-08-20):
//   - 图标框圆角 4px(rounded)
//   - lg 尺寸的图标框尺寸 64,不让空状态显得太重
//   - accent 模块色背景 12% + 描边 20%(保持)
// ---------------------------------------------------------------------------
export function EmptyState({
  icon,
  title,
  description,
  action,
  hint,
  size = 'md',
  accent,
  fill = true,
  // audit round 17 (2026-09-15):A11Y-H5 — 默认 off,保留所有 17 处既有调用方
  //   行为;需要让 SR 播报空状态变化时传 'polite' / 'assertive'。assertive →
  //   role="alert",polite → role="status",与 WAI-ARIA 1.2 一致。
  liveRegion = 'off',
}: {
  icon: ReactNode;
  title: string;
  description?: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** 给图标徽标加模块语义色(默认中性) */
  accent?: ModuleKey;
  /**
   * 是否撑满父容器高度(默认 true,即历史行为)。
   *
   * audit C3R96 (2026-08-23):`h-full` 只有在 EmptyState 是父容器唯一子元素时
   * 才对 —— 那时它铺满并垂直居中,正是主区空态想要的效果。但侧栏里它常常有
   * 兄弟节点(C3R95 加的 LoadErrorBanner,后于 V1.4-bis audit 下架),此时
   * 100% + 兄弟高度 > 父容器 → 凭空多一条滚动条,空态还被推得偏下。
   *
   * 做成显式 prop 而不是把 h-full 一把删掉:全项目 17 处调用,多数父容器是
   * block(不是 flex),删掉 h-full 会让它们统统失去垂直居中,而这种纯布局
   * 回归测试是测不出来的。默认 true → 现有调用方零行为变化,只有确实有兄弟
   * 节点的那几处显式传 false。
   *
   * 父容器 flex 列布局时 `flex-1` 接管:占据剩余空间并居中,既不溢出也没丢居中。
   */
  fill?: boolean;
  /** 把整个 EmptyState 包成 SR live region(默认 off,即不公告) */
  liveRegion?: 'polite' | 'assertive' | 'off';
}) {
  const container = size === 'sm' ? 'py-8 px-4' : size === 'lg' ? 'py-12 px-8' : 'py-10 px-6';
  const iconBox =
    size === 'sm' ? 'w-12 h-12 mb-3' : size === 'lg' ? 'w-16 h-16 mb-5' : 'w-14 h-14 mb-4';
  const iconSize = size === 'sm' ? 20 : size === 'lg' ? 28 : 24;
  const iconWrapStyle = accent
    ? {
        background: `rgb(${MODULE_COLOR[accent]} / 0.12)`,
        color: `rgb(${MODULE_COLOR[accent]})`,
        borderColor: `rgb(${MODULE_COLOR[accent]} / 0.20)`,
      }
    : undefined;
  // liveRegion='off'(默认)→ 不加 role/aria-live,既有 17 处调用方零行为变化。
  //  'polite' → role=status,空状态出现时 SR 读 title + description(整段)。
  //  'assertive' → role=alert,中断当前播报。
  const liveProps =
    liveRegion === 'off'
      ? undefined
      : {
          role: liveRegion === 'assertive' ? 'alert' : 'status',
          'aria-live': liveRegion,
        };
  return (
    <div
      {...liveProps}
      className={clsx(
        // min-w-0:窄窗口下被裁剪,无法滚动,导致 CTA 不可达
        'w-full min-w-0 flex flex-col items-center justify-center text-center overflow-y-auto',
        // fill 的取舍见上面 prop 注释:独子时 h-full 铺满并居中;有兄弟节点时
        // 换成 flex-1(父容器是 flex 列)只吃剩余空间,不再溢出。
        fill ? 'flex-1 h-full' : 'flex-1 min-h-0',
        container,
      )}
    >
      <div
        className={clsx(
          iconBox,
          // 学术风格:4px 圆角 + bg-surface + 弱 1px border
          'rounded flex items-center justify-center bg-bg-surface border border-border-subtle',
          // V2:hero-icon 升起一档阴影 —— 让空状态"hero"感更强。
          // 浅色下一档(0.04),深色下两档(0.20 + 0.12)维持层次感;两边阴影
          // 都是不抢眼的 ambient halo,跟 "icon box 在悬浮" 的物理直觉对齐。
          // audit-r145f (2026-10-19) MED:12-token arbitrary 阴影 → 收 token。
          //   heroIcon / heroIcon-strong 走 tailwind.config.cjs 集中定义,
          //   dark: 变体在深色主题下用 heroIcon-strong 补层次感(0.20 + 0.12,
          //   浅色 0.04 弱 halo 在深底上不够看)。本组件从此只引 token 名,
          //   改阴影不再碰组件源码。
          'shadow-heroIcon dark:shadow-heroIcon-strong',
        )}
        style={iconWrapStyle}
      >
        <span style={{ width: iconSize, height: iconSize, display: 'inline-flex' }}>
          {sizedIcon(icon, iconSize)}
        </span>
      </div>
      <p className={clsx('font-medium text-fg', size === 'sm' ? 'text-xs' : 'text-sm')}>{title}</p>
      {description && (
        <p
          className={clsx(
            // V2:description 从 fg-tertiary 提到 fg-secondary —— 空状态描述
            // 是用户操作的引导,层级应该接近 title 而不是 hint。
            'text-fg-secondary mt-1 max-w-sm leading-relaxed',
            size === 'sm' ? 'text-2xs' : 'text-xs',
          )}
        >
          {description}
        </p>
      )}
      {hint && <p className="text-2xs text-fg-tertiary mt-1.5 max-w-sm">{hint}</p>}
      {/* V2:action 间距 mt-5 → mt-4 —— CTA 是 hero 的"出路",离 description 越近
        视觉引导越直接;5 档留白显得割裂。 */}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
