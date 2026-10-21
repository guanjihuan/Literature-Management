// Overlay — 模态/对话框/抽屉的共享层
//
// 提供所有"打开就挡住整个视口"组件需要的副作用:
//   1. Portal 到 body — 避免 transform/opacity 上下文污染
//   2. body 滚动锁 — 锁住背景滚动,但保留滚动条宽度以避免抖动
//   3. ESC 关闭 — 自动监听 document.keydown;多层并存时只关栈顶
//      (audit-r80 弹层栈;嵌套时的栈顶语义见下方 currentTopLayer 注释)
//   4. 进入模态后焦点移到面板,关闭时还回原焦点
//   5. Tab 焦点陷阱 — 键盘用户 Tab/Shift+Tab 不会跑出面板(同样仅栈顶)
//   6. 遮罩点击关闭 — prop 名 `closeOnBackdrop`,默认 true(组件可关掉;
//      原注写的 `onBackdropClick` 是退役前的旧 prop 名,现已不存在)
//
// 用法:把 Modal/ConfirmDialog 的"打开瞬间的副作用"集中到这里,
//   子组件只关心面板内容(标题/正文/底部按钮)的视觉。
// 行为锁 tests/unit/renderer/components/ui/overlay-effects.test.tsx(audit-r115 登记,
//   audit-r229 补齐 14 例:六项承诺逐条 + 嵌套栈顶 + 栈 API;ContextMenu 侧
//   的跨原语对拍在同文件的「Overlay 栈 API」describe 里)。
import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Z } from '../../lib/z-layers';

interface OverlayProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** 关闭时是否触发 onClose。Confirm 用 true,数据敏感对话框可用 false */
  closeOnBackdrop?: boolean;
  /** 关闭时是否触发 onClose。Info-only 弹窗可关掉 */
  closeOnEscape?: boolean;
  /** 焦点陷阱的"最末位置"开关(默认 true) */
  trapFocus?: boolean;
  /** 外层遮罩额外 className — 用于覆盖背景色/层级等 */
  className?: string;
  // audit round 17 (2026-09-15):A11Y-H3/H4 — 进入时把焦点放到指定 ref 而非空
  //   面板。ConfirmDialog 在 danger=true 时聚焦 Cancel(安全动作);Drawer
  //   聚焦 CloseButton;Modal 可选。若两者都给,initialFocusRef
  //   优先。
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  /** CSS 选择器 —— 找不到 ref 时(向后兼容),用 querySelector 锁定焦点目标 */
  autoFocusSelector?: string;
}

/**
 * 共享的 portal + 副作用容器。children 是中心面板的 React 树,
 * 通常结构是 <div panel>...<div>/div> 之类。
 */
// 打开中的 overlay 栈 — 每个实例挂载时入栈,卸载时出栈。
// Esc / Tab 陷阱只对栈顶生效,否则一次 Esc 会把嵌套的多层弹层一起拆掉。
const overlayStack: symbol[] = [];

// audit-r229 (2026-10-20):**嵌套** Overlay 的栈顶判定。
//
// 事故形态(探针实证,见 tests/unit/renderer/components/ui/overlay-effects.test.tsx
// 「嵌套弹层」用例):Modal 里再开一个 Modal(两层 Overlay 嵌套)时,按一次
// Esc 关闭的是**外层**,里层纹丝不动 —— 恰恰是最外层先消失、看起来像
// 「Esc 没反应」。
//
// 根因:React 的 effect 清理/执行顺序是**子先父后**(commit 阶段自底向上
// flush passive effects),而「栈顶 = 最后入栈」等价于「最后挂载的层」。
// 嵌套时子层先入栈 ⇒ 父层后入栈 ⇒ 父层成了栈顶。但**视觉上**内层是
// 画在外层之上的(portal 容器按渲染顺序追加到 body,内层后追加 ⇒ 盖住
// 外层;所有 Overlay 同一个 z-index,DOM 序即绘制序)。于是「栈顶」与
// 「视觉最上层」被**反转**了。
//
// 修法:不再用「入栈顺序」单独定栈顶,改为**跳过有开着的子弹层的父层**
// —— 从栈顶往下找,第一个「自己没有开着的子弹层」的层才是真栈顶。
//   - 嵌套 [子, 父] ⇒ 父有子弹层被跳过 ⇒ 栈顶 = 子(视觉最上,正确);
//   - 平级 [A, B]   ⇒ 谁都没有子弹层 ⇒ 栈顶 = 后入栈的 B(= 后挂载 =
//     DOM 序更后 = 视觉更上,正确);
//   - ContextMenu(非 Overlay,无 React 父子关系)⇒ 不登记子弹层,行为
//     与修前逐字一致(见 isOverlayLayerTop 的调用方 ContextMenu)。
//
// 父子关系通过 React context 传递(portal 不影响 context 流:context 走
// React 树,不走 DOM 树)。
const openChildren = new Map<symbol, Set<symbol>>();

/** 父层 Overlay 的 id —— 子层用它登记父子关系(audit-r229)。 */
const OverlayParentContext = createContext<symbol | null>(null);

/** 从栈顶往下找第一个「自己没有开着的子弹层」的层。 */
function currentTopLayer(): symbol | undefined {
  for (let i = overlayStack.length - 1; i >= 0; i--) {
    const id = overlayStack[i];
    if (openChildren.has(id)) continue; // 有子弹层 ⇒ 自己不是栈顶
    return id;
  }
  return undefined;
}

/**
 * audit-r80 (2026-10-17) MEDIUM:把栈语义暴露给非 Overlay 的浮层
 * (ContextMenu)。事故形态:右键菜单(z60)开着时 ⌘⇧F 打开搜索面板
 * (Overlay,z50),两者 Esc listener 都挂 document bubble,一次 Esc 两层
 * 同关(stopPropagation 挡不住同节点上的其他 listener)。菜单接入同一
 * 栈后,Esc 永远只关「最后打开的那层」。
 */
export function pushOverlayLayer(id: symbol): void {
  overlayStack.push(id);
}
export function removeOverlayLayer(id: symbol): void {
  const i = overlayStack.lastIndexOf(id);
  if (i !== -1) overlayStack.splice(i, 1);
  openChildren.delete(id);
}
export function isOverlayLayerTop(id: symbol): boolean {
  return currentTopLayer() === id;
}

export function Overlay({
  open,
  onClose,
  children,
  closeOnBackdrop = true,
  closeOnEscape = true,
  trapFocus = true,
  className,
  initialFocusRef,
  autoFocusSelector,
}: OverlayProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const idRef = useRef<symbol>();
  if (!idRef.current) idRef.current = Symbol('overlay');
  // audit-r229:父层 id(React context 传递;portal 不影响 context 流)。
  const parentId = useContext(OverlayParentContext);

  // 0. 入栈/出栈 — 与 closeOnEscape 无关:不可 Esc 关闭的弹层同样要挡住下层
  //   audit-r229:同时向父层登记「我有开着的子弹层」,让 currentTopLayer
  //   能跳过父层(嵌套时栈顶 = 内层,见栈定义处的论证)。
  useEffect(() => {
    if (!open) return;
    const id = idRef.current!;
    overlayStack.push(id);
    if (parentId) {
      let kids = openChildren.get(parentId);
      if (!kids) {
        kids = new Set();
        openChildren.set(parentId, kids);
      }
      kids.add(id);
    }
    return () => {
      if (parentId) {
        const kids = openChildren.get(parentId);
        if (kids) {
          kids.delete(id);
          if (kids.size === 0) openChildren.delete(parentId);
        }
      }
      const i = overlayStack.lastIndexOf(id);
      if (i !== -1) overlayStack.splice(i, 1);
    };
  }, [open, parentId]);

  const isTop = () => currentTopLayer() === idRef.current;

  // 1. ESC 关闭 — 仅栈顶响应
  useEffect(() => {
    if (!open || !closeOnEscape) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isTop()) {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, closeOnEscape, onClose]);

  // 2. body 滚动锁 + 滚动条补偿(避免横向抖动)
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    const prevPaddingRight = document.body.style.paddingRight;
    const scrollbar = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
    document.body.style.overflow = 'hidden';
    if (scrollbar > 0) {
      document.body.style.paddingRight = `${scrollbar}px`;
    }
    return () => {
      document.body.style.overflow = prevOverflow;
      document.body.style.paddingRight = prevPaddingRight;
    };
  }, [open]);

  // 3. 进入后焦点移入 + 关闭后归还
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    // 等面板渲染完再 focus —— initialFocusRef / autoFocusSelector 优先于面板
    //   自身 (panelRef.current.focus 仅作最后兜底)。
    const t = window.setTimeout(() => {
      const explicit =
        initialFocusRef?.current ??
        (autoFocusSelector
          ? panelRef.current?.querySelector<HTMLElement>(autoFocusSelector)
          : null);
      (explicit ?? panelRef.current)?.focus();
    }, 0);
    return () => {
      window.clearTimeout(t);
      // audit-r137:detach 检测 — prev 可能是 keep-alive 已卸载的祖先(典型:
      //   list panel 行内 item 在模态打开期间被卸载),对 detached 节点调
      //   focus() 是静默 no-op,焦点落 document.body,WSI 用户下一步操作失向。
      //   document.body.contains 排除了祖先链不在的节点。
      if (prev && document.body.contains(prev)) {
        prev.focus();
      }
    };
  }, [open, initialFocusRef, autoFocusSelector]);

  // 4. Tab 焦点陷阱
  useEffect(() => {
    if (!open || !trapFocus) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !isTop()) return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !panel.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last || !panel.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, trapFocus]);

  if (!open) return null;

  return createPortal(
    <div
      // VSCode 风格:更深更专注的遮罩 + 去 backdrop-blur(性能 + 更"硬"的视觉)
      className={
        'fixed inset-0 flex items-center justify-center bg-overlay-scrim/65 animate-in fade-in duration-150 ' +
        (className ?? '')
      }
      style={{ zIndex: Z.overlay }}
      onClick={(e) => {
        if (!closeOnBackdrop) return;
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="outline-none focus-visible:ring-1 focus-visible:ring-accent"
      >
        {/* audit-r229:向子层通报「父层是谁」—— 嵌套 Overlay 的栈顶判定靠它
            (context 走 React 树,portal 不影响)。 */}
        <OverlayParentContext.Provider value={idRef.current}>
          {children}
        </OverlayParentContext.Provider>
      </div>
    </div>,
    document.body,
  );
}
