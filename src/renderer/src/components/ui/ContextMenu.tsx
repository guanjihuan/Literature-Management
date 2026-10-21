// 右键上下文菜单 - 通用轻量组件
// - 由父组件控制 open / x / y / items;菜单本身只负责渲染与关闭回调
// - 点击菜单项 / Esc / 点击菜单外部 → 触发 onClose
// - 视口边界:超出右/下边界时翻转位置,避免被切掉
// - 支持 separator(水平分割线)
// - 键盘导航:↑/↓ 在菜单项之间移动,Enter / Space 触发,Esc 关闭
// audit-r76 (2026-10-17):删除 submenu 机制(~150 行:SubmenuState / 延迟关闭
//   定时器 / 边界翻转 / → Enter Space 展开 / ← 收起 / aria-haspopup+expanded /
//   ChevronRight / 子菜单 portal)。全套 WAI-ARIA 机制建成以来 src 内零消费者
//   (所有 caller 的 items 均不带 submenu 字段,grep 实证),纯死代码;
//   将来真需要嵌套菜单时按 git 历史恢复比维护零调用方的活机制更便宜。
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { clsx } from '../../lib/clsx';
import { Z } from '../../lib/z-layers';
import type { ContextMenuItem } from '../../lib/context-menu-item';
import { pushOverlayLayer, removeOverlayLayer, isOverlayLayerTop } from './Overlay';

// r232:ContextMenuItem / ContextMenuItemType 下沉到 lib/(纯类型,零运行时),
//   供 hooks/use-sidebar-menus.ts 复用而不必 hooks/ 反向 import components/。
//   这里 re-export,既有 import 写法保持不变。
export type { ContextMenuItem, ContextMenuItemType } from '../../lib/context-menu-item';

// audit 2026-09-08:从 export 改非 export —— 0 外部 caller,只本文件
//   ContextMenu 引用。ContextMenuItem 仍 export —— tests/ 直接 import
//   用作 items: ContextMenuItem[] 类型标注(10+ 处)。
interface ContextMenuProps {
  open: boolean;
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

// 菜单估算尺寸;实际值以 ref 测量为准,但需要这个常量作为兜底
const MENU_ESTIMATED_W = 220;
const VIEWPORT_GUTTER = 4; // 距离视口边界的最小间距

export function ContextMenu({ open, x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // audit-r124:latest-ref —— caller 全部传 inline 箭头(NotesList/
  //   LiteratureList 每次 render 新身份),旧实现把 onClose 放进弹层 effect
  //   的依赖:菜单开着时父组件任何一次重渲染都会拆掉 effect 重跑 →
  //   remove+push 把自家层重新压到栈顶。若期间用户再开了搜索面板/模态
  //   (层 B 在上),churn 后栈变 [B, menu'] → 一次 Esc 关的是下层菜单而非
  //   栈顶 B,LIFO 契约被静默反转。修:effect 依赖收 [open],事件时刻经
  //   ref 取最新 onClose(React 官方 latest-ref 形态,render 期幂等赋值)。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // 渲染后测量尺寸,必要时翻转位置以避免被视口切掉
  useLayoutEffect(() => {
    if (!open) return;
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const overflowRight = x + rect.width + VIEWPORT_GUTTER > vw;
    const overflowBottom = y + rect.height + VIEWPORT_GUTTER > vh;
    setPos({
      left: overflowRight ? Math.max(VIEWPORT_GUTTER, vw - rect.width - VIEWPORT_GUTTER) : x,
      top: overflowBottom ? Math.max(VIEWPORT_GUTTER, vh - rect.height - VIEWPORT_GUTTER) : y,
    });
  }, [open, x, y]);

  // 打开时自动聚焦首项(原生菜单行为)。否则用户必须先按 Tab 进入菜单,
  // ↑/↓ 才会动 — 对键盘 / 屏幕阅读器用户是死路。
  // requestAnimationFrame:等 portal mount 完,菜单项真实可 focus 再调用。
  // audit 2026-09-14 r7:关闭时还原焦点到 trigger —— WAI-ARIA menu pattern 要求
  //   onClose 后焦点回到打开菜单的元素(NoteRow / FileRow),否则 SR / 键盘用户
  //   焦点飘到 document.body,后续操作完全失向。triggerRef 捕到 open 时的
  //   document.activeElement(右键点哪行的那一刻),close 时还原。
  const triggerRef = useRef<Element | null>(null);
  useEffect(() => {
    if (!open) return;
    // 捕获当前焦点元素作为还原目标。注意:右键不会先聚焦 row,所以这里依赖
    // caller 提前把 row 设为 tabIndex=0 + click-time focus()(NotesList /
    // LibraryList 中已对可聚焦 row 做此处理)。fallback 是 document.body,
    // 至少不让 focus 丢到不可知位置。
    triggerRef.current = document.activeElement;
    const id = requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.querySelector<HTMLButtonElement>('button[role="menuitem"]:not([disabled])')?.focus();
    });
    return () => {
      cancelAnimationFrame(id);
      // 关闭时还原 focus 给 trigger(WAI-ARIA menu pattern)。triggerRef.current
      // 可能是 row button(可 focus)或 document.body(不可 focus),这里用
      // optional focus() 调用 —— 不可 focus 元素自然 no-op。
      const trigger = triggerRef.current;
      if (trigger && trigger !== document.body && 'focus' in trigger) {
        try {
          (trigger as HTMLElement).focus();
        } catch {
          /* focus may fail on detached element */
        }
      }
    };
  }, [open]);

  // Esc 关闭 + 外部点击关闭 + 键盘导航(↑/↓/Home/End/Tab)
  useEffect(() => {
    if (!open) return;
    // audit-r80 (2026-10-17) MEDIUM:接入 Overlay 的共享弹层栈 —— 旧实现
    //   Esc 无条件 onClose,与 Overlay 的 document bubble listener 并存,
    //   菜单开着时再开搜索面板/模态,一次 Esc 两层同关(实证:两个
    //   listener 同节点,stopPropagation 无效)。入栈后 Esc 只关栈顶:
    //   菜单后开 → 先关菜单;搜索面板后开 → 先关面板,菜单留给下一次。
    const layerId = Symbol('context-menu');
    pushOverlayLayer(layerId);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!isOverlayLayerTop(layerId)) return;
        onCloseRef.current();
        return;
      }
      // 菜单项是 button,可被原生 Tab 访问 — 这里只处理菜单内的方向键
      const el = ref.current;
      if (!el) return;
      const buttons = Array.from(
        el.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not([disabled])'),
      );
      if (buttons.length === 0) return;
      const currentIdx = buttons.findIndex((b) => b === document.activeElement);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        buttons[(currentIdx + 1 + buttons.length) % buttons.length]?.focus();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        buttons[(currentIdx - 1 + buttons.length) % buttons.length]?.focus();
      } else if (e.key === 'Home') {
        e.preventDefault();
        buttons[0]?.focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        buttons[buttons.length - 1]?.focus();
      } else if (e.key === 'Tab') {
        // WAI-ARIA menu pattern:Tab 不应把焦点带出菜单。
        // 原来没拦,Tab 会跳到菜单背后的页面上,菜单还开着。
        e.preventDefault();
        const delta = e.shiftKey ? -1 : 1;
        buttons[(currentIdx + delta + buttons.length) % buttons.length]?.focus();
      }
    };
    const onPointer = (e: MouseEvent) => {
      const el = ref.current;
      if (el && e.target instanceof Node && !el.contains(e.target)) {
        onCloseRef.current();
      }
    };
    document.addEventListener('keydown', onKey);
    // 用 mousedown 早于 click 触发,避免菜单项 onClick 与外部点击竞态
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
      removeOverlayLayer(layerId);
    };
    // audit-r124:依赖去掉 onClose(见顶部 onCloseRef)—— inline 身份 churn
    //   会重 push 弹层破坏 LIFO,不再需要随 onClose 重挂。
  }, [open]);

  // 滚动/缩放时关闭菜单。菜单是 fixed 定位并且只在打开瞬间量一次位置,
  // 祖先容器一滚动它就会僵在旧视口坐标上,和右键的那一行对不上了。
  // 跟随重算需要记住触发元素,代价大;原生菜单的做法也是直接关掉。
  useEffect(() => {
    if (!open) return;
    const dismiss = () => onClose();
    // capture:true —— 滚动事件不冒泡,必须在捕获阶段才能收到祖先容器的滚动
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [open, onClose]);

  if (!open) return null;

  // 两层结构:外层 ref div 仅作 viewport 定位容器(position:fixed,无 transform),
  // 内层 wrapper 承载视觉 + animate-in menu-pop 动画。历史上拆两层是因为子菜单
  // (fixed 定位)会把带 transform 的祖先当 containing block 而错位;submenu
  // 删除后(audit-r76)结构保留 —— 动画留在内层是无害且已验证的形态。
  return createPortal(
    <div
      ref={ref}
      role="menu"
      data-testid="context-menu"
      // 估算尺寸用作 fallback,layoutEffect 后会被实际测量值替换
      style={{
        position: 'fixed',
        left: pos.left,
        top: pos.top,
        minWidth: MENU_ESTIMATED_W,
        // 菜单需要盖在 Overlay 之上(右键菜单常常在模态打开时使用),但要在 Toast 之下
        zIndex: Z.contextMenu,
      }}
    >
      <div className="bg-bg-surface border border-border-subtle rounded shadow-lg p-1 text-xs animate-in menu-pop">
        {items.map((item) => {
          if (item.type === 'separator') {
            return (
              <div key={item.id} role="separator" className="my-1 border-t border-border-subtle" />
            );
          }
          return (
            <button
              key={item.id}
              role="menuitem"
              type="button"
              disabled={item.disabled}
              onClick={() => {
                if (item.disabled) return;
                item.onSelect?.();
                onClose();
              }}
              className={clsx(
                'w-full text-left px-2 py-1.5 rounded transition-colors duration-120 flex items-center justify-between gap-2',
                item.disabled
                  ? 'text-fg-muted cursor-not-allowed'
                  : 'text-fg hover:bg-bg-hover focus:bg-bg-hover focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent',
              )}
            >
              <span className="truncate flex-1">{item.label}</span>
            </button>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
