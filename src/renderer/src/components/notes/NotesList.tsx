// 笔记列表 — 工作台左侧 tab「笔记」的 body
//
// 形态:
//   ┌─────────────────────────────┐
//   │ 笔记 计数            [＋ 新建] │  ← header(模块名 label 在首行,r56 删 Tabs 后回收)
//   ├─────────────────────────────┤
//   │ 🔍 [搜索框]                   │  ← inline 搜索
//   ├─────────────────────────────┤
//   │ 📝 Title 1                  │
//   │    notes/foo.md · 2h ago    │  ← 笔记行(标题 + 相对路径 + 修改时间)
//   │ 📝 Title 2                  │
//   │    notes/bar.md · 3d ago    │
//   │ ...                         │
//   └─────────────────────────────┘
//
// 设计:
//   - 按 mtime 倒序排列(新 → 旧)
//   - 选中态高亮 + 1px accent 左竖条
//   - 标题优先用 note.title,fallback 到 stripExt(note.filename)
//   - 相对路径 + timeAgo 副标题(走 lib/time 共享格式化)
//   - 行点击 → useNotesStore.select(id);主区 NotesView 切到该笔记
//   - 0007 虚拟文件夹(2026-10-18):文件夹行 / 面包屑 / inline 新建重命名 /
//     拖拽入夹 / 剪切粘贴进当前夹(契约与 LiteratureList 同款,共享
//     hooks/useFolderSidebar + lib/folder-view + lib/folder-dnd)。folder_id
//     是 DB 虚拟归属:移动不碰磁盘与 id,favorites / 编辑器链接不断。
//   - 新建按钮 inline Input —— 简化 UX,不弹 Modal。
//   - 模块名 label「笔记」在 header 首行(V1.7 曾移到 Tabs label,r56 删 Tabs 后回收)。
//
// 数据:
//   - useNotesStore.notes + useNotesStore.selectedId
//
// 注释考古注记(audit-r73):本文件历史注释里出现的「LibraryList」指 r71 已删除
//   的旧组件,仅作决策脉络保留,不代表现网组件;收藏 ★ / chip 过滤自 r72 起由
//   LiteratureList 承担。
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { useTranslation } from 'react-i18next';
import { Download, FolderPlus, NotebookPen, Plus, FileText, Search, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useNotesStore } from '../../store/notes';
import { useWorkspaceStore } from '../../store/workspace';
import { useToast } from '../../lib/toast';
import { confirm } from '../../lib/confirm';
import { DropOverlay } from '../common/DropOverlay';
import { errMsg } from '../../lib/error';
import { createLogger } from '../../lib/logger-client';
import { nextDefaultNewFilename } from '../../utils/note-default-name';
import { applyClickSelectRoute, liveSelectedIds, resolveClickSelectMode } from '../../lib/multi-select';
import { stripExt } from '@shared/path-utils';
import type { DiskFolderNode, StandaloneNoteSummary } from '@shared/types';
import { clsx } from '../../lib/clsx';
import { formatShortcut } from '../../lib/shortcut';
import { folderRowId, sidebarRowDomId } from '../../lib/folder-view';
// r176:左侧栏改**树状** —— 行合成搬到 lib/folder-tree.ts(纯函数,不起 React
//   也能单测)。folder-view 只留底层契约(dirname / 行 id / DOM id 合成)。
import { buildTreeRows, groupItemsByDir, type TreeRow } from '../../lib/folder-tree';
import { FolderCreateRow, FolderRowOption } from '../common/FolderChrome';
import { ROOT_DROP_ID, useDiskFolderSidebar } from '../../hooks/useDiskFolderSidebar';
// r176:api 从 lib/api 取(window.api 的实时 Proxy)—— useFolderSidebar shim
//   下线后不再从 globalThis 偷 api。
import { api } from '../../lib/api';
// fix drag-drop (2026-10-13):见 lib/drop.ts 头注。NotesList 与 LiteratureList 走同一份
//   路径提取(优先 webUtils → File.path 兜底),避免一处升级 Electron 时另一处
//   仍依赖旧 File.path 静默坏掉。
import { classifyDroppedNotesFiles, getDroppedFilePath } from '../../lib/drop';
import { timeAgo } from '../../lib/time';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { EmptyState } from '../ui/chrome';
import { ContextMenu, type ContextMenuItem } from '../ui/ContextMenu';
import { LIST_OVERSCAN_PX } from '../../lib/list-tuning';
import { useListboxRove } from '../../hooks/useListboxRove';
import { useReorderDnd } from '../../hooks/use-reorder-dnd';
import { useListboxKeys } from '../../hooks/use-listbox-keys';
import { useSidebarDropZone } from '../../hooks/use-sidebar-drop-zone';
import { useFolderOps } from '../../hooks/use-folder-ops';
import { useContainerMenuItems, useFolderMenuItems } from '../../hooks/use-sidebar-menus';
// audit-r143 (2026-10-19):侧栏自定义排序 —— REORDER MIME 与 MOVE MIME 并存,
//   reorder 落点由 list 组件算(行中线 = before/after 分界),store 接收
//   reorderByIds(orderedIds) 把新视觉顺序重排成连续 0..N-1(对账 LiteratureList)。
// r177:导入后**不再自动打开**(用户要求「导入文件后不应该马上自动打开」),
//   因此不再需要「搬移落地后的 id」—— 没有选中动作就没有死 id 问题。
//   id 重映射由 store.moveToFolder 内部 applyMoveRemap 负责。

const log = createLogger('NotesList');

export function NotesList() {
  const { t } = useTranslation();
  // v2.0 Phase 4a:大数组 selector 改 useShallow 浅比 — save / NOTES_CHANGED
  //   推送触发 `[...notes]` 新引用,但浅比较元素相同时(例如 NOTES_CHANGED
  //   广播但本地 cache 已是权威版本)父级不重渲;子项 NoteRow 已 React.memo,
  //   即使父级重渲也只有内容真变的那行才走 reconcile。
  // perf r258 更正:上面这段在 r258 之前是**假绿** —— IPC 走 structured clone,
  //   回来的每条都是**新对象** ⇒ useShallow 的逐元素 Object.is 恒为「不等」
  //   ⇒ 这条浅比从来没生效过(每次广播都整表 + 每一行重渲)。r258 起 store 的
  //   load() 做**结构共享**(lib/struct-share.ts):内容没变的条目沿用上一轮
  //   的对象引用 ⇒ 这条浅比才真的能 bail out。
  const notes = useNotesStore(useShallow((s) => s.notes));
  const selectedId = useNotesStore((s) => s.selectedId);
  const select = useNotesStore((s) => s.select);
  const create = useNotesStore((s) => s.create);
  const load = useNotesStore((s) => s.load);
  const trash = useNotesStore((s) => s.trash);
  const showInFolder = useNotesStore((s) => s.showInFolder);
  // 2026-10-16 file-manager ops:多选 + 剪贴板。selectedIds 是文件操作
  //   (剪切/复制/删除)作用集,与驱动编辑器的 selectedId 解耦。
  const selectedIds = useNotesStore((s) => s.selectedIds);
  const clipboard = useNotesStore((s) => s.clipboard);
  const selectOnly = useNotesStore((s) => s.selectOnly);
  const toggleSelect = useNotesStore((s) => s.toggleSelect);
  const selectRange = useNotesStore((s) => s.selectRange);
  const selectMany = useNotesStore((s) => s.selectMany);
  const cutSelection = useNotesStore((s) => s.cut);
  const copySelection = useNotesStore((s) => s.copy);
  const pasteClipboard = useNotesStore((s) => s.paste);
  // r175:去掉 `as any` + 手写签名 cast —— 头注说「moveToFolder 整体下线,
  //   此处留 throw 防止误用」,但 store 里它是有真实实现的(r166 起),而且
  //   手写签名写的是 `Promise<number>`(一个谁也没实现的旧占位形状)。
  //   直接取 store action,签名由 NotesState 单一真相源给出 —— 调用点
  //   自动跟着 store 演进(r175 起返回 idRemap 映射表)。
  const moveToFolder = useNotesStore((s) => s.moveToFolder);
  // audit round 12 (2026-09-15):SILENT-007 — load 失败时显示带 retry 的空态,
  //   与 LibraryList 的 lastScanError 处理对齐。lastError 由 store.load catch
  //   设置,query 为空 + 无 notes + 有 lastError 三者同时命中时显示错误块。
  const lastError = useNotesStore((s) => s.lastError);
  // V1.8 (2026-09):NotesView 改为右侧面板 —— 点笔记要让 active 切到 'notes',
  //   主区才会把 NotesView 拉出来。useWorkspaceStore 直接取方法,引用稳定,
  //   不会让 memo 的 NoteRow 因 onSelect 变化失效。
  const setActive = useWorkspaceStore((s) => s.setActive);
  const requestRenameNote = useWorkspaceStore((s) => s.requestRenameNote);
  const toast = useToast((s) => s.show);
  // 拖入导入 (2026-09-14):从 OS 拖入 .md 文件 → 主进程解析 + 创建笔记。
  const importFromFile = useNotesStore((s) => s.importFromFile);
  // audit-r143:displayOrderById 用浅比即可(每次展开整对象);reorderByIds
  //   是 action 引用,Zustand 保证稳定。
  const displayOrderById = useNotesStore(useShallow((s) => s.displayOrderById));
  const reorderByIds = useNotesStore((s) => s.reorderByIds);
  const [query, setQuery] = useState('');
  // audit r29 (2026-09-21):a11y H4 — NotesList 之前只设 aria-hidden,SR 不读
  //   底层 row,但键盘用户 Tab 仍可 focus 到 row (aria-hidden 不阻止 focus),
  //   进 overlay 文字框后再 Tab 会跳到不可见的 row,误导。与 LibraryList
  //   同款:加 listContainerRef + useEffect 同步 inert 属性,dragenter 期间
  //   focus + AT 都跳过底层,dragleave 才解封。React 18.3 types 不支持 inert
  //   JSX 属性,这里走 ref + DOM setAttribute 绕过 TS,与 LibraryList
  //   (listContainerRef + dragActive effect)同源。
  const listContainerRef = useRef<HTMLDivElement>(null);
  // === 右键菜单状态(audit 2026-09-07:单个 menu state 跨行共享,不要每行挂一个) ===
  // menu.note 持有被右键的 summary,供菜单项 handler 用;null = 菜单关闭。
  // menu.x/y 是 clientX/Y,ContextMenu 内部 useLayoutEffect 自动做视口边界翻转。
  const [menu, setMenu] = useState<{ note: StandaloneNoteSummary; x: number; y: number } | null>(
    null,
  );

  // 触发 load —— 模块进入时确保数据新鲜
  // (订阅 NOTES_CHANGED 推送会持续刷新,但首次 mount 时仍需要 load 一次)
  // audit 2026-09-14:加 .catch —— 之前 `void load()` 吞错,listNotes IPC 失败时
  //   notes 数组空、UI 无 toast、无 trace。错误已由 wrap.ts 记到 main log,
  //   renderer 端这里只补一条 warn 让排查时能在 DevTools 也看到入口点。
  useEffect(() => {
    load().catch((err: unknown) => log.warn('initial load failed', errMsg(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // audit (2026-09-06):⌘N / 菜单 → actions.newNote → workspaceStore.requestNewNote
  //   置位 pendingNewNote。NotesList 挂载时 consume 一次 → 走「先写后命名」
  //   handleCreate(自动用 nextDefaultNewFilename 取 Untitled / Untitled 1 / …,
  //   创建后直接进 body)。之前弹 inline Input 的旧 UX 已删(audit 2026-09-16
  //   audit-r22):研究场景下用户多先有一句话要记,命名反而是负担。
  // 重构 (2026-09-17 v2.0 Phase 1a):订阅 pendingNewNote.version 而非 boolean —
  //   shape 统一为 PendingCommandFields,version tick 才是「request 触发」的真实
  //   信号(booleanshape 也行,但 version 在 string-payload 命令下必备,
  //   用统一 deps 更不易漂移)。
  const pendingNewNoteTick = useWorkspaceStore((s) => s.pendingNewNote.version);
  useEffect(() => {
    // NIT 2026-09-07:effect 内直接走 store.getState().consumeNewNoteRequest()
    //   —— 不依赖闭包,deps 只剩 pendingNewNote tick,lint 不再 disable,意图也更明确
    //   (读最新 store 而非某次 render 时的快照)。
    if (useWorkspaceStore.getState().consumeNewNoteRequest()) void handleCreateRef.current();
  }, [pendingNewNoteTick]);

  // mtime 倒序 → 再叠加搜索(标题 / 文件名 / 路径 / frontmatter,大小写不敏感)
  // audit 2026-09-10:useDeferredValue 让 input value 高优先级即时反映,过滤 + sort
  //   这种 5k 行级派生让 React 18 在浏览器空闲时再算。typing 时不卡。
  const deferredQuery = useDeferredValue(query);
  // audit 2026-09-17 r23 perf M5:deferredQueryRef 转发 — handleCreate /
  //   importFiles 内部读 deferredQuery(判断 scrollToIndex 是否跳过)时若走
  //   闭包,deferredQuery 在搜索 typing 期间持续变 → handleCreate /
  //   importFiles 跟着重建 → handleCreateRef.current / handleDrop 跟着换
  //   → 子组件 memo 失效。改 ref 后 handleCreate / importFiles 稳定,
  //   仅 deferredQueryRef.current 跟着 render 走,与 notesRef 同模式。
  const deferredQueryRef = useRef(deferredQuery);
  deferredQueryRef.current = deferredQuery;
  // audit-r143 (2026-10-19):displayOrderById 升序,未登记项落到 +Infinity 之后。
  //   tie-breaker 走 mtime desc ——「都没自定义过」时仍保持原 mtime 倒序行为,
  //   不让首装用户感觉列表跳了。对账 LiteratureList 同款公式。
  const sorted = useMemo(() => {
    const byDisplayOrder = [...notes].sort((a, b) => {
      const oa = displayOrderById[a.id] ?? Number.POSITIVE_INFINITY;
      const ob = displayOrderById[b.id] ?? Number.POSITIVE_INFINITY;
      if (oa !== ob) return oa - ob;
      return b.mtime - a.mtime;
    });
    const q = deferredQuery.trim().toLowerCase();
    if (!q) return byDisplayOrder;
    return byDisplayOrder.filter((n) => {
      const hay = `${n.title ?? ''}\n${n.filename}\n${n.relPath}`.toLowerCase();
      return hay.includes(q);
    });
  }, [notes, deferredQuery, displayOrderById]);

  // === 0007 虚拟文件夹 → r176 树状:导航态 + 行合成(与 LiteratureList 同款契约)===
  //   r176:列表不再「钻入单层」—— 直接摊开成树:
  //     根的子文件夹 → 展开后接它的子树;同一层里文件夹在前、文件在后。
  //   searchActive → 跨目录全局命中、扁平列表(不渲染文件夹行)。
  const searchActive = deferredQuery.trim().length > 0;
  // r168:drag-into-folder 路径走完 ipc.notesMove 后回调 —— 把 selectedId /
  //   activeNoteFull 跳到新 id,避免编辑器选中项被搬移后读者撞 NOT_FOUND。
  const handleItemsMoved = useCallback(
    (idRemap: Map<string, { id: string; absPath?: string; relPath?: string }>) => {
      useNotesStore.getState().applyMoveRemap(idRemap);
    },
    [],
  );
  const folders = useDiskFolderSidebar({
    kind: 'note',
    searchActive,
    api,
    onItemsMoved: handleItemsMoved,
  });
  // audit-r227:runFolderOp(r173)/ commitFolderEdit(r176)/ pasteTo(0007)
  //   + pasteToTarget(原 handlePaste)已收编进 useFolderOps;唯一分叉 =
  //   log 前缀与 paste 失败 toast 的 i18n key(注入)。
  const { runFolderOp, commitFolderEdit, pasteTo, pasteToTarget } = useFolderOps({
    logTag: 'NotesList',
    pasteFailedKey: 'toast.pasteNoteFailed',
    folders,
    pasteClipboard,
  });
  // audit-r224:reorder 四件套 + 落点指示线 state 收编进 useReorderDnd
  //   (与 LiteratureList 的逐字同构块;行为契约见 hook 头注)。
  //   调用点在 folders / useFolderOps 之后(2026-10-21):跨目录落行的委托
  //   onCrossFolderMove 要用 runFolderOp 包 folders.handleTargetDrop
  //   (与 onFolderDrop 同款包装)。
  const {
    reorderIndicator,
    handleItemReorderDragOver,
    handleItemReorderDragLeave,
    handleItemReorderDrop,
    handleItemReorderDragEnd,
  } = useReorderDnd<StandaloneNoteSummary>({
    kind: 'note',
    getItems: () => useNotesStore.getState().notes,
    displayOrderById,
    reorderByIds,
    // 跨目录 drop 到某一行 = 搬进该行所在目录(根行 = ROOT_DROP_ID)。
    //   事件带 MOVE payload,handleTargetDrop 连多选 batch 一起搬。
    onCrossFolderMove: (dir, e) =>
      runFolderOp(() => folders.handleTargetDrop(e, dir === '' ? ROOT_DROP_ID : dir)),
  });
  // 资源按所属目录分组(dirname(relPath) → 该目录直属的笔记)。
  const itemsByDir = useMemo(() => groupItemsByDir(sorted), [sorted]);
  // r176:树行合成 —— 纯函数在 lib/folder-tree.ts(可不起 React 单测)。
  const rows = useMemo<TreeRow<StandaloneNoteSummary>[]>(
    () =>
      buildTreeRows<StandaloneNoteSummary>({
        childrenByDir: folders.childrenByDir,
        itemsByDir,
        expanded: folders.expanded,
        targetRelPath: folders.targetRelPath,
        searchActive,
        searchItems: sorted,
        // r134:搜索态不挂 input 行 —— 提交后文件夹会落在搜索视图外,
        //   用户眼睁睁看不见(类 r131 newSub 消失 bug);与 mod+Shift+N 入口
        //   一并 gate,前端统一战线。
        pendingInput:
          folders.editing?.mode === 'create' && !searchActive
            ? { parentRelPath: folders.editing.parentRelPath }
            : null,
      }),
    [
      folders.childrenByDir,
      folders.expanded,
      folders.targetRelPath,
      folders.editing,
      itemsByDir,
      sorted,
      searchActive,
    ],
  );
  // 树里当前可见的**文件**(不含文件夹行)—— header 计数 / mod+A 全选用它。
  const visibleItems = useMemo(() => {
    if (searchActive) return sorted;
    const out: StandaloneNoteSummary[] = [];
    for (const row of rows) if (row.rowType === 'item') out.push(row.item);
    return out;
  }, [rows, searchActive, sorted]);
  // header 计数:搜索态 = 全局命中,浏览态 = 树里可见的文件数;total 恒全库。
  const displayCount = visibleItems.length;
  // audit-r243:Shift 范围选择的**区间口径** = 当前可见行的 id 序。
  //   旧实现用 store 数组顺序(全库 mtime 倒序)切区间,列表是树状 + 搜索
  //   过滤的 ⇒ 罩到屏幕上看不见的行(别的夹里的笔记 / 搜索没命中的)⇒
  //   随后的 Delete 把它们一起删掉。
  const visibleIds = useMemo(() => visibleItems.map((n) => n.id), [visibleItems]);

  // perf (2026-09-04):useCallback 稳定 select 引用 —— NoteRow 用 React.memo
  //   后,父级每次 render 都新建的 inline () => handleSelect(n) 会让 memo 失效。
  // audit-r160 B7:listboxRef 提前到 handleSelect 之前 —— B7 修复后 handleSelect
  //   内部 listboxRef.current?.focus() 引用必须先存在(useRef 是稳定对象,值
  //   在调用时读,声明序不影响运行时,但 lint 'no-use-before-define' 会红)。
  //   旧实现声明在 324 行(在 handleSelect 之后),以前 handleSelect 不用 ref
  //   没事,本轮 B7 加 focus() 调用必须提前。useListboxRove 的 onActiveChange
  //   callback(handleActiveById)随之也提前。
  const listboxRef = useRef<HTMLDivElement>(null);
  const handleSelect = useCallback(
    (n: StandaloneNoteSummary, e?: ReactMouseEvent) => {
      // 2026-10-16 file-manager ops:修饰键路由(VS Code 语义)——
      //   Ctrl/Cmd+击 只切多选成员,不动 selectedId(编辑器不切);
      //   Shift+击 走 anchor 范围选择,同样不动 selectedId;
      //   普通点击 = 单选 + 驱动编辑器(原行为)。
      // audit-r228:路由本体上收 lib/multi-select.applyClickSelectRoute
      //   (两域单一真相源)—— 此前文献域 toggle/range 分支跟手
      //   setActiveId(键盘光标 / aria-activedescendant 跟手),笔记域漏了
      //   ⇒ Ctrl+点击后光标停在旧行,接着按 F2 会重命名旧行。
      const mode = e ? resolveClickSelectMode(e) : 'single';
      applyClickSelectRoute(
        mode,
        n.id,
        {
          toggleSelect,
          selectRange,
          selectOnly,
          select,
          setActiveId,
        },
        visibleIds,
      );
      // 主从布局只渲染一个笔记,select(id) 即切换主区内容。body 由 NotesView effect 触发
      //   store.loadFullNote(id) 按需拉。
      // 点笔记同步 setActive('notes') —— 让 WorkbenchContentPanel 把 NotesView 拉到右侧
      //   (并排展示,不再替换 Reader)。
      // 已 active === 'notes' 时跳过 setActive —— zustand shallow equality 会拦截重复写,
      //   但通知订阅者依然有一次无意义的重渲路径。
      if (mode === 'single' && useWorkspaceStore.getState().active !== 'notes') setActive('notes');
      // audit-r160 B7:click 后把焦点搬到 listbox,让后续 Ctrl+X/Ctrl+V
      //   落到 handleListboxKeyDown(用户报「剪切、粘贴不起作用」最常见
      //   复现路径:用户从右侧编辑器点回侧栏,编辑器 contenteditable 抢走
      //   焦点,keydown 不冒泡到 listbox onKeyDown)。listbox 已 focus
      //   时 no-op(idempotent)。
      listboxRef.current?.focus();
    },
    [select, selectOnly, toggleSelect, selectRange, setActive, visibleIds],
  );

  // audit round 17 (2026-09-15):A11Y-M2 — listbox + aria-activedescendant 模式。
  //   键盘导航走 id → handleSelect(等价 click:select + setActive('notes'))。
  //   稳定 callback 让 useListboxRove 的 effect 不在每次 render 都重挂。
  // audit 2026-09-21 audit-r24:listbox-local activeId 与 selectedId 解耦 ——
  //   aria-activedescendant 绑 activeId(键盘 / hover 到的行),Virtuoso 渲染
  //   窗口外的 row 完全 unmount,绑 selectedId 会指向悬空 DOM → SR 报
  //   "missing element"。activeId 变化时 scrollToIndex 让 DOM 真实存在。
  const [activeId, setActiveId] = useState<string | null>(selectedId);
  // selectedId 外部变化(创建 / 删除 / rename 后 store 推过来)同步 activeId,
  //   避免 listbox 显示「虚拟指针指 A,但 selectedId 实际是 B」的歧义。
  useEffect(() => {
    setActiveId(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);
  // audit-r124:幽灵复位,镜像 LiteratureList audit-r73 —— activeId 与
  //   selectedId 解耦(键盘/hover 跟手),搜索过滤或外部删除让 active 行
  //   离开 sorted 后,aria-activedescendant 仍指向 DOM 已不存在的
  //   note-row-<ghost>(SR 读到空)。回落 selectedId(可为 null = 无 active)。
  //   r73 当时只修了文献侧,notes 侧横切核对漏本站(r18 H2 同款教训形态)。
  //   0007:判据 sorted → rows(切文件夹同样让 active 行离开列表)。
  useEffect(() => {
    if (activeId && !rows.some((x) => x.id === activeId)) setActiveId(selectedId);
  }, [rows, activeId, selectedId]);
  // 键盘移动光标 → activeId 跟手 + scrollToIndex 让 DOM 真实存在。**不**
  //   立即 commit 选择(commit 走 click 路径 `onSelect={handleSelect}`,
  //   r45 修复前这里会调 handleSelectById,导致按一下 ↓ 就切右侧 panel,
  //   反键盘导航契约)。
  // audit r45 (2026-10-15):useListboxRove 旧 onSelect prop 改名 onActiveChange
  //   强制消费方声明「这只是个 active 变化通知」;真实 commit 由 row click
  //   / Enter 路径走 `onSelect={handleSelect}` 触发(无中间 id→object 桥)。
  const handleActiveById = useCallback(
    (id: string) => {
      setActiveId(id);
      const idx = rows.findIndex((x) => x.id === id);
      if (idx >= 0) virtuosoRef.current?.scrollToIndex({ index: idx, align: 'center' });
    },
    [rows],
  );
  // audit 2026-09-21 audit-r24:hover 仅更新 activeId(不立即落选,避免鼠标
  //   滑过列表就触发 handleSelect 副作用 — setActive('notes') + 切右侧 panel)。
  const handleNoteHover = useCallback((n: StandaloneNoteSummary) => {
    setActiveId(n.id);
  }, []);
  // 0007:文件夹行 hover 同款 —— activeId 用行 id('folder:' 前缀)。
  // r161+ disk-folder:行 id 派生自 relPath(folderRowId(relPath) →
  //   'folder:<relPath>')。
  const handleFolderHover = useCallback((f: { relPath: string }) => {
    setActiveId(folderRowId(f.relPath));
  }, []);

  // audit round 17 (2026-09-15):A11Y-M2 — listbox 容器 ref,与 LibraryList 同款
  //   模式。role=listbox 在外层包裹 div 上(挂在 listboxRef 同一元素),useListboxRove
  //   用 contains() 判断焦点是否在内来决定是否拦截 arrow keys。
  // audit-r160 B7:listboxRef 已在 handleSelect 之前声明(本行删除),
  //   useListboxRove 用同一引用。
  useListboxRove({
    containerRef: listboxRef,
    items: rows,
    activeId,
    onActiveChange: handleActiveById,
  });

  // audit 2026-09-10:re-entry guard —— 用户连按 ⌘N / 双击 + 按钮时,旧实现
  //   并发跑两次 create(filename) IPC,第二条触发 'duplicate name' 错误 toast,
  //   即便用户只想创建一条。用 in-flight ref 守住,组件 unmount / 重渲染也不会被覆盖。
  // audit 2026-09-16 audit-r22:沿用 —— 新流程「先写后命名」同样需要 ref 守卫
  //   防止连按 ⌘N 提交两次。
  const creatingInFlightRef = useRef(false);
  // audit-r145e (2026-10-19) MED:creatingInFlight state mirror —— ref 同步
  //   守卫无法触发 React 重渲,Button 看不到 IPC 跑期间的状态。补一个 state
  //   与 ref 同步,Button 用 loading={creatingInFlight} 走原语(r143e +
  //   r145d 收口):spinner + aria-busy + 强 disabled 三件套。ref 仍保留
  //   作同步守卫(state setState 异步批处理,即时连按无法用 state 兜底)。
  const [creatingInFlight, setCreatingInFlight] = useState(false);
  // audit 2026-09-16 audit-r22:virtuoso 滚动 ref —— 新建笔记后 scrollToIndex
  //   让用户看到新行(默认 mtime 倒序,新笔记排到第 0 位;但搜索过滤 / 列表顺序
  //   可能让用户看不到)。用 react-virtuoso 的 scrollToIndex API,align='start'
  //   保证顶部对齐。
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  // audit 2026-09-16 audit-r22:pendingNewNote effect 挂在 handleCreate 之前,
  //   不能直接调(闭包旧引用会失效)。用 ref 转发,effect 调 ref.current,每次
  //   render 时把最新 handleCreate 写到 ref.current。比把 effect 移到下面
  //   更清晰:effect 在哪段代码就用哪段代码引用的变量。
  const handleCreateRef = useRef<() => Promise<void>>(async () => {});
  // audit 2026-09-17 audit-r23:notesRef 转发 — autosave 每次 (~1.5s) 替换 notes
  //   数组 → 走 closure 直接用 notes 会让 handleCreate 重建 → handleCreateRef
  //   跟着换。改 ref 后 handleCreate 稳定,仅 notesRef.current 跟着 render 走,
  //   GC 压力收敛(autosave 1.5s × N 笔记循环期间无 callback churn)。
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const handleCreate = useCallback(async () => {
    if (creatingInFlightRef.current) return;
    creatingInFlightRef.current = true;
    // audit-r145e:state 同步 + Button loading 走原语。
    setCreatingInFlight(true);
    try {
      // audit 2026-09-16 audit-r22:「先写后命名」—— 直接 nextDefaultNewFilename
      //   在已有 notes 列表里找首个不冲突的「未命名 / 未命名 1 / 未命名 2 ...」
      //   (默认 i18n 文案由 defaultNewFilename 提供,en-US 走 "Untitled")。
      //   store.create 内部还有 3 次 IPC race retry(notes 数组与主进程 IPC
      //   之间 10-50ms 推送延迟),这里拿到的 base 撞了 IPC 内也还会被 retry
      //   解决。
      const filename = nextDefaultNewFilename(notesRef.current, t('notes.defaultNewFilename'));
      // r176:新笔记落在**当前落点文件夹**(targetRelPath,null = 根)——
      //   树状后不再有「钻入到的目录」这回事,落点 = 用户最后点过的文件夹。
      //   搜索态下文件夹行虽隐藏,落点仍在,语义 = 「在落点新建」,与 mod+V 一致。
      const n = await create(filename, folders.targetRelPath);
      select(n.id);
      if (useWorkspaceStore.getState().active !== 'notes') setActive('notes');
      // audit 2026-09-16 audit-r22:NotesView consume pendingFocusNoteId 后会
      //   把 activeNoteFull 切到该 id + 透传 initialFocus='body' 给
      //   StandaloneNoteEditorCore,MarkdownEditor 拿到 autoFocusToken 后 focus
      //   contentDOM。这里只 set flag,真 focus 在 NotesView 异步完成 activeNoteFull
      //   加载后发生。
      useWorkspaceStore.getState().requestFocusNote(n.id);
      // 滚到新笔记行(virtuoso)。新笔记 mtime 最新、按 mtime 倒序必然排第 0,
      //   无需 findIndex(闭包 sorted 是 render 时快照,await 之后仍 stale,
      //   findIndex 必然返 -1,纯浪费)。
      // audit 2026-09-17 audit-r23 M1:搜索激活时不滚 —— deferredQuery 非空时
      //   filtered list 不含新笔记(全文匹配未命中),scrollToIndex(0) 滚到首个
      //   旧匹配项而非新笔记,误导用户。跳过让搜索态保持稳定,toast「已创建
      //   Untitled.md」已告知用户;清 search 后新笔记自然出现在顶。
      //   读 deferredQueryRef 而非闭包:见 deferredQueryRef 注释(M5 收敛 GC)。
      if (!deferredQueryRef.current.trim()) {
        virtuosoRef.current?.scrollToIndex({ index: 0, align: 'start', behavior: 'smooth' });
      }
      toast({ type: 'info', message: t('notes.toastCreatedDefault', { name: n.filename }) });
    } catch (err: unknown) {
      log.error('NotesList create note failed', err);
      toast({ type: 'error', message: t('toast.createNoteFailed', { msg: errMsg(err) }) });
    } finally {
      creatingInFlightRef.current = false;
      // audit-r145e:state 同步重置 —— 必须与 ref 同步,否则 finally 异常路径
      //   会让 Button 卡在 loading 态永远不退出。
      setCreatingInFlight(false);
    }
  }, [create, select, setActive, toast, t, folders.targetRelPath]);
  // audit 2026-09-16 audit-r22:render 期同步 ref —— pendingNewNote effect 在
  //   handleCreate 上方,需通过 ref 转发调最新版本。每次 render 都覆盖引用,
  //   effect 只在 pendingNewNote 变化时跑,拿到的是那一刻的 handleCreate。
  handleCreateRef.current = handleCreate;

  // === 右键菜单 handlers (audit 2026-09-07):三选 rename / showInFolder / delete ===
  // 重命名走 store flag → NotesView 弹 Modal(避免 NotesList 复制一份 rename UI);
  // 删除走 lib/confirm 的 Promise dialog;show-in-folder 直接调 store action。
  const handleRenameFromMenu = useCallback(() => {
    if (!menu) return;
    // 跨 tab 兜底:active 不一定是 'notes'(可能用户在 library tab 时右键笔记)。
    // 切到 notes + 通过 store flag 通知 NotesView 弹 Modal。
    if (useWorkspaceStore.getState().active !== 'notes') setActive('notes');
    // 同时把 selectedId 设到右键的这条 —— 用户右键后立刻看到 Modal,选中的
    // 笔记也对得上。如果已经是同一条 selectedId,store setState shallow
    // equality 拦截,无副作用。
    select(menu.note.id);
    requestRenameNote(menu.note.id);
  }, [menu, setActive, select, requestRenameNote]);

  const handleShowInFolderFromMenu = useCallback(async () => {
    if (!menu) return;
    try {
      await showInFolder(menu.note.id);
    } catch (err: unknown) {
      log.error('NotesList showInFolder failed', err);
      toast({ type: 'error', message: t('toast.showInFolderFailed', { msg: errMsg(err) }) });
    }
  }, [menu, showInFolder, toast, t]);

  // 2026-10-16 file-manager ops:删除改走系统回收站 + 作用于整个多选集合
  //   (菜单「移入回收站」与 Delete 键共用)。右键打开时已保证 menu.note ∈
  //   selectedIds(见 openContextMenuForRow 的 selectOnly 兜底)。
  // r193:**只对「列表里还活着」的 id 动手**(与 literature 侧
  //   handleDeleteSelection 同款:st.items.filter(r => selectedIds.has(r.id)))。
  //   旧实现直接取 selectedIds 全集 —— 只要集合里混进一个死 id(刚被删 /
  //   被别的窗口删 / 搬移后 id 变了),trash() 就在它上面抛 NOT_FOUND,
  //   **串行循环中断 ⇒ 后面真正该删的笔记一条都删不掉**,用户只看到一个
  //   「移入回收站失败」toast,现象是「选了 5 篇只删了 3 篇还报错」。
  //   与 literature 侧对齐后,死 id 被静默跳过,活着的照删。
  const handleTrashSelection = useCallback(async () => {
    const st = useNotesStore.getState();
    const ids = liveSelectedIds(st.notes, st.selectedIds).map((n) => n.id);
    if (ids.length === 0) return;
    let title: string;
    if (ids.length > 1) {
      title = t('notes.trashConfirmTitleMulti', { count: ids.length });
    } else {
      const n = st.notes.find((x) => x.id === ids[0]);
      title = t('notes.trashConfirmTitle', { title: n?.title ?? stripExt(n?.filename ?? '') });
    }
    const ok = await confirm({
      title,
      description: t('notes.trashConfirmDesc'),
      confirmLabel: t('notes.trashConfirmLabel'),
      danger: true,
    });
    if (!ok) return;
    try {
      // 串行而非 Promise.all:store.trash 内部有 load(),并发会互相踩
      //   notesCache;且失败时前面的已删、后面的还在,语义清晰可重试。
      for (const id of ids) {
        await trash(id);
      }
      toast({ type: 'success', message: t('toast.trashNoteSuccess') });
    } catch (err: unknown) {
      log.error('NotesList trash selection failed', err);
      toast({ type: 'error', message: t('toast.trashNoteFailed', { msg: errMsg(err) }) });
    }
  }, [trash, toast, t]);

  // audit-r227:pasteTo / pasteToTarget(原组件内 handlePaste)已收编进 useFolderOps。

  // === 列表快捷键(VS Code 语义,与 LiteratureList 同款):mod+C/X 作用于
  //   多选,mod+V 粘贴进当前夹,mod+A 全选当前可视项,mod+Shift+N 新建文件夹,
  //   F2 重命名 active 文件夹行,Delete(夹 → 删夹;笔记 → 移入回收站)。
  //   挂在 listbox 容器上:搜索框 / 编辑器在容器外,天然输入焦点隔离;容器内
  //   inline 文件夹 Input 持焦时整段让行(Enter/Esc 归输入框,方向键由
  //   useListboxRove 同款 gate 让行)。===
  const handleListboxKeyDown = useListboxKeys<StandaloneNoteSummary>({
    rows,
    activeId,
    visibleItems,
    clipboard,
    searchActive,
    folders,
    copySelection,
    cutSelection,
    // audit-r225:两域 mod+V 落点解析不同 —— notes 走 pasteToTarget(内部
    //   pasteTo(folders.targetRelPath)),lit 直接 pasteTo(targetRelPath)。
    onPasteItems: pasteToTarget,
    runFolderOp,
    selectMany,
    onDeleteSelection: handleTrashSelection,
    handleSelect,
    handleActiveById,
    // r134:F2 在笔记行 = 重命名(文献域不传 onRenameItem,F2 只处理文件夹)。
    onRenameItem: (id) => {
      if (useWorkspaceStore.getState().active !== 'notes') setActive('notes');
      select(id);
      requestRenameNote(id);
    },
  });

  // === 右键菜单 item 列表(audit 2026-09-07:删除与安全操作之间用 separator 视觉分组) ===
  // 2026-10-16 file-manager ops:
  //   - 多选(menu.note ∈ selectedIds 且 size>1):Cut / Copy / (Paste) / Trash N
  //     —— Rename / ShowInFolder 是单选语义,多选时不出(VS Code 同款)。
  //   - 单选:Rename / Cut / Copy / (Paste) / ShowInFolder / Trash。
  //   - Paste 只在 clipboard 非空时出现(in-memory,重启即丢)。
  const isMultiSelectMenu = menu !== null && selectedIds.size > 1 && selectedIds.has(menu.note.id);
  const menuItems = useMemo<ContextMenuItem[]>(() => {
    if (!menu) return [];
    const items: ContextMenuItem[] = [];
    if (!isMultiSelectMenu) {
      items.push({
        id: 'rename',
        label: t('notes.contextRename'),
        onSelect: () => handleRenameFromMenu(),
      });
    }
    items.push(
      { id: 'cut', label: t('notes.contextCut'), onSelect: () => cutSelection() },
      { id: 'copy', label: t('notes.contextCopy'), onSelect: () => copySelection() },
    );
    if (clipboard !== null) {
      items.push({
        id: 'paste',
        label: t('notes.contextPaste'),
        onSelect: () => void pasteToTarget(),
      });
    }
    if (!isMultiSelectMenu) {
      items.push({
        id: 'showInFolder',
        label: t('notes.contextShowInFolder'),
        onSelect: () => void handleShowInFolderFromMenu(),
      });
    }
    items.push({ id: 'sep1', type: 'separator' });
    items.push({
      id: 'trash',
      label: t('notes.contextTrash'),
      onSelect: () => void handleTrashSelection(),
    });
    return items;
  }, [
    menu,
    isMultiSelectMenu,
    clipboard,
    t,
    handleRenameFromMenu,
    handleShowInFolderFromMenu,
    cutSelection,
    copySelection,
    pasteToTarget,
    handleTrashSelection,
  ]);

  // audit-r232:文件夹行菜单 + 空白区菜单两段逐字同构块已收编进
  //   hooks/use-sidebar-menus.ts(两域单一真相源,同 r224-r227 收编法);
  //   本域只注入「空白区首项」(笔记=新建笔记)与「粘贴项 label key」。
  const folderMenuItems = useFolderMenuItems({ folders, clipboard, pasteTo, runFolderOp });
  const containerMenuItems = useContainerMenuItems({
    folders,
    clipboard,
    pasteToTarget,
    runFolderOp,
    searchActive,
    visibleItems,
    primaryItem: { id: 'newNote', labelKey: 'notes.listEmptyAction', onSelect: handleCreate },
    pasteLabelKey: 'notes.contextPaste',
    selectMany,
  });

  // === 空白区域菜单(audit-r131)===
  //   挂在列表 wrapper 的 onContextMenu:资源行 / 文件夹行右键都已
  //   stopPropagation,冒泡到这里 = 空白(含空态 —— 空文件夹里也必须能
  //   粘贴,这是「剪切后无处可粘」报障的本体)。入口:新建笔记 / 新建
  //   文件夹 / 粘贴(笔记剪贴板)/ 粘贴(文件夹剪贴板)/ 全选。
  const [containerMenu, setContainerMenu] = useState<{ x: number; y: number } | null>(null);
  const handleContainerContextMenu = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    setContainerMenu({ x: e.clientX, y: e.clientY });
  }, []);

  // audit-r226:wrapper 级 DnD 落点三件套(空白区拖入 = 落根 ROOT_DROP_ID,
  //   gated on isInternalDrag)已收编进 useSidebarDropZone,handler 由下方
  //   解构提供;r134/r176 语义注释见 hook 头注。


  // 稳定 callback —— NoteRow memo 依赖。锁住引用后,NoteRow 才不会因父级
  // 重渲换 inline 箭头而失效 memo,5000 行虚拟滚动场景的关键优化点。
  // onContextMenu 拿到的是行事件(可能 path-event),这里只读 clientX/Y。
  const openContextMenuForRow = useCallback(
    (n: StandaloneNoteSummary, e: ReactMouseEvent) => {
      // preventDefault 屏蔽浏览器原生菜单,onMouseDown 用 mousedown 早于 click
      // 关闭(ContextMenu 内部 effect 已经处理外部点击,这里主要防默认菜单)。
      e.preventDefault();
      e.stopPropagation();
      // 2026-10-16 file-manager ops:右键未选中行 → 先收成单选(VS Code
      //   语义);右键已在多选内的行 → 保留多选,菜单走批量形态。
      if (!useNotesStore.getState().selectedIds.has(n.id)) {
        selectOnly(n.id);
      }
      setMenu({ note: n, x: e.clientX, y: e.clientY });
    },
    [selectOnly],
  );
  // audit r29 (2026-09-21):a11y H6 — 把合成坐标路径抽出独立 helper,
  //   不再 `as unknown as React.MouseEvent` 把 {clientX,clientY} 当作整个
  //   MouseEvent 糊弄类型系统。原合成事件丢了 preventDefault / stopPropagation /
  //   nativeEvent,任何后续维护若在 openContextMenuForRow 调这些方法都会 silent
  //   crash(找不到方法)。抽 helper 后合成路径不再谎称是 React.MouseEvent。
  const openContextMenuAt = useCallback((n: StandaloneNoteSummary, x: number, y: number) => {
    setMenu({ note: n, x, y });
  }, []);
  // 0007:拖拽起点 —— 多选成员被拖 = 整组进 payload(按 notes 顺序);单选 =
  //   仅该 id。自定义 MIME ≠ 'Files',import overlay / drop 链路不会被触发。
  const handleItemDragStart = useCallback(
    (n: StandaloneNoteSummary, e: ReactDragEvent) => {
      const st = useNotesStore.getState();
      const ids =
        st.selectedIds.size > 1 && st.selectedIds.has(n.id)
          ? st.notes.filter((x) => st.selectedIds.has(x.id)).map((x) => x.id)
          : [n.id];
      folders.startItemsDrag(ids, e);
    },
    [folders],
  );

  // audit-r224:reorder 拖拽四件套(dragOver/dragLeave/drop/dragEnd)+
  //   落点指示线 state 已收编进 hooks/use-reorder-dnd.ts(与 LiteratureList
  //   的逐字同构块);dragstart 仍由上方 handleItemDragStart →
  //   folders.startItemsDrag(同时投递 MOVE + REORDER)一次完成。

  // audit-r136 (2026-10-19):FolderRowOption 现在接 (id, e) 二参,caller 必须
  //   useCallback 稳定,否则父级 inline lambda 每帧重建 → memo 失效 →
  //   setDropHot 60Hz 拖拽整树重渲 → Virtuoso 可见行每帧重渲 → 主线程耗尽
  //   → 拖拽卡顿(同 LiteratureList,见该文件同款注)。
  //   r176:依赖从「整个 folders 对象」收窄到**具体函数** —— folders 对象
  //   身份随 dropHot / editing / 展开态变化,挂在它上面等于每次拖拽热区
  //   变化都重建行回调,memo 全废。hook 内这些函数本身是稳定 useCallback。
  /* eslint-disable react-hooks/exhaustive-deps --
     r176:这 8 个回调都只调 folders 上的**单个方法**,依赖已窄化到该方法。
     exhaustive-deps 的告警是「调用成员函数必须把基对象 folders 整个列进
     deps」—— 但 folders 身份随 dropHot / expanded / editing / childrenByDir
     变化(hook 返回值是 useMemo),挂它 = 每次拖拽热区移动都重建全部行回调
     → FolderRowOption 的 memo 全废 → 60Hz 整树重渲(audit-r136 同款坑)。
     窄化后的 deps(folders.xxx)才是精确依赖:这些方法在 hook 内都是
     useCallback,deps 只含 kind / api / 稳定回调 → 身份跨渲染不变。 */
  const onFolderActivate = useCallback(
    // r176:点文件夹行 = 设为落点 + 切换展开(树里没有「钻入」)。
    (fo: DiskFolderNode) => folders.activateFolder(fo.relPath),
    [folders.activateFolder],
  );
  const onFolderContextMenu = useCallback(
    // r174:openFolderContextMenu 收的是**坐标**(x, y),此前这里把整个
    //   MouseEvent 当 x 传进去、y 落 undefined —— 菜单会以 NaN 坐标弹出
    //   (定位不到屏幕内,用户看着像「右键没反应」)。改传 clientX/clientY。
    (fo: DiskFolderNode, e: ReactMouseEvent) =>
      folders.openFolderContextMenu(fo, e.clientX, e.clientY),
    [folders.openFolderContextMenu],
  );
  const onFolderContextMenuAt = useCallback(
    (fo: DiskFolderNode, x: number, y: number) =>
      folders.setFolderMenu({ folder: fo, x, y }),
    [folders.setFolderMenu],
  );
  const onFolderDragStart = useCallback(
    (fo: DiskFolderNode, e: ReactDragEvent) => folders.startFolderDrag(fo, e),
    [folders.startFolderDrag],
  );
  const onFolderDragOver = useCallback(
    (id: string, e: ReactDragEvent) => folders.handleTargetDragOver(e, id),
    [folders.handleTargetDragOver],
  );
  const onFolderDragLeave = useCallback(
    (id: string, e: ReactDragEvent) => folders.handleTargetDragLeave(e, id),
    [folders.handleTargetDragLeave],
  );
  const onFolderDrop = useCallback(
    (id: string, e: ReactDragEvent) => runFolderOp(() => folders.handleTargetDrop(e, id)),
    [folders.handleTargetDrop, runFolderOp],
  );
  /* eslint-enable react-hooks/exhaustive-deps */

  // === 拖入导入 (2026-09-14) ===
  // audit-r226:dragOver/Enter/Leave/Drop 四件套 + overlay 计数状态
  //   + inert effect 已收编进 useSidebarDropZone;本组件只留域特定的
  //   importFiles(.md 分类 + IPC),由下方解构接回 handler。

  // audit 2026-09-14 r7:file picker helper —— 与 LibraryList handleFilePickerPaths
  //   同模式,把 File[] → importFromFile + toast。文件 picker / drop 共用。
  const importFiles = useCallback(
    async (files: FileList | File[]) => {
      const dropped = Array.from(files);
      if (dropped.length === 0) {
        toast({ type: 'info', message: t('toast.importNoFile') });
        return;
      }
      // 后缀预判(大小写不敏感):非 .md 文件直接 toast 拒绝。
      // fix drag-drop (2026-10-13):用 classifyDroppedNotesFiles 替代内联
      //   `getDroppedFilePath(f).length === 0` 判定。原写法把「无路径」与
      //   「非 .md」塞进同一个 rejectedNames,UI 报「仅支持 .md 文件」话术
      //   完全掩盖了根因 —— 用户拖入合法 .md 但 path 解析失败(Electron 32+
      //   f.path 移除 / webUtils 也没拿到)时看不到「无路径」提示,运维难以
      //   区分。helper 把两类分开:
      //     - noPathNames     → notes.dropNoPath toast (Electron drag-drop 链路问题)
      //     - invalidTypeNames → notes.dropInvalidType toast (后缀问题)
      //     - paths          → 进 importFromFile 循环
      // audit r37 (2026-10-13):helper 抽到 src/renderer/src/lib/drop.ts,
      //   与 collectDroppedPaths (LibraryList) 共享同一份 webUtils + f.path
      //   兜底语义,锁定「无路径」永远独立成桶 —— 配 tests/unit/renderer/lib/drop.test.ts
      //   的 classifyDroppedNotesFiles describe 块做反向 guard test(audit-r229 补齐)。
      const { paths, invalidTypeNames, noPathNames } = classifyDroppedNotesFiles(dropped);
      if (invalidTypeNames.length > 0) {
        const preview = invalidTypeNames.slice(0, 3).join(', ');
        const more = invalidTypeNames.length > 3 ? ` (+${invalidTypeNames.length - 3})` : '';
        toast({
          type: 'error',
          message: t('notes.dropInvalidType', { name: `${preview}${more}` }),
          duration: 5000,
        });
      }
      if (noPathNames.length > 0) {
        const preview = noPathNames.slice(0, 3).join(', ');
        const more = noPathNames.length > 3 ? ` (+${noPathNames.length - 3})` : '';
        toast({
          // 与 LibraryList handleFilePickerPaths 的 toast.importNoPath 同方向
          // (renderer 没法派生 OS 路径 → Electron drag-drop 链路问题),但本
          // 场景只触发于 .md 文件,所以走 notes.* 命名空间更贴切,与上方
          //   dropInvalidType 视觉对齐。用户看到这条说明 f.path 在他们的
          //   Electron 版本上失效,且 webUtils 也没拿到 —— 升级 Electron /
          //   改用菜单 importFile 路径可解决。
          type: 'error',
          message: t('notes.dropNoPath', { name: `${preview}${more}` }),
          duration: 6000,
        });
      }
      if (paths.length === 0) return;

      let copied = 0;
      const failed: string[] = [];
      // audit 2026-09-16 r21:M15 — 主进程 frontmatter 解析失败时仍把笔记
      //   降级导入(全文当 body),但带 warnings。UI 提示「导入成功但有
      //   警告」,否则用户不知道 frontmatter 为什么没生效。
      const warningMessages: string[] = [];
      // audit 2026-09-16 audit-r22:P3 — 收集本次导入创建的 note ids,循环
      //   结束后 active 最后一条(macOS Finder 行为:多文件 drop 最后一条 active)。
      //   不加 option 时弹「确认覆盖」对话框是糟糕体验;默认就是「替代式导入」,
      //   与 macOS Finder drop 一致。
      const createdIds: string[] = [];
      // helper 已把 path 提取 / 后缀过滤一并做完,这里直接消费 paths[]。
      // 关联回原始 file.name(用于错误 toast 详情显示)—— classifyDroppedNotesFiles
      //   内部按 dropped 顺序遍历并保留 paths 顺序,所以 dropped 同下标就是
      //   这条 path 对应的源 File。但 helper 不返回 names,这里手动配对更稳:
      //   重新遍历一遍,把 path → 源 file.name 一一对应。
      const nameByPath = new Map<string, string>();
      for (const f of dropped) {
        const lower = f.name.toLowerCase();
        if (!(lower.endsWith('.md') || lower.endsWith('.markdown'))) continue;
        // helper 已经把没有 OS 路径的 .md 排除掉了,这里直接调一次同款
        // 提取以拿到对应 path → name 映射(避免维护两份顺序假设)。
        const p = getDroppedFilePath(f);
        if (p && !nameByPath.has(p)) nameByPath.set(p, f.name);
      }
      for (const filePath of paths) {
        const fName = nameByPath.get(filePath) ?? filePath;
        try {
          const r = await importFromFile(filePath);
          copied += r.copied;
          if (r.createdIds) createdIds.push(...r.createdIds);
          if (r.warnings)
            warningMessages.push(...r.warnings.map((w: string) => `${fName}: ${w}`));
        } catch (err: unknown) {
          log.warn('import note from file failed', filePath, err);
          failed.push(`${fName}: ${errMsg(err)}`);
        }
      }
      // 0007:导入产物落进当前钻入文件夹(importNoteFromFile IPC 链不接
      //   folderId —— 与 literature 侧不同,这里走「导入后 moveResources」,
      //   等价一次移动;移动失败不影响导入结果本身,单独 toast)。
      //
      // r177:导入后**不再自动打开**。旧行为(audit-r22 引入的 macOS Finder
      //   风格)会在导入成功后 select(最后一条)+setActive('notes')
      //   +requestFocusNote —— 把用户正在读的笔记顶掉、光标丢进 body,
      //   读一半的内容被强制切走;用户要求「导入文件后不应该马上自动打开」。
      //   现在只做「搬移 + toast + 列表滚到新行」,编辑器保持原样:
      //   要打开,自己点那一行。
      //
      //   搬移仍会让资源 id 重算(notes id 由 relPath 派生)—— 但重映射由
      //   store.moveToFolder 内部 applyMoveRemap 负责(成功/部分失败两条
      //   路都刷 selectedId / activeNoteFull),这里不再自己算一遍落地 id:
      //   没有选中动作,就没有「选到死 id」的问题。
      if (createdIds.length > 0 && folders.targetRelPath !== null) {
        try {
          await moveToFolder(createdIds, folders.targetRelPath);
        } catch (err: unknown) {
          log.warn('move imported notes into folder failed', errMsg(err));
          toast({
            type: 'error',
            message: t('folders.moveItemsFailedToast', { msg: errMsg(err) }),
          });
        }
      }
      if (copied > 0) {
        toast({
          type: 'success',
          message: t('toast.importSuccess', { count: copied }),
        });
        // 滚到新行(新笔记 mtime 最新,按 mtime 倒序必排第 0,无需 findIndex)
        //   —— 只是让用户看得见落点,不选中、不打开。
        // audit 2026-09-17 audit-r23 M1:搜索激活时不滚 —— 与 handleCreate
        //   末尾同款 guard(见 line 204 注释),filtered list 不含新笔记时
        //   scrollToIndex(0) 会滚到错位置。
        if (!deferredQueryRef.current.trim()) {
          virtuosoRef.current?.scrollToIndex({ index: 0, align: 'start', behavior: 'smooth' });
        }
      }
      // audit 2026-09-16 r21:M15 — 软失败提示(导入成功但 frontmatter 警告)
      //   走 warning type,时长 6s,前 3 条避免 toast 撑爆。
      if (warningMessages.length > 0) {
        toast({
          type: 'warning',
          message: t('toast.importNoteWarn', {
            msgs: warningMessages.slice(0, 3).join('\n'),
          }),
          duration: 6000,
        });
      }
      if (failed.length > 0) {
        toast({
          type: 'error',
          // audit-r73:模板占位符是 {count} / {msgs}(zh/en locales 同名),此前
          //   传的是 { msg } —— 两个占位符都没填上,用户看到裸的 "{count} 个文件
          //   导入失败:\n{msgs}"。契约锁 tests/unit/i18n/placeholder-contract.test.ts。
          message: t('toast.importNoteFailed', {
            count: failed.length,
            msgs: failed.slice(0, 3).join('\n'),
          }),
          duration: 6000,
        });
      }
    },
    [importFromFile, toast, t, moveToFolder, folders.targetRelPath],
  );



  // audit-r226:落点区 DnD 全家桶(OS 文件导入链 + 内部 drag 容器落点 +
  //   hidden file picker + inert 同步 + dragActive 覆盖层状态)收编进
  //   useSidebarDropZone —— 两域逐字同构块;行为契约见 hook 头注。
  const {
    dragActive,
    filePickerRef,
    handleDragOver,
    handleDragEnter,
    handleDragLeave,
    handleDrop,
    handleContainerDragOver,
    handleContainerDragLeave,
    handleContainerDrop,
    triggerFilePicker,
    onFilePickerChange,
  } = useSidebarDropZone({ folders, runFolderOp, listContainerRef, importFiles });

  // audit-r136 (2026-10-19):Virtuoso itemContent 锁稳定引用 —— 行内本来是
  //   inline `(_index, row) => {...}` 闭包,父级任一 state 变化都换新函数引用
  //   → Virtuoso 看见 itemContent 变化就重渲所有可见 row;与「用 useCallback
  //   锁 callback 给 FolderRowOption」配对完成 memo 闭包(同 LiteratureList)。
  const itemContent = useCallback(
    (_index: number, row: TreeRow<StandaloneNoteSummary>) => {
      if (row.rowType === 'folder') {
        const f = row.folder;
        return (
          <FolderRowOption
            folder={f}
            domId={sidebarRowDomId('note-row', row.id)}
            isActive={activeId === row.id}
            isCut={folders.folderClipboard === f.relPath}
            isDropHot={folders.dropHot === f.relPath}
            isRenaming={
              folders.editing?.mode === 'rename' && folders.editing.folder.relPath === f.relPath
            }
            // r176:树形三件 —— 缩进层级 / 展开态 / 有无子节点(chevron)。
            depth={row.depth}
            expanded={row.expanded}
            hasChildren={row.hasChildren}
            isTarget={row.isTarget}
            // r176:aria-posinset / aria-setsize 改成**同级**语义(树里
            //   setsize = 我这一层有几个兄弟),不再用全局 _index+1 / rows.length。
            posInSet={row.posInSet}
            setSize={row.setSize}
            onActivate={onFolderActivate}
            onContextMenu={onFolderContextMenu}
            onContextMenuAt={onFolderContextMenuAt}
            onHover={handleFolderHover}
            onDragStart={onFolderDragStart}
            onDragOver={onFolderDragOver}
            onDragLeave={onFolderDragLeave}
            onDrop={onFolderDrop}
            onCommitRename={commitFolderEdit}
            onCancelRename={folders.cancelEdit}
          />
        );
      }
      if (row.rowType === 'input') {
        return (
          <FolderCreateRow
            domId={sidebarRowDomId('note-row', row.id)}
            depth={row.depth}
            posInSet={row.posInSet}
            setSize={row.setSize}
            onCommit={commitFolderEdit}
            onCancel={folders.cancelEdit}
          />
        );
      }
      const n = row.item;
      return (
        <NoteRow
          note={n}
          isSelected={selectedId === n.id}
          isMultiSelected={selectedIds.has(n.id)}
          // audit-r143:键盘 roving active 视觉态(对账 LiteratureRow 同款改动,
          //   .list-row-active CSS 同源;FolderChrome r136 已用此模式)。
          isActive={activeId === n.id}
          isCut={clipboard?.mode === 'cut' && clipboard.ids.includes(n.id)}
          // r176:缩进层级(树里文件跟着所属目录缩进)。
          depth={row.depth}
          posInSet={row.posInSet}
          setSize={row.setSize}
          onSelect={handleSelect}
          onContextMenu={openContextMenuForRow}
          onContextMenuAt={openContextMenuAt}
          onHover={handleNoteHover}
          onDragStart={handleItemDragStart}
          // audit-r143:reorder 五件套 + 落点指示线(对账 LiteratureRow)
          onReorderDragOver={handleItemReorderDragOver}
          onReorderDragLeave={handleItemReorderDragLeave}
          onReorderDrop={handleItemReorderDrop}
          onReorderDragEnd={handleItemReorderDragEnd}
          reorderIndicator={reorderIndicator?.id === n.id ? reorderIndicator.position : null}
        />
      );
    },
    [
      activeId,
      folders.folderClipboard,
      folders.dropHot,
      folders.editing,
      commitFolderEdit,
      folders.cancelEdit,
      onFolderActivate,
      onFolderContextMenu,
      onFolderContextMenuAt,
      handleFolderHover,
      onFolderDragStart,
      onFolderDragOver,
      onFolderDragLeave,
      onFolderDrop,
      selectedId,
      selectedIds,
      clipboard,
      handleSelect,
      openContextMenuForRow,
      openContextMenuAt,
      handleNoteHover,
      handleItemDragStart,
      handleItemReorderDragOver,
      handleItemReorderDragLeave,
      handleItemReorderDrop,
      handleItemReorderDragEnd,
      reorderIndicator,
    ],
  );

  return (
    <div
      ref={listContainerRef}
      className="h-full flex flex-col bg-bg relative"
      // audit 2026-09-14 r7:拖入 overlay 期间底层 list aria-hidden —— SR 用户
      //   不再同时听到 overlay + 每个 NoteRow。详见 LibraryList 同款。
      // audit r29 (2026-09-21):a11y H4 — 同步 inert 到 dragActive (effect 块
      //   见下方),keyboard focus 跳过底层 row;aria-hidden 不阻止 focus,
      //   单靠 aria-hidden 键盘用户仍能 Tab 进去,见 LibraryList 同款注释。
      aria-hidden={dragActive ? 'true' : undefined}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* === Header(单一边框容器,与 LibraryHeader 同结构,避免两条 border-b 视觉割裂)===
          左上残留修复 (2026-10-16):模块名「笔记」回收到首行 —— r56 删 Tabs 块时
          把 V1.7 移过去的可见 label 一起带走,只剩 WorkbenchListPanel 的 sr-only
          h2,header 首行裸计数没有归属(用户报「左上角怎么是这样了」)。 */}
      <div className="border-b border-border-subtle bg-bg flex-shrink-0">
        {/* 第一行:模块名 label + 计数 + 新建按钮 */}
        <div className="px-3 py-2 flex items-center gap-2">
          <span className="text-2xs font-semibold text-fg-secondary tracking-wider uppercase">
            {t('workbench.tabNotes')}
          </span>
          {/* audit round 17 (2026-09-15):A11Y-M10 — 计数包 aria-live + aria-atomic,
             搜索/排序变化时 SR 读「X / Y 项」整段;原子公告避免漏读。 */}
          <span
            className="text-2xs text-fg-tertiary tabular-nums"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {/* audit round 16 (2026-09-15):i18n H1 — 之前直接插值裸数字,en-US
                单数也读 "1 notes"(中文恰好无屈折,英文暴露)。改走 i18next
                plural 形式,base key + _one + _other 三 key 同形(数字字面量),
                让后续想加 "1 note" / "1 项笔记" 文案时改 locale 即可不动调用点。 */}
            {/* 0007:浏览态计数 = 当前文件夹内容(同 LiteratureList displayCount
                契约);搜索态 = 全局命中。total 恒全库。 */}
            {displayCount === notes.length
              ? t('notes.listCount', { count: notes.length })
              : t('notes.listCountFiltered', {
                  filtered: displayCount,
                  total: notes.length,
                })}
          </span>
          <div className="flex-1" />
          {/* audit 2026-09-16 audit-r22:「先写后命名」 — + 按钮直接调 handleCreate,
              不再弹 inline Input(已删除)。aria-label 复用 listCreateAria,语义不变。 */}
          <Button
            variant="ghost"
            size="xs"
            onClick={() => void handleCreate()}
            aria-label={t('notes.listCreateAria')}
            // audit v2.0 Phase 3b:title 加 ⌘N / Ctrl+N 提示 — icon-only 按钮用
            //   原生 tooltip 标注快捷键,避免 <Kbd> 旁片在 xs/ghost 按钮旁抢戏。
            title={`${t('notes.listCreateAria')} (${formatShortcut('mod+N')})`}
          >
            <Plus size={11} aria-hidden="true" />
          </Button>
          {/* 0007 虚拟文件夹:新建文件夹(mod+Shift+N,inline input 落当前夹) */}
          {/* r175:搜索态 disabled —— 搜索态下文件夹树整体不渲染(inline input
              行也被 rows 组装 gate 掉),点按钮不会有任何可见反馈。hook 内部
              也已 gate(见 useDiskFolderSidebar.startCreate),这里把状态摆在
              按钮上,让用户知道「搜索时不能建夹」而不是「点了没反应」。 */}
          <Button
            variant="ghost"
            size="xs"
            onClick={() => folders.startCreate()}
            disabled={searchActive}
            aria-label={t('folders.newFolderAria')}
            title={`${t('folders.newFolderAria')} (${formatShortcut('mod+Shift+N')})`}
          >
            <FolderPlus size={11} aria-hidden="true" />
          </Button>
          {/* audit 2026-09-14 r7:键盘 / SR 可达"导入 .md"按钮 —— 触发 hidden
            input[type=file] 由 OS file picker 选文件。r6 backlog。放在 ternary
            之外,无论 creating 状态都可见。 */}
          <Button
            variant="ghost"
            size="xs"
            onClick={triggerFilePicker}
            aria-label={t('notes.importButtonAria')}
            title={t('notes.importButtonAria')}
          >
            <Download size={11} aria-hidden="true" />
          </Button>
        </div>
        {/* 第二行:inline 搜索 */}
        <div className="px-3 pb-2">
          <div className="relative">
            <Search
              size={11}
              className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-tertiary pointer-events-none"
              aria-hidden="true"
            />
            <Input
              value={query}
              onChange={setQuery}
              placeholder={t('notes.searchPlaceholder')}
              aria-label={t('notes.searchAria')}
              inputClassName="pl-7 pr-7 h-7 text-2xs"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label={t('notes.searchClearAria')}
                // audit round 9 (2026-09-15):44×44 touch target —— 与 LibraryList
                //   同款,search clear X icon 视觉 20×20 但 hit area 撑到 WCAG AA
                //   44×44。min-* CSS specificity 压过 w-5 h-5。
                className="absolute right-1 top-1/2 -translate-y-1/2 min-w-[44px] min-h-[44px] flex items-center justify-center rounded text-fg-tertiary hover:text-fg hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              >
                <X size={10} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* r176:面包屑整块下线 —— 树里目录层级直接摊开,不再需要
          「面包屑 + 单层列表」这套钻入式导航。 */}

      {/* === 列表 === */}
      <div
        className="flex-1 min-h-0 py-1"
        onContextMenu={handleContainerContextMenu}
        onDragOver={handleContainerDragOver}
        onDragLeave={handleContainerDragLeave}
        onDrop={handleContainerDrop}
      >
        {rows.length === 0 ? (
          // audit round 12 (2026-09-15):SILENT-007 — 区分 lastError 与真空态。
          //   lastError 非空时显示"加载失败,点击重试",隐藏 + 新建 CTA(失败态
          //   创建笔记毫无意义,只会再走同一失败 IPC 路径)。
          lastError ? (
            <EmptyState
              size="sm"
              accent="notes"
              icon={<NotebookPen size={20} aria-hidden="true" />}
              title={t('notes.loadFailedTitle')}
              // audit r45 (2026-10-15):description 不再裸透传 lastError(英文 IPC
              //   错误如 "api.listNotes is not a function" 直接渲染给中文用户是反
              //   用户视角)。改走 i18n key `notes.loadFailedDesc`,zh-CN/en-US
              //   各一份友好文案。原始 lastError 仍落到重试按钮 title 属性 —— 调试
              //   / dev 用户鼠标 hover 即可看到完整 IPC 报错(view main.log 也行,
              //   但 UI 侧省一轮)。契约锁 tests/unit/renderer/notes/
              //   notes-list-error-i18n.test.ts。
              description={t('notes.loadFailedDesc')}
              // audit round 17 (2026-09-15):A11Y-H5 — 加载失败用 assertive 公告,
              //   用户必须知道(否则空状态 + 不响应的 + 按钮都不出现,毫无反馈)。
              liveRegion="assertive"
              action={
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    void load();
                  }}
                  aria-label={t('notes.loadFailedRetry')}
                  // audit r45 (2026-10-15):重试按钮 title 保留原始 lastError
                  //   给 debug 通道。SR / 键盘 / hover 用户拿不到 lastError 字面,
                  //   title 是 native tooltip 触发的最直接通道。
                  title={lastError ?? undefined}
                >
                  {t('notes.loadFailedRetry')}
                </Button>
              }
            />
          ) : (
            <EmptyState
              size="sm"
              accent="notes"
              icon={<NotebookPen size={20} aria-hidden="true" />}
              title={
                query.trim() ? t('notes.emptySearchTitle', { query }) : t('notes.listEmptyTitle')
              }
              description={query.trim() ? t('notes.emptySearchDesc') : t('notes.listEmptyDesc')}
              // V1.5 (audit #27):空笔记列表补 CTA —— header 右上角 + 按钮在窄窗口
              // 下被压缩或找不到,这里给个明确入口;搜索态不显示 CTA(无意义)
              // audit round 17 (2026-09-15):A11Y-H5 — 搜索 / 真空态切换时 SR 公告
              //   「没有匹配的笔记」,默认 off 改为 polite 不打断。
              liveRegion="polite"
              action={
                !query.trim() && (
                  // audit 2026-09-16 audit-r22:「先写后命名」 — CTA 直接调 handleCreate,
                  //   不再弹 inline 输入框。
                  // audit-r145e (2026-10-19) MED:Button.loading 原语接入
                  //   —— 空列表 CTA「新建笔记」此前只有 onClick 无 disabled /
                  //   loading,IPC 跑期间用户可连点多次触发 creatingInFlightRef
                  //   内层 re-entry(race:ref 同步守卫顶住,但 Button 视觉静止,
                  //   用户看不出 IPC 跑着)。loading={creatingInFlight} 走原语
                  //   (r145d 同样改造):spinner + aria-busy + 强 disabled 三件
                  //   套,SR 与视觉同步知道「正在创建」。ref 同步守卫保留(
                  //   setState 异步批处理兜不住即时连按)。
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => void handleCreate()}
                    loading={creatingInFlight}
                  >
                    <Plus size={12} aria-hidden="true" /> {t('notes.listEmptyAction')}
                  </Button>
                )
              }
            />
          )
        ) : (
          // perf (2026-09-04):react-virtuoso 虚拟滚动 —— NotesList 同样会在大
          //   库下挂载数千 NoteRow,搜索/新建/扫描推送都会触发全量重建。
          //   Virtuoso 把 DOM 节点降到 ~30 行,NoteRow 仍走 React.memo 子项级
          //   跳过;computeItemKey 用 note.id 保证滚动位置稳定。
          //
          // audit round 17 (2026-09-15):A11Y-M2 — listbox 容器包裹 Virtuoso
          //   (与 LibraryList 同款)。role=listbox + aria-activedescendant 指向
          //   当前 selectedId 对应 option。tabIndex=-1 让容器可程序化 focus
          //   但不挤入 Tab 序列 —— 整个列表只占一个 tab stop,内部 option 通过
          //   aria-activedescendant 虚拟指针切换。
          // audit 2026-09-21 audit-r24:aria-activedescendant 改绑 activeId
          //   (键盘/hover 到的行,与 selectedId 解耦)—— 绑 selectedId 在
          //   Virtuoso 渲染窗口外时指向悬空 DOM,SR 报 "missing element"。
          //   activeId 变化时 scrollToIndex 让 DOM 真实存在(见 handleActiveById)。
          <div
            ref={listboxRef}
            // r176:listbox → tree —— 侧栏是层级结构,aria-level / aria-expanded
            //   只在 role=treeitem 上有效,行也一并升格(见 NoteRow / FolderRowOption)。
            role="tree"
            aria-multiselectable="true"
            aria-label={t('notes.listAria')}
            aria-activedescendant={activeId ? sidebarRowDomId('note-row', activeId) : undefined}
            // audit r35 (2026-10-08):A11Y6 —— tabIndex -1 → 0。同 LibraryList:
            //   -1 阻断键盘进入,useListboxRove 在 document 监听 keydown 但
            //   contains() 检查要求焦点在容器内才会拦截,实际键盘用户进不来。
            tabIndex={0}
            onKeyDown={handleListboxKeyDown}
            className="h-full outline-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
          >
            <Virtuoso
              // audit 2026-09-16 audit-r22:ref 转发 —— handleCreate 创建新笔记后
              //   scrollToIndex 让用户看到新行。react-virtuoso 提供 VirtuosoHandle
              //   类型。
              ref={virtuosoRef}
              style={{ height: '100%' }}
              data={rows}
              itemContent={itemContent}
              computeItemKey={(_index, row) => row.id}
              overscan={LIST_OVERSCAN_PX}
            />
          </div>
        )}
      </div>
      {/* === 右键菜单(行右键弹出 rename / showInFolder / delete) === */}
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={menuItems}
        onClose={() => setMenu(null)}
      />
      {/* === 文件夹行右键菜单(0007;hook 管 state,两份独立)=== */}
      <ContextMenu
        open={folders.folderMenu !== null}
        x={folders.folderMenu?.x ?? 0}
        y={folders.folderMenu?.y ?? 0}
        items={folderMenuItems}
        onClose={() => folders.setFolderMenu(null)}
      />
      {/* === 空白区域右键菜单(audit-r131:新建 / 粘贴 / 全选)=== */}
      <ContextMenu
        open={containerMenu !== null}
        x={containerMenu?.x ?? 0}
        y={containerMenu?.y ?? 0}
        items={containerMenuItems}
        onClose={() => setContainerMenu(null)}
      />
      {/* === 拖入覆盖层 (audit-r152 2026-10-19) —— 抽 <DropOverlay> 原语,
          单一真实来源;改色 / 改圆角 / 改 padding 走 DropOverlay.tsx 一处。 */}
      <DropOverlay
        active={dragActive}
        ariaLabel={t('notes.dropOverlay')}
        text={t('notes.dropOverlay')}
        testId="notes-drop-overlay"
      />
      {/* audit 2026-09-14 r7:hidden file picker —— 由工具栏导入按钮触发,
         change 走 importFiles helper。SR / display:none 让 SR 跳过此 input。 */}
      <input
        ref={filePickerRef}
        type="file"
        multiple
        accept=".md,.markdown"
        className="hidden"
        aria-hidden="true"
        onChange={onFilePickerChange}
      />
    </div>
  );
}

// === 单行:笔记图标 + 标题 + 路径 + timeAgo ===
// perf (2026-09-04):React.memo —— NotesList 在 notes 数组引用变化(扫描 /
//   autosave 推送)或选中态变化时,父级 render;之前 1000 个 NoteRow 全部跑
//   reconcile。加 memo 后,只有真正受影响的行(选中行 + 该 save 命中的行)
//   重新渲染。配合父级 useCallback(handleSelect) 才有效,inline 箭头会让
//   memo 因 onSelect prop 引用变化而失效。
//   timeAgo memoized —— 30s tick 触发父级重渲时,500 行 timeAgo 不再
//   各自 Date.now()/Date.parse 各算一遍,只算一次(因 t() 在同语言下稳定)。
const NoteRow = memo(function NoteRow({
  note,
  isSelected,
  isMultiSelected,
  isActive,
  isCut,
  depth,
  posInSet,
  setSize,
  onSelect,
  onContextMenu,
  onContextMenuAt,
  onHover,
  onDragStart,
  // audit-r144:reorder 四件套(dragstart 收编到 useFolderSidebar.startItemsDrag)
  onReorderDragOver,
  onReorderDragLeave,
  onReorderDrop,
  onReorderDragEnd,
  reorderIndicator,
}: {
  note: StandaloneNoteSummary;
  isSelected: boolean;
  // 2026-10-16 file-manager ops:多选集合成员(含主选中行)。aria-selected
  //   与次级高亮都看它;主选中行另有 list-row-selected 的 accent 竖条。
  isMultiSelected: boolean;
  // audit-r143:键盘 roving active 视觉态(对账 LiteratureRow;见 globals.css
  //   .list-row-active)。selected = 主选中,active = 键盘 focus 项,二者独立。
  isActive: boolean;
  // 0007:剪切集合成员半透明显示(VS Code cut 视觉)。
  isCut?: boolean;
  // r176:缩进层级(根的直接子级 = 0)—— 文件跟着所属目录缩进。
  depth: number;
  // audit round 17 (2026-09-15):A11Y-M2 — aria-posinset (1-based) + aria-setsize,
  //   虚拟列表下 SR 唯一知道「位置 / 总数」的方式。
  //   r176:改成**同级**语义(树里 setsize = 我这一层有几个兄弟)。
  posInSet: number;
  setSize: number;
  // 2026-10-16 file-manager ops:第二参数透传 MouseEvent,父级按修饰键
  //   路由单选/ toggle / range(见 handleSelect)。键盘 Enter/Space 不传事件
  //   → 父级按 'single' 处理。
  onSelect: (note: StandaloneNoteSummary, e?: ReactMouseEvent) => void;
  onContextMenu: (note: StandaloneNoteSummary, e: ReactMouseEvent) => void;
  // audit r29 (2026-09-21):a11y H6 — 合成坐标路径独立签名, 不再
  //   `as unknown as React.MouseEvent` 把 {clientX,clientY} 当作整 MouseEvent
  //   糊弄类型。原签名只接收 MouseEvent,Shift+F10 路径合成坐标时丢了
  //   preventDefault / stopPropagation / nativeEvent,后续维护若在 helper 调
  //   这些方法会 silent crash。新签名单独接 (note, x, y) — 明确表达
  //   "合成路径",依赖图清晰。
  onContextMenuAt: (note: StandaloneNoteSummary, x: number, y: number) => void;
  // audit 2026-09-21 audit-r24:鼠标 hover 让 activeId 跟手 ——
  //   aria-activedescendant 绑 activeId(键盘 OR 鼠标,二选一不歧义)。
  onHover?: (note: StandaloneNoteSummary) => void;
  // 0007:内部拖拽起点(自定义 MIME,父级写 selection payload)。
  // audit-r136:接 (note, e) 二参,内部 useMemo bound 到 row note,父级
  //   useCallback 稳定后 memo 命中,setDropHot 60Hz 拖拽不再连带 NoteRow
  //   重渲(同 LiteratureRow / FolderRowOption)。
  // audit-r144:整行 dragstart 走父级 onDragStart,内部 startItemsDrag 一次性
  //   投递 MOVE + REORDER 两 MIME,row 不再按 handle/非 handle 分发。
  onDragStart?: (note: StandaloneNoteSummary, e: ReactDragEvent) => void;
  // audit-r144:reorder 落点四件套 + 指示线。dragOver/Leave/Drop/End 都由
  //   row div 接收,REORDER payload 投递的是被拖项 id,targetId 在 drop 端
  //   按 currentTarget 行 n.id 重算。
  onReorderDragOver: (note: StandaloneNoteSummary, e: ReactDragEvent) => void;
  onReorderDragLeave: (note: StandaloneNoteSummary, e: ReactDragEvent) => void;
  onReorderDrop: (note: StandaloneNoteSummary, e: ReactDragEvent) => void;
  onReorderDragEnd: (e: ReactDragEvent) => void;
  reorderIndicator: 'before' | 'after' | null;
}) {
  const { t } = useTranslation();
  const title = note.title ?? stripExt(note.filename);
  const handleClick = useCallback((e: ReactMouseEvent) => onSelect(note, e), [onSelect, note]);
  const handleMouseEnter = useCallback(() => onHover?.(note), [onHover, note]);
  // audit-r136 + audit-r144:整行 dragstart 走父级 onDragStart → startItemsDrag
  //   一次性投递 MOVE + REORDER 两 MIME。row 不再按 closest 分发,handle
  //   元素已删除。
  const handleDragStart = useMemo(
    () => (e: ReactDragEvent) => onDragStart?.(note, e),
    [onDragStart, note],
  );
  // audit-r143:reorder 落点四件套
  const handleReorderDragOver = useMemo(
    () => (e: ReactDragEvent) => onReorderDragOver(note, e),
    [onReorderDragOver, note],
  );
  const handleReorderDragLeave = useMemo(
    () => (e: ReactDragEvent) => onReorderDragLeave(note, e),
    [onReorderDragLeave, note],
  );
  const handleReorderDrop = useMemo(
    () => (e: ReactDragEvent) => onReorderDrop(note, e),
    [onReorderDrop, note],
  );
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelect(note);
        return;
      }
      // audit 2026-09-16 r18:F2 — Shift+F10 / ContextMenu 键打开右键菜单。
      //   WAI-ARIA 1.2 keyboard pattern(7.4 Listbox):用户在 listbox option 上
      //   按 Shift+F10 应触发与右击等价的菜单事件。
      // audit r29 (2026-09-21):a11y H6 — 改走 onContextMenuAt(note, x, y),
      //   直接给父级坐标而不是合成伪 MouseEvent,类型诚实。
      if (e.shiftKey && e.key === 'F10') {
        e.preventDefault();
        const target = e.currentTarget as HTMLElement;
        const rect = target.getBoundingClientRect();
        onContextMenuAt(note, rect.left + rect.width / 2, rect.top + rect.height / 2);
      }
    },
    [onSelect, note, onContextMenuAt],
  );
  // 包装 onContextMenu 把 React.MouseEvent 直接传给父级,父级 setMenu(x/y)。
  const handleContextMenu = useCallback(
    (e: ReactMouseEvent) => onContextMenu(note, e),
    [onContextMenu, note],
  );
  // perf:timeAgo 内部 Date.parse + Intl.DateTimeFormat(7+ 天路径)都不便宜,
  //   memo 后只在 note.mtime / t 变化时算一次。
  const agoText = useMemo(() => timeAgo(note.mtime, t), [note.mtime, t]);
  return (
    // audit round 17 (2026-09-15):A11Y-M2 — role=button + tabIndex=0 + aria-pressed
    //   改 role=option(WAI-ARIA listbox option 语义)。listbox 容器持有 DOM
    //   focus + aria-activedescendant,所以 option 自身不带 tabIndex(整个列表
    //   只占一个 tab stop)。aria-label 也去掉 —— SR 会读 option 内部文本
    //   (FileText icon + title + meta),显式 aria-label 反而压制了 relPath +
    //   timeAgo 的可读信息。
    <div
      // r176:role=option → role=treeitem —— 侧栏容器升格成 role=tree,
      //   aria-level / aria-posinset / aria-setsize 只在 treeitem 上有效。
      role="treeitem"
      aria-selected={isSelected || isMultiSelected}
      aria-posinset={posInSet}
      aria-setsize={setSize}
      aria-level={depth + 1}
      // audit r35 (2026-10-08):A11Y7 —— option 加 tabIndex=-1。配合
      //   A11Y6 改 listbox tabIndex=0(roving tab-index),与 LibraryList 同款。
      tabIndex={-1}
      // audit 2026-09-16 r18:F3 — onContextMenu 触发自定义右键菜单。
      //   aria-haspopup=menu 让 SR 在焦点到此 option 时朗读「has menu,
      //   打开菜单」,与 Shift+F10 键提示形成双重可达性。
      aria-haspopup="menu"
      id={`note-row-${note.id}`}
      data-note-id={note.id}
      // 0007:行可拖(拖到文件夹行 / 面包屑 = 改归属;落到空白 = 取消)。
      draggable
      onDragStart={handleDragStart}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onContextMenu={handleContextMenu}
      onMouseEnter={handleMouseEnter}
      onDragOver={handleReorderDragOver}
      onDragLeave={handleReorderDragLeave}
      onDrop={handleReorderDrop}
      onDragEnd={onReorderDragEnd}
      className={clsx(
        'list-row group relative',
        isSelected && 'list-row-selected',
        !isSelected && isActive && 'list-row-active',
        !isSelected && isMultiSelected && 'list-row-multi',
        isCut && 'opacity-50',
      )}
      // r176:缩进 = 层级 × 12px(走内联 style 覆盖 .list-row 的 px-3)。
      style={{ paddingLeft: 12 + depth * 12 }}
    >
      {/* audit-r144:整行默认 drag(无 handle) —— dragstart 走父级
          onDragStart → startItemsDrag,同时投递 MOVE + REORDER 两 MIME,drop
          端按目标判定 dropZone:文件夹图标 → 移入;同集合内另一行 → reorder。 */}
      <FileText size={12} className="text-fg-tertiary flex-shrink-0" aria-hidden="true" />
      <div className="flex-1 min-w-0">
        <div className="list-row-title">{title}</div>
        <div className="list-row-meta">
          {/* audit 2026-09-16 r18:H9 — 走 t() + i18n 占位符,中英文混排不再硬编码,
              title 属性的 SR 朗读也走语言一致。en-US 自然拼写用 ', '。 */}
          {t('notes.metaSep', { relPath: note.relPath, ago: agoText })}
        </div>
      </div>
      {/* audit-r143:落点指示线(before / after),2px 横线,absolute 贴 row 边。 */}
      {reorderIndicator === 'before' && (
        <span
          data-testid="note-reorder-indicator-before"
          aria-hidden="true"
          className="absolute left-0 right-0 top-0 h-0.5 bg-accent pointer-events-none"
        />
      )}
      {reorderIndicator === 'after' && (
        <span
          data-testid="note-reorder-indicator-after"
          aria-hidden="true"
          className="absolute left-0 right-0 bottom-0 h-0.5 bg-accent pointer-events-none"
        />
      )}
    </div>
  );
});
