// 标签页 - Linear 风格 (无下划线,选中有微妙背景)
import { memo, ReactNode, KeyboardEvent, useRef } from 'react';
import { clsx } from '../../lib/clsx';

interface TabsProps {
  tabs: { id: string; label: string; icon?: ReactNode }[];
  active: string;
  onChange: (id: string) => void;
  /** 给容器加语义标签,默认 'tablist' */
  ariaLabel?: string;
}

// perf (2026-09-04):Tabs 用 memo —— StandaloneNoteEditorCore 击键时如果不把
//   tabs 数组 useMemo 化,每次 render 都重建 [{...}, {...}, {...}] 字面量 + 3
//   个 React element,无 memo 时 Tabs 整列(3 个 button + ref map)都会 reconcile。
//   memo + 调用方 useMemo tabs 后,active 未变时 Tabs 直接跳过子树。
export const Tabs = memo(function Tabs({ tabs, active, onChange, ariaLabel }: TabsProps) {
  // 持有每个 tab 按钮的 ref — 方向键切换后,把焦点跟着移动到新选中的按钮上。
  // WAI-ARIA tab pattern:键盘导航必须 roving tabindex,焦点跟 selection 一起走。
  // 只把焦点移到 selected=true 的那个按钮即可;其他按钮 tabIndex=-1,
  // 用户仍可用 Home/End/方向键继续导航,但 Tab 键不会跑出去。
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  // ← / → 切换 tab,Home/End 跳到首尾 — 标准 ARIA Tab Pattern
  // audit-r111:roving 行为(环绕/单 tab 放行/active 缺失 no-op/detached
  //   focus 兜底)首补用例锁 tests/unit/renderer/components/ui/tabs-keyboard-nav.test.tsx
  //   ,摘守卫/摘 preventDefault/去 ?. 均实证红(路径单行不拆,免逃 r98 扫)。
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const idx = tabs.findIndex((t) => t.id === active);
    if (idx < 0) return;
    let next = idx;
    if (e.key === 'ArrowRight') next = (idx + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else return;
    // audit 2026-09-07:tabs.length === 1 时 ArrowLeft/Right/Home/End 都把
    //   next 算回 idx(=0),与当前相同;旧实现无脑 preventDefault 会吞掉
    //   默认行为(如箭头键在 textarea 里移动光标)。单 tab 列表不需要拦
    //   默认键行为,让上层拿到默认事件。
    if (next === idx) return;
    e.preventDefault();
    const nextId = tabs[next].id;
    onChange(nextId);
    // 等 React 把 selected / tabIndex 切完,再把焦点交给新按钮。
    // 不放在 effect 里 — 那是异步的,会有一次视觉跳动。
    // audit r30 (2026-09-22):HIGH — rAF 异步 race 由 optional chaining 兜底:
    //   tabRefs.current[nextId]?.focus() 在 Tabs 卸载(切换 module)期间执行时
    //   tabRefs.current[nextId] 为 null,no-op 不抛错。事件 handler 内 rAF
    //   无法挂 cleanup,但 cancelled flag 模式(rAF id 跟踪)需 useState 持引用,
    //   收益小、代价大。这里保留原 rAF 写法,依靠 React commit-then-paint 时序
    //   + optional chaining 防 detached focus。ContextMenu.tsx openMenu effect 的 requestAnimationFrame 块
    //   (audit-r103:原引「:267-272」行号已被 r76 删 submenu 150 行踢翻,改语义锚)
    //   同样有 detached focus 风险但无 cleanup —— audit 建议的结构性改造要等
    //   下一次 Tabs 全面重写时一并处理(rAF → useEffect [active])。
    requestAnimationFrame(() => {
      tabRefs.current[nextId]?.focus();
    });
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className="flex items-center gap-px"
    >
      {tabs.map((t) => {
        const selected = active === t.id;
        return (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[t.id] = el;
            }}
            role="tab"
            type="button"
            id={`tab-${t.id}`}
            aria-selected={selected}
            // audit round 14 (2026-09-15):A11Y-004 — 配对 list body 上的
            //   role="tabpanel" + aria-labelledby=tab-{id}。r13 删 aria-controls
            //   是因为没有 panel;r14 在 WorkbenchListPanel 加 tabpanel 后,这里
            //   同步恢复 aria-controls={panel-${id}}。SR rotor / VO+J 可经此
            //   关联 anchor 找到当前 panel。
            aria-controls={`panel-${t.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(t.id)}
            // VSCode 风格:无圆角,选中用 bg-bg-surface + 底部 2px accent 边
            className={clsx(
              'inline-flex items-center gap-1.5 h-7 px-3 text-xs font-medium uppercase tracking-wider transition-colors duration-120 border-b-2 focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent',
              selected
                ? 'bg-bg-surface text-fg border-accent'
                : 'text-fg-secondary hover:text-fg hover:bg-bg-hover/60 border-transparent',
            )}
          >
            {t.icon}
            {t.label}
          </button>
        );
      })}
    </div>
  );
});
