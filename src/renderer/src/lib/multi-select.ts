// 多选点击模式解析 (2026-10-16 file-manager ops) — VS Code 文件管理器语义:
//   Ctrl/Cmd + 击 → 'toggle'(切换该行成员,不动主选中)
//   Shift + 击    → 'range'(anchor → 该行闭区间)
//   其余          → 'single'(单选)
// 抽成纯函数:NotesList handleSelect 的路由逻辑可行为级测试,
// 不依赖 jsdom 渲染 Virtuoso(见 tests/unit/renderer/notes/
// notes-list-multi-select.test.ts)。
export type ClickSelectMode = 'single' | 'toggle' | 'range';

export function resolveClickSelectMode(e: {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): ClickSelectMode {
  // macOS Cmd = metaKey,Win/Linux Ctrl = ctrlKey,语义等价 → mod。
  if (e.ctrlKey || e.metaKey) return 'toggle';
  if (e.shiftKey) return 'range';
  return 'single';
}

// r228:修饰键点击的**路由本体**上收为单一真相源 —— NotesList /
//   LiteratureList 的 handleSelect 此前各写一份 mode 分支,两版一度分叉:
//   文献域的 toggle / range 分支会 setActiveId(让 listbox 本地键盘光标
//   / aria-activedescendant 跟手),**笔记域漏了** ⇒ Ctrl+点击后光标仍停在
//   旧行,紧接着按 F2 会重命名**旧行**而不是刚点的那行(删除键同理落在
//   旧行上)。
//   修法不是「给笔记补一行 setActiveId」(下次还会分叉),而是把路由本体
//   收到这里,两域共用一份 ⇒ 分叉不可能再长出来(同 isReallyGone 上收
//   utils/file-check.ts 的做法)。
//
//   契约(两域完全一致):
//   - toggle(Ctrl/Cmd+击):切多选成员,**不动**主选中(selectedId ⇒ 编辑器
//     不切),但键盘光标跟手(setActiveId);
//   - range(Shift+击):anchor → 该行范围选择,同样不动主选中,光标跟手;
//   - single(普通点击):作用集收成该行(selectOnly)+ 设主选中(select ⇒
//     驱动编辑器 / 阅读区)。**不**调 setActiveId —— 两域的 activeId 都靠
//     「selectedId 变化 → effect 同步」跟随,在这里再写一次属于重复;
//     面板切换(notes 面板 / library 面板)与 listbox 聚焦是域特定的事,
//     留在各自组件里。
export interface ClickSelectRouteActions<TId extends string = string> {
  /** Ctrl/Cmd+击:切多选成员,不动主选中。 */
  toggleSelect: (id: TId) => void;
  /**
   * Shift+击:anchor → 该行范围选择。
   *
   * @param visibleIds 当前**可见**的行 id(按渲染顺序)—— 范围选择的区间口径。
   *   audit-r243:列表是树状 + 过滤 + 自定义排序的,store 数组顺序 ≠ 屏幕
   *   上的行顺序;不传可见序 ⇒ 范围会罩到用户看不见的行上(随后的删除
   *   会把那些行一起删)。
   */
  selectRange: (id: TId, visibleIds?: readonly string[]) => void;
  /** 单击:作用集收成该行(不动主选中)。 */
  selectOnly: (id: TId) => void;
  /** 单击:设主选中(驱动编辑器 / 阅读区)。 */
  select: (id: TId) => void;
  /** listbox 本地键盘光标(aria-activedescendant 绑它)。 */
  setActiveId: (id: TId | null) => void;
}

export function applyClickSelectRoute<TId extends string>(
  mode: ClickSelectMode,
  id: TId,
  actions: ClickSelectRouteActions<TId>,
  /** 当前可见行的 id 序(仅 range 用)。 */
  visibleIds?: readonly string[],
): void {
  if (mode === 'toggle') {
    actions.toggleSelect(id);
    actions.setActiveId(id);
    return;
  }
  if (mode === 'range') {
    actions.selectRange(id, visibleIds);
    actions.setActiveId(id);
    return;
  }
  actions.selectOnly(id);
  actions.select(id);
}

// r193:「多选集合 ∩ 当前列表」—— 两个域共用的**作用集**计算。
//
// 为什么要有它:多选集合(selectedIds)是**用户意图**,列表(items/notes)是
// **磁盘事实**。两者之间会短暂不一致:
//   - 笔记被别处删掉(另一个窗口 / 网盘同步 / 回收站清理);
//   - 搬移后 id 重算(notes 域 id 由 relPath 派生,literature 域 id 由
//     absPath 派生)⇒ 旧 id 变死 id;
//   - 外部改名同理。
// 此时若直接拿 selectedIds 全集去「移入回收站 / 删除」,死 id 会让
// 主进程抛 NOT_FOUND,串行循环**中断** ⇒ 后面真正该删的一条都删不掉,
// 用户只看到一个失败 toast(现象:「选了 5 篇只删了 3 篇还报错」)。
//
// 语义:以**列表顺序**返回仍然活着的成员(与列表渲染顺序一致,和用户
// 看到的「从上到下」吻合);死 id 静默跳过,不报错。
export function liveSelectedIds<T extends { id: string }>(
  items: readonly T[],
  selectedIds: ReadonlySet<string>,
): T[] {
  if (selectedIds.size === 0) return [];
  return items.filter((it) => selectedIds.has(it.id));
}
