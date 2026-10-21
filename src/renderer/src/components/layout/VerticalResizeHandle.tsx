// VerticalResizeHandle — 工作台竖向分隔条(WorkbenchListPanel / NotesPanel 共用)
//
// 设计动机:
//   WorkbenchListPanel 与 WorkbenchContentPanel 都需要 6px 竖向分隔条,
//   它们共享 useResizablePanel 的 api(width / dragging / onResizeStart / setWidth),
//   但 i18n key / side(决定箭头方向) / min / max 不同。把这部分提到一个组件,
//   后续加更多面板(将来的 DetailPanel 等)直接复用,不再复制粘贴 keydown 逻辑。
//
// 方向约定(鼠标跟手 —— handle 永远在面板的"内侧"):
//   - side='left'  : handle 在面板右沿,向左拖 = 面板收窄(ArrowLeft → width -= step)
//   - side='right' : handle 在面板左沿,向左拖 = 面板加宽(ArrowLeft → width += step)
//
// 测试锚位: tests/unit/renderer/resize-handle-keyboard.test.ts
//   (audit-r229 补齐 15 例)—— 行为级锁定 ± step 方向:渲染真组件断言
//   bumpWidth 收到的符号,并接真 useResizablePanel 断言「按下去面板宽度
//   真的变」+ 被 [min,max] 夹住。
//   (早先草稿写的是「对 src 字面量做 AST 检查」,实际实现改成了行为级 ——
//    AST 只能证字面量形状,证不了「按下去面板真的收窄」。)
import type { ResizablePanelApi } from '../../hooks/useResizablePanel';

const NORMAL_STEP = 10;
const SHIFT_STEP = 50;

// audit 2026-09-08:从 export 改非 export —— 0 外部 caller,只本文件
//   VerticalResizeHandle 引用。WorkbenchContentPanel / WorkbenchListPanel
//   走 JSX 引用,不需要显式 props 类型。
interface VerticalResizeHandleProps {
  api: ResizablePanelApi;
  /** handle 所在 side —— 决定 ArrowLeft / ArrowRight 与 width 的相对方向 */
  side: 'left' | 'right';
  /** aria-valuemin / aria-valuemax / Home / End 跳转目标 */
  min: number;
  max: number;
  /** aria-label 字符串(caller 已经走 i18n,这里只做 string 透传) */
  ariaLabel: string;
}

export function VerticalResizeHandle({
  api,
  side,
  min,
  max,
  ariaLabel,
}: VerticalResizeHandleProps) {
  const { width, unit, dragging, onResizeStart, onResizeReset, setWidth, bumpWidth } = api;
  // 镜像约定:side='right' 时鼠标左移 = 加宽,与 side='left' 相反。
  // 单一变量决定 ± 号,keydown 内不再有分支嵌套,可读性 + 测试锚位都更稳。
  const arrowLeftAddsWidth = side === 'right';
  // audit-r142:把数值宽度格式化成带单位的可读文本 —— aria-valuetext 给 SR 用户
  //   (NVDA / VoiceOver 读出 "320 像素" 而不是干巴巴的 "320"),
  //   title 给鼠标用户原生 tooltip 当发现性 affordance。
  //   单一变量 fmt 拼好,渲染处用两次,避免 px/pct 分支嵌套在两个属性里。
  const fmt = unit === 'pct' ? `${Math.round(width * 100)}%` : `${width} px`;

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      aria-valuetext={fmt}
      aria-label={ariaLabel}
      title={fmt}
      tabIndex={0}
      // r199:pointer 事件(而非 mouse 事件)—— 只有 pointer 事件能
      //   setPointerCapture:拖出窗口再松开时事件仍回到手柄,拖拽不会卡死。
      onPointerDown={onResizeStart}
      onDoubleClick={onResizeReset}
      onKeyDown={(e) => {
        const step = e.shiftKey ? SHIFT_STEP : NORMAL_STEP;
        // bumpWidth(delta) 走 functional updater —— 浏览器 key-repeat 在
        // React 重渲前连发多份 keydown,setWidth(width + step) 会基于同一个
        // 旧 width 反复加,看上去"按了没动";functional updater 让 React
        // 基于当前 state 累加,长按连续生效。
        switch (e.key) {
          case 'ArrowLeft':
            e.preventDefault();
            bumpWidth(arrowLeftAddsWidth ? step : -step);
            break;
          case 'ArrowRight':
            e.preventDefault();
            bumpWidth(arrowLeftAddsWidth ? -step : step);
            break;
          case 'Home':
            e.preventDefault();
            setWidth(min);
            break;
          case 'End':
            e.preventDefault();
            setWidth(max);
            break;
        }
      }}
      // 命中区固定 6px:之前拖拽时在 w-1.5(6px)/ w-2(8px) 之间切,
      // 整个右侧内容区会跟着横移 2px —— 拖一次抖一下,很显眼。
      // hover 高亮改为 group-hover:之前 hover 挂在内部那条 1px 的线上,
      // 指针几乎不可能正好压中,等于 hover 反馈从来没出现过。
      // audit 2026-09-16 r18:H7 — focus-visible 只设 outline-none + bg-accent/20,
      //   键盘 tab 过来后无可见 ring。补 focus-visible:bg-accent/30 + ring 1 让
      //   内部 1px 染色线可见,作为明显的 focus marker。
      className="group flex-shrink-0 w-1.5 cursor-col-resize flex justify-center touch-none focus-visible:outline-none focus-visible:bg-accent/30 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
    >
      <div
        className={`h-full transition-colors duration-120 ${
          dragging
            ? 'w-[2px] bg-accent'
            : 'w-px bg-transparent group-hover:bg-accent group-focus-visible:bg-accent'
        }`}
      />
    </div>
  );
}
