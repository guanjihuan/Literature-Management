// useListboxRove:WAI-ARIA listbox roving 焦点 + aria-activedescendant 模式
//
// 与 useRadioGroup 的关键区别:listbox 接受多个 active option(多选);
// ARIA 标准是 listbox 容器 tabIndex=0(占一个 tab stop),焦点停容器;
// aria-activedescendant 指向当前 active option —— DOM focus 不动,
// 只有"active descendant"虚拟指针移动。
//
// 适用场景:
//   - Virtuoso 虚拟列表:无法把每个 option 都 tab(上千个不可达);
//     aria-activedescendant 让 SR rotor 跟得上。
//   - 单选行为:activeId 跟手 arrow keys,真正"提交选择"由 click / Enter / Space
//     触发(本 hook **不**做 commit —— 见 audit r45 修复)。
//
// 设计选择:
//   - 监听 document 级别的 keydown 而不是 container,因为 SR 用户即使焦点
//     滑出 listbox(罕见),arrow keys 仍要工作 —— 但只在容器包含活动元素时
//     拦截,避免和外部滚动冲突。
//   - 容器 ref 必填。监听器挂一次即常驻;容器尚未 mount / 列表为空时在
//     handler 内 no-op(audit-r73:此前是「containerRef.current 为 null 就不挂
//     监听器」,而 LiteratureList 的 listbox div 是 `sorted.length > 0` 才渲染
//     —— 首帧空列表 mount ⇒ 监听器永远不挂,方向键整会话失效;容器重 mount
//     后旧 el 引用也永久失效。改为 handler 内每次现读 ref)。
//   - 不接 Space/Enter —— 让原生 button/option 处理,避免重复激活。
//
// audit r33 (2026-09-23):deps 收敛 —— 之前 deps 含 activeId + onSelect,每次
//   activeId 变(或 onSelect 引用变,如 NotesList autosave 1.5s 节流每 cycle
//   新 build)effect 重跑,addEventListener / removeEventListener 在 document
//   上每秒 ~2 次 churn。改用 useLatestValue refs,effect 只挂一次,
//   listener 内读 ref.current 永远是最新的 activeId / onActiveChange / items。
//
// audit r45 (2026-10-15):callback 语义重命名 onSelect → onActiveChange。旧名
//   误导消费方把「arrow key 移动」与「commit 选择」混为一谈,NotesList /
//   LibraryList 的 handleActiveById 实际是 setActiveId + scrollToIndex + commit,
//   commit 在 arrow 路径上每次都触发,等价「按一下 ↓ 就改一次右侧 panel」,
//   严重反键盘导航契约。改名强制消费方声明「这只是个 active 变化通知」,
//   commit 由 click / 后续 Enter 处理。契约锁 tests/unit/renderer/hooks/
//   useListboxRove-keyboard-no-commit.test.ts + useListboxRove-listener-stability。

import { useEffect, type RefObject } from 'react';
import { useLatestValue } from './useLatestValue';

interface UseListboxRoveOptions<T extends { id: string }> {
  /** listbox 容器 ref(必须有 tabIndex=0) */
  containerRef: RefObject<HTMLElement | null>;
  /** 列表项 —— 用于循环 wrap 和计算 prev/next */
  items: readonly T[];
  /** 当前 active 项 id(可 null —— 表示"无选择") */
  activeId: string | null;
  /**
   * active descendant 变化时调用 —— **只**通知 focus 移动,不应当 commit 选择。
   * 调用方负责 setActiveId + scrollToIndex 让 DOM 真实存在。
   * 真要 commit(切右侧 panel / 打开文档)由 click / Enter / Space 处理。
   */
  onActiveChange: (id: string) => void;
}

/**
 * WAI-ARIA listbox 键盘导航 hook(单选)。
 * 把监听器挂到 container;ArrowUp/Down 切换 active descendant,
 * Home/End 跳首尾;只发 active 变化通知,不负责 commit。
 */
export function useListboxRove<T extends { id: string }>({
  containerRef,
  items,
  activeId,
  onActiveChange,
}: UseListboxRoveOptions<T>): void {
  // 把变化的引用数据绑成 ref —— effect 不再为它们重跑
  const itemsRef = useLatestValue(items);
  const activeIdRef = useLatestValue(activeId);
  const onActiveChangeRef = useLatestValue(onActiveChange);

  useEffect(() => {
    // audit-r73:containerRef.current 在 handler 内现读,不在 effect 顶层读。
    // deps 全是稳定引用,顶层 early-return 会让「mount 时容器还没渲染」(条件
    // 渲染的 listbox)变成「监听器永不挂载」;现读同时兼容容器重 mount 换新 DOM。
    const onKey = (e: KeyboardEvent) => {
      const el = containerRef.current;
      if (!el) return;
      // 只在焦点位于 listbox 容器(或其 option 子节点)时拦截 —— 避免和
      // 外部搜索框 / 工具栏的 arrow keys 冲突。
      const active = document.activeElement as HTMLElement | null;
      if (!active || (active !== el && !el.contains(active))) return;
      // 0007 侧栏文件夹:inline 重命名/新建 Input 就在 listbox 容器里,方向键
      // 要归文本光标(左/右移字、Esc 取消),不能抢去移动 active descendant。
      // 原契约只涉及容器 option 导航,无测试覆盖「焦点在容器内文本控件」形态。
      if (
        active.tagName === 'INPUT' ||
        active.tagName === 'TEXTAREA' ||
        active.isContentEditable
      ) {
        return;
      }

      const len = itemsRef.current.length;
      if (len === 0) return; // 空列表 no-op(防御性)
      const idx = activeIdRef.current
        ? itemsRef.current.findIndex((t) => t.id === activeIdRef.current)
        : -1;

      let next: number;
      if (e.key === 'ArrowDown') {
        next = idx < 0 ? 0 : (idx + 1) % len;
      } else if (e.key === 'ArrowUp') {
        next = idx < 0 ? len - 1 : (idx - 1 + len) % len;
      } else if (e.key === 'Home') {
        next = 0;
      } else if (e.key === 'End') {
        next = len - 1;
      } else {
        return;
      }
      e.preventDefault();
      onActiveChangeRef.current(itemsRef.current[next].id);
    };

    // capture:true —— 避免 SR / 输入框的 default handler 抢先
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
    };
    // 只跟 containerRef;activeId/items/onActiveChange 走 ref。
    // 三个 *Ref 一并列出:它们由 useLatestValue 内部的 useRef 产出,identity
    // 跨 render 恒定,列进来**不会**让 effect 重挂 —— 但必须列,否则
    // exhaustive-deps 会因「无法证明自定义 hook 返回的是稳定 ref」而报
    // missing dep(见 useLatestValue 头注里那条被实测推翻的说法)。
    // 列出来 = 依赖关系写实,且 future 改成别的实现时 lint 会真的拦一次。
  }, [containerRef, itemsRef, activeIdRef, onActiveChangeRef]);
}
