// 文献列表 — 工作台左侧 tab「文献」的 body(audit-r71 重建,2026-10-17)
//
// 形态(形制抄 NotesList,数据面是 resources 表的 lit 行):
//   ┌─────────────────────────────┐
//   │ 文献 计数            [⬇ 导入] │  ← header(模块名 label + 计数 + 导入按钮)
//   ├─────────────────────────────┤
//   │ 🔍 [搜索框]                   │  ← inline 客户端过滤
//   ├─────────────────────────────┤
//   │ 📄 paper.pdf                │
//   │    2.3 MB · 2h ago          │  ← 文献行(完整文件名 + size + timeAgo)
//   │ ...                         │
//   └─────────────────────────────┘
//
// 设计:
//   - 数据 = useLiteratureStore.items(lit 行全量,无 body)。按 mtime 倒序。
//   - 点行 → select(id);右侧 WorkbenchContentPanel 据此驱动 Reader。
//   - 拖入 / 文件 picker → 拷入 <rootPath>/literature/ 并 upsert lit 行
//     (不做后缀白名单 —— PDF/docx/txt/图片全部允许,非普通文件由主进程拒)。
//   - 右键最简集:在文件夹中显示 + 删除(硬删,confirm 兜)。无重命名 / 剪切
//     板 / 多选 —— v1 范围,见 audit-r71 计划「明确不做」。
//     (r187 补:文献**单文件重命名**已接通 —— 与笔记侧操作集对齐,见下。)
//   - 0007 虚拟文件夹(2026-10-18)推翻上条的「不做」:多选(Ctrl/Shift+击、
//     mod+C/X/V/A)+ 剪切/复制/粘贴(mod+V 粘进当前文件夹)+ 右键「移出
//     文件夹」+ 文件夹行/面包屑/新建重命名 inline input + 拖拽入夹
//     (lib/folder-dnd 自定义 MIME)。文件夹是 DB 层虚拟归属:移动只改
//     folder_id,磁盘文件与 lit id 都不动,收藏 / 选中 / 搜索链接不断。
//     交互契约与 NotesList 完全同款(useFolderSidebar / folder-view 共享)。
//   - ★ 收藏(r72 恢复):行首 star 调 useFavoritesStore.toggle(res.id,
//     {title, relPath:absPath}),「全部 / 仅收藏」filter chip 用本地
//     useState —— 旧 LibraryList 形制原样接线,收藏数据层(favorites.md +
//     4 通道 + store + onFavoritesChanged 推送)自 r56 起从未下线。
//   - 0005 迁移旧行的 absPath 可能指向已移走的旧库文件:列表照常显示,这里
//     不做缺档预判。缺档兜底按 Reader 路径分两种(audit-r73 注记,r71 已裁定
//     行为可接受):md/txt 等走 readLiteratureFile IPC → 命中 NOT_FOUND 错误
//     态;PDF/图片 Reader 短路不读字节(见 Reader.tsx needsFileData),缺档时
//     由 pdf.js / <img> 自身的加载错误呈现,不会走 NOT_FOUND 文案。
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from 'react';
import { Virtuoso } from 'react-virtuoso';
import type { VirtuosoHandle } from 'react-virtuoso';
import { useTranslation } from 'react-i18next';
import { Download, FileText, FolderPlus, Search, Star, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useLiteratureStore } from '../../store/literature';
import { useFavoritesStore } from '../../store/favorites';
import { useWorkspaceStore } from '../../store/workspace';
import { useToast } from '../../lib/toast';
import { confirm } from '../../lib/confirm';
import { DropOverlay } from '../common/DropOverlay';
import { errMsg } from '../../lib/error';
import { createLogger } from '../../lib/logger-client';
import { api } from '../../lib/api';
import { applyClickSelectRoute, liveSelectedIds, resolveClickSelectMode } from '../../lib/multi-select';
import type { DiskFolderNode, LiteratureResource } from '@shared/types';
import { clsx } from '../../lib/clsx';
import { getDroppedFilePath } from '../../lib/drop';
import { formatShortcut } from '../../lib/shortcut';
import { timeAgo } from '../../lib/time';
import { filenameOf, parentDirOf } from '../../utils/lit-path';
import { folderRowId, sidebarRowDomId } from '../../lib/folder-view';
// r176:左侧栏改**树状** —— 行合成搬到 lib/folder-tree.ts(纯函数,不起 React
//   也能单测)。folder-view 只留底层契约(dirname / 行 id / DOM id 合成)。
import { buildTreeRows, groupItemsByDir, type TreeRow } from '../../lib/folder-tree';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { RadioChip } from '../ui/RadioChip';
import { EmptyState } from '../ui/chrome';
import { ContextMenu, type ContextMenuItem } from '../ui/ContextMenu';
import { Modal } from '../ui/Modal';
import { FolderCreateRow, FolderRowOption } from '../common/FolderChrome';
import { LIST_OVERSCAN_PX } from '../../lib/list-tuning';
import { useListboxRove } from '../../hooks/useListboxRove';
import { useRadioGroup } from '../../hooks/useRadioGroup';
import { ROOT_DROP_ID, useDiskFolderSidebar } from '../../hooks/useDiskFolderSidebar';
// audit-r143 (2026-10-19):侧栏自定义排序 —— REORDER MIME 与 MOVE MIME 并存,
//   reorder 落点由 list 组件算(行中线 = before/after 分界),store 接收
//   reorderByIds(orderedIds) 把新视觉顺序重排成连续 0..N-1。
import { useReorderDnd } from '../../hooks/use-reorder-dnd';
import { useListboxKeys } from '../../hooks/use-listbox-keys';
import { useSidebarDropZone } from '../../hooks/use-sidebar-drop-zone';
import { useFolderOps } from '../../hooks/use-folder-ops';
import { useContainerMenuItems, useFolderMenuItems } from '../../hooks/use-sidebar-menus';

const log = createLogger('LiteratureList');

// 行内 size 展示:B / KB / MB / GB,>=10 取整(2.3 MB 比 2.34 MB 耐读)。
// 项目没有现成 formatBytes(renderer 各处都没量过 size,literature 是第一个),
// 单组件内联一份 10 行 helper,不进 lib/ 避免造无人复用的抽象。
function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'] as const;
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function LiteratureList() {
  const { t } = useTranslation();
  // perf r258 更正:这条 useShallow 在 r258 之前是**假绿** —— IPC 走 structured
  //   clone,回来的每条都是**新对象** ⇒ 逐元素 Object.is 恒为「不等」⇒ 浅比
  //   从来没生效过(每次 LITERATURE_CHANGED 广播都整表 + 每一行重渲)。
  //   r258 起 store 的 load() 做**结构共享**(lib/struct-share.ts):内容没变的
  //   条目沿用上一轮的对象引用 ⇒ 这条浅比才真的能 bail out。
  const items = useLiteratureStore(useShallow((s) => s.items));
  const selectedId = useLiteratureStore((s) => s.selectedId);
  const select = useLiteratureStore((s) => s.select);
  const load = useLiteratureStore((s) => s.load);
  const lastError = useLiteratureStore((s) => s.lastError);
  const importFromFile = useLiteratureStore((s) => s.importFromFile);
  const remove = useLiteratureStore((s) => s.remove);
  // r187:文献单文件重命名(与 notes 域 renameFile 对称)。
  const renameFile = useLiteratureStore((s) => s.renameFile);
  // 2026-10-18 文件夹轮:多选 + 剪贴板(与 NotesList 2026-10-16 file-manager
  //   ops 同款;store/literature.ts 承载实现)。
  const selectedIds = useLiteratureStore((s) => s.selectedIds);
  const clipboard = useLiteratureStore((s) => s.clipboard);
  const selectOnly = useLiteratureStore((s) => s.selectOnly);
  const toggleSelect = useLiteratureStore((s) => s.toggleSelect);
  const selectRange = useLiteratureStore((s) => s.selectRange);
  const selectMany = useLiteratureStore((s) => s.selectMany);
  const cutSelection = useLiteratureStore((s) => s.cut);
  const copySelection = useLiteratureStore((s) => s.copy);
  const pasteClipboard = useLiteratureStore((s) => s.paste);
  // r176:store.moveToFolder 的**唯一**调用点(旧 shim 的 onMoveItems)下线 ——
  //   跨目录搬移统一走 disk hook 的 handleTargetDrop(直调 api.litMove)+ idRemap
  //   回写;store 侧 moveToFolder 仍保留给其它调用方,此处不再取。
  const setActive = useWorkspaceStore((s) => s.setActive);
  const toast = useToast((s) => s.show);
  // ★ 收藏(audit-r72):favorites store 由 useSyncStores 订阅 onFavoritesChanged
  //   推送 + 挂载 load,这里只读 favoritedFileIds(Set<fileId>,fileId = 行 id)
  //   并调 toggle —— toggle 写盘后主进程广播,列表状态自动回流。
  const favoritedFileIds = useFavoritesStore((s) => s.favoritedFileIds);
  const toggleFavorite = useFavoritesStore((s) => s.toggle);
  // audit-r143:displayOrderById 用浅比即可(每次展开整对象);reorderByIds
  //   是 action 引用,Zustand 保证稳定。
  const displayOrderById = useLiteratureStore(useShallow((s) => s.displayOrderById));
  const reorderByIds = useLiteratureStore((s) => s.reorderByIds);
  const [query, setQuery] = useState('');
  // inert 同步目标(React 18.3 types 不支持 inert JSX 属性,走 ref + DOM,
  // 同 NotesList a11y H4 注释)。
  const listContainerRef = useRef<HTMLDivElement>(null);
  // 右键菜单:单 menu state 跨行共享(同 NotesList audit 2026-09-07)。
  const [menu, setMenu] = useState<{ res: LiteratureResource; x: number; y: number } | null>(null);

  // r187:重命名弹窗 —— 右键「重命名」→ 输入新文件名 → store.renameFile。
  //   预填**去扩展名**的文件名(与 notes 域一致),扩展名留空时主进程按
  //   原扩展名补齐(pdf/epub/... 多种格式,不能像 notes 一样一律 .md)。
  const [renameTarget, setRenameTarget] = useState<LiteratureResource | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // 挂载即拉一次(store 内部 in-flight 去重,import/delete 后自会补拉)
  useEffect(() => {
    load().catch((err: unknown) => log.warn('initial load failed', errMsg(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 「全部 / 仅收藏」用户偏好,本地 useState 即可(旧 LibraryList 同款,不持久化)。
  const [filter, setFilter] = useState<'all' | 'favorites'>('all');

  // audit-r76 (2026-10-17):radiogroup 接 useRadioGroup —— 旧实现只有
  //   role="radiogroup" + RadioChip roving tabIndex,容器没接方向键:
  //   未选中 chip tabIndex=-1 键盘永远到不了,纯键盘用户无法切过滤。
  //   SettingsPage 4 组同款接线为正确范例(arrow/Home/End + rAF 焦点跟随)。
  const filterRadio = useRadioGroup({
    tabs: [{ id: 'all' }, { id: 'favorites' }] as const,
    active: filter,
    onChange: (id) => setFilter(id as 'all' | 'favorites'),
  });

  // 排序(audit-r143):displayOrderById 升序;未登记项落到 +Infinity 之后。
  //   tie-breaker 走 mtime desc(同 store 默认顺序),保证「都没自定义过」
  //   时仍保持原 mtime 倒序行为,不让首装用户感觉列表跳了。
  // 与 filter 拆 memo(audit-r72 性能契约):displayOrderById 改 reorder 才
  // 换引用,收藏 toggle 不连带重排。
  const deferredQuery = useDeferredValue(query);
  const byDisplayOrder = useMemo(() => {
    return [...items].sort((a, b) => {
      const oa = displayOrderById[a.id] ?? Number.POSITIVE_INFINITY;
      const ob = displayOrderById[b.id] ?? Number.POSITIVE_INFINITY;
      if (oa !== ob) return oa - ob;
      return b.mtime - a.mtime;
    });
  }, [items, displayOrderById]);
  const sorted = useMemo(() => {
    const favFiltered =
      filter === 'favorites'
        ? byDisplayOrder.filter((r) => favoritedFileIds.has(r.id))
        : byDisplayOrder;
    const q = deferredQuery.trim().toLowerCase();
    if (!q) return favFiltered;
    return favFiltered.filter((r) => {
      const hay = `${r.title}\n${filenameOf(r.absPath)}\n${r.absPath}`.toLowerCase();
      return hay.includes(q);
    });
  }, [byDisplayOrder, filter, favoritedFileIds, deferredQuery]);

  // === 0007 虚拟文件夹 → r176 树状:导航态 + 行合成(与 NotesList 同款契约)===
  //   r176:列表不再「钻入单层」—— 直接摊开成树:
  //     根的子文件夹 → 展开后接它的子树;同一层里文件夹在前、文件在后。
  //   searchActive(query 非空)→ 跨目录全局命中、扁平列表(不渲染文件夹行)。
  const searchActive = deferredQuery.trim().length > 0;
  // r168:drag-into-folder 路径走完 ipc.litMove 后回调 —— store 收到
  //   idRemap 后把 selectedId 跳到新 id(同 paste(cut)/moveToFolder 隐式
  //   重映射)。lit 域无 activeFull 缓存,只刷 selectedId。
  const handleItemsMoved = useCallback(
    (idRemap: Map<string, { id: string; absPath?: string; relPath?: string }>) => {
      useLiteratureStore.getState().applyMoveRemap(idRemap);
    },
    [],
  );
  const folders = useDiskFolderSidebar({
    kind: 'literature',
    searchActive,
    api,
    onItemsMoved: handleItemsMoved,
  });
  // audit-r227:runFolderOp(r173)/ commitFolderEdit(r176)/ pasteTo +
  //   pasteToTarget 已收编进 useFolderOps;唯一分叉 = log 前缀与 paste
  //   失败 toast 的 i18n key(注入)。
  const { runFolderOp, commitFolderEdit, pasteTo, pasteToTarget } = useFolderOps({
    logTag: 'LiteratureList',
    pasteFailedKey: 'literature.pasteFailedToast',
    folders,
    pasteClipboard,
  });
  // audit-r224:reorder 四件套 + 落点指示线 state 收编进 useReorderDnd
  //   (与 NotesList 的逐字同构块;行为契约见 hook 头注)。
  //   调用点在 folders / useFolderOps 之后(2026-10-21):跨目录落行的委托
  //   onCrossFolderMove 要用 runFolderOp 包 folders.handleTargetDrop
  //   (与 onFolderDrop 同款包装)。
  const {
    reorderIndicator,
    handleItemReorderDragOver,
    handleItemReorderDragLeave,
    handleItemReorderDrop,
    handleItemReorderDragEnd,
  } = useReorderDnd<LiteratureResource>({
    kind: 'literature',
    getItems: () => useLiteratureStore.getState().items,
    displayOrderById,
    reorderByIds,
    // 跨目录 drop 到某一行 = 搬进该行所在目录(根行 = ROOT_DROP_ID)。
    //   事件带 MOVE payload,handleTargetDrop 连多选 batch 一起搬。
    onCrossFolderMove: (dir, e) =>
      runFolderOp(() => folders.handleTargetDrop(e, dir === '' ? ROOT_DROP_ID : dir)),
  });
  // 资源按所属目录分组(dirname(relPath) → 该目录直属的文献)。
  //   r172:literature 行现在由 LiteratureService 填了真实 relPath(相对
  //   <rootPath>/literature/),子目录里的文献能落到对应目录下了。
  const itemsByDir = useMemo(() => groupItemsByDir(sorted), [sorted]);
  // r176:树行合成 —— 纯函数在 lib/folder-tree.ts(可不起 React 单测)。
  const rows = useMemo<TreeRow<LiteratureResource>[]>(
    () =>
      buildTreeRows<LiteratureResource>({
        childrenByDir: folders.childrenByDir,
        itemsByDir,
        expanded: folders.expanded,
        targetRelPath: folders.targetRelPath,
        searchActive,
        searchItems: sorted,
        // r134:搜索态不挂 input 行 —— 见 NotesList 同款注。
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
    const out: LiteratureResource[] = [];
    for (const row of rows) if (row.rowType === 'item') out.push(row.item);
    return out;
  }, [rows, searchActive, sorted]);
  // header 计数:搜索态 = 全局命中,浏览态 = 树里可见的文件数(收藏 chip 过滤
  // 仍按 sorted 语义)。total 恒为全库行数,「X / 共 Y」两语义都成立。
  const displayCount = visibleItems.length;
  // audit-r243:Shift 范围选择的**区间口径** = 当前可见行的 id 序。
  //   旧实现用 store 数组顺序(全库 mtime 倒序)切区间,「仅收藏」视图里
  //   夹着**屏幕上看不到**的非收藏行 ⇒ Shift 选中把它们也选中 ⇒ 随后的
  //   Delete 把用户从未见过、也没打算选的文件一并移进回收站。
  const visibleIds = useMemo(() => visibleItems.map((r) => r.id), [visibleItems]);

  const virtuosoRef = useRef<VirtuosoHandle>(null);
  // listbox 虚拟指针 state —— 声明提前到 handleSelect 之前(0007 轮:
  // toggle/range 分支也要 setActiveId 跟手,见下方 handleSelect)。
  const [activeId, setActiveId] = useState<string | null>(selectedId);

  // audit-r160 B7:listboxRef 提前到 handleSelect 之前 —— B7 修复后 handleSelect
  //   内部 listboxRef.current?.focus() 引用必须先存在(useRef 是稳定对象,
  //   值在调用时读,声明序不影响运行时,但 lint 'no-use-before-define' 会红)。
  //   旧实现声明在 307 行(在 handleSelect 之后),以前 handleSelect 不用 ref
  //   没事,本轮 B7 加 focus() 调用必须提前。useListboxRove 的 onActiveChange
  //   callback(handleActiveById)随之也提前。
  const listboxRef = useRef<HTMLDivElement>(null);

  // 点行:select + 确保 active='library'(SearchPanel 直达后用户在文献 tab 内
  // 再点行时 active 已是 library,重复 setActive 走 zustand equality 拦截,
  // 这里仍显式 gate 省一次 notify —— 同 NotesList.handleSelect)。
  // 0007 轮补齐修饰键路由(Ctrl/Cmd+击 toggle、Shift+击 range),与
  // NotesList 的 resolveClickSelectMode 契约完全一致;键盘 Enter/Space 不传
  // 事件 → 走 'single'。
  // audit-r160 B7:click 后把焦点搬到 listbox,让后续 Ctrl+X/Ctrl+V 落到
  //   handleListboxKeyDown(用户报「剪切、粘贴、拉动移动到文件夹不起作用」,
  //   同 NotesList 一并治愈)。listbox 已 focus 时 no-op(idempotent)。
  const handleSelect = useCallback(
    (r: LiteratureResource, e?: ReactMouseEvent) => {
      // audit-r228:路由本体上收 lib/multi-select.applyClickSelectRoute
      //   (两域单一真相源)—— 此前只有文献域的 toggle/range 分支跟手
      //   setActiveId,笔记域漏了 ⇒ 分叉长了出来。共用一份路由后不可能
      //   再分叉(行为与改前逐条一致)。
      const mode = e ? resolveClickSelectMode(e) : 'single';
      applyClickSelectRoute(
        mode,
        r.id,
        {
          toggleSelect,
          selectRange,
          selectOnly,
          select,
          setActiveId,
        },
        visibleIds,
      );
      if (mode === 'single' && useWorkspaceStore.getState().active !== 'library') setActive('library');
      listboxRef.current?.focus();
    },
    [select, selectOnly, toggleSelect, selectRange, setActive, visibleIds],
  );

  // ★ 收藏 toggle(audit-r72,旧 LibraryList.handleToggleFavorite 原样接线):
  //   stopPropagation 防冒泡成点行选中;fileId 用 res.id(与 favoritedFileIds
  //   匹配键同源),title/relPath 落 favorites.md 供人类可读备份。
  const handleToggleFavorite = useCallback(
    async (e: ReactMouseEvent, r: LiteratureResource): Promise<void> => {
      e.stopPropagation();
      try {
        await toggleFavorite(r.id, {
          title: filenameOf(r.absPath),
          relPath: r.absPath,
        });
      } catch (err: unknown) {
        log.error('toggleFavorite failed', err);
        toast({ type: 'error', message: t('toast.favoriteFailed', { msg: errMsg(err) }) });
      }
    },
    [toggleFavorite, toast, t],
  );

  // === listbox rove(activeId 与 selectedId 解耦,同 NotesList audit-r24)===
  useEffect(() => {
    setActiveId(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);
  // audit-r73:active 行可能因收藏 chip 切换 / 搜索词变化 / 删除而离开列表
  // (activeId 与 selectedId 解耦,不跟着列表消失而复位)→ aria-activedescendant
  // 会指向 DOM 里不存在的幽灵 id(SR 读到空)。回落 selectedId(可为 null = 无 active)。
  // 0007:判据从 sorted 改 rows —— 切文件夹 / 进入空文件夹同样让文件夹行消失。
  useEffect(() => {
    if (activeId && !rows.some((x) => x.id === activeId)) setActiveId(selectedId);
  }, [rows, activeId, selectedId]);
  const handleActiveById = useCallback(
    (id: string) => {
      setActiveId(id);
      const idx = rows.findIndex((x) => x.id === id);
      if (idx >= 0) virtuosoRef.current?.scrollToIndex({ index: idx, align: 'center' });
    },
    [rows],
  );
  const handleHover = useCallback((r: LiteratureResource) => {
    setActiveId(r.id);
  }, []);
  const handleFolderHover = useCallback((f: { relPath: string }) => {
    setActiveId(folderRowId(f.relPath));
  }, []);
  // audit-r160 B7:listboxRef 已在 handleSelect 之前声明(本行删除),
  //   useListboxRove 用同一引用。
  useListboxRove({
    containerRef: listboxRef,
    items: rows,
    activeId,
    onActiveChange: handleActiveById,
  });

  // 删除作用于「多选集合」(Delete 键 / 右键共用;右键未选中行会先 selectOnly
  // 兜底,见 openContextMenuForRow)。0007 轮把旧的「单行删除」升级为与
  // NotesList 同款批量:串行 await,失败即中断(前面已删,后面还在,可重试)。
  const handleDeleteSelection = useCallback(async () => {
    const st = useLiteratureStore.getState();
    // r193:与 notes 侧共用 liveSelectedIds(死 id 静默跳过,别让
    //   NOT_FOUND 中断整批删除)—— 两个域的删除语义必须一致。
    let ids = liveSelectedIds(st.items, st.selectedIds).map((r) => r.id);
    if (ids.length === 0 && activeId) {
      const r = st.items.find((x) => x.id === activeId);
      if (r) ids = [r.id];
    }
    if (ids.length === 0) return;
    let title: string;
    if (ids.length > 1) {
      title = t('literature.deleteConfirmTitleMulti', { count: ids.length });
    } else {
      const r = st.items.find((x) => x.id === ids[0]);
      title = t('literature.deleteConfirmTitle', {
        name: r ? filenameOf(r.absPath) : '',
      });
    }
    const ok = await confirm({
      title,
      description: t('literature.deleteConfirmDesc'),
      confirmLabel: t('literature.deleteConfirmLabel'),
      danger: true,
    });
    if (!ok) return;
    try {
      for (const id of ids) {
        await remove(id);
      }
      toast({ type: 'success', message: t('literature.deleteSuccess') });
    } catch (err: unknown) {
      log.error('LiteratureList delete failed', err);
      toast({ type: 'error', message: t('literature.deleteFailedToast', { msg: errMsg(err) }) });
    }
  }, [activeId, t, toast, remove]);

  // audit-r227:pasteTo / pasteToTarget 见上方 useFolderOps。

  // 列表快捷键(VS Code 语义,与 NotesList 同款):mod+C/X/V/A 多选与剪贴板,
  // mod+Shift+N 新建文件夹,F2 重命名 active 文件夹行,Delete 删选中(夹则删夹)。
  // 焦点隔离:搜索框在容器外;容器内 inline 文件夹 Input 持焦时整段让行
  // (Enter/Esc 归输入框,方向键由 useListboxRove 同款 gate 让行)。
  const handleListboxKeyDown = useListboxKeys<LiteratureResource>({
    rows,
    activeId,
    visibleItems,
    clipboard,
    searchActive,
    folders,
    copySelection,
    cutSelection,
    onPasteItems: pasteToTarget,
    runFolderOp,
    selectMany,
    onDeleteSelection: handleDeleteSelection,
    handleSelect,
    handleActiveById,
    // 文献域不传 onRenameItem:F2 只处理文件夹行(r71 文献重建未恢复
    //   磁盘 rename;原行为保持不变)。
  });

  // === 右键菜单 ===
  const openContextMenuForRow = useCallback(
    (r: LiteratureResource, e: ReactMouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // 0007/多选语义(同 NotesList):右键未选中行先收成单选;右键已在多选
      // 内的行保留多选,菜单走批量形态。
      if (!useLiteratureStore.getState().selectedIds.has(r.id)) {
        selectOnly(r.id);
      }
      setMenu({ res: r, x: e.clientX, y: e.clientY });
    },
    [selectOnly],
  );
  const openContextMenuAt = useCallback((r: LiteratureResource, x: number, y: number) => {
    setMenu({ res: r, x, y });
  }, []);
  // 拖拽起点:多选成员被拖 = 整组进 payload(按 items 顺序);单选 = 仅该 id。
  const handleItemDragStart = useCallback(
    (r: LiteratureResource, e: ReactDragEvent) => {
      const st = useLiteratureStore.getState();
      const ids =
        st.selectedIds.size > 1 && st.selectedIds.has(r.id)
          ? st.items.filter((x) => st.selectedIds.has(x.id)).map((x) => x.id)
          : [r.id];
      folders.startItemsDrag(ids, e);
    },
    [folders],
  );

  // audit-r224:reorder 拖拽四件套(dragOver/dragLeave/drop/dragEnd)+
  //   落点指示线 state 已收编进 hooks/use-reorder-dnd.ts(与 NotesList
  //   的逐字同构块);dragstart 仍由上方 handleItemDragStart →
  //   folders.startItemsDrag(同时投递两 MIME)一次完成。

  // audit-r136 (2026-10-19):FolderRowOption 现在接 (id, e) 二参,caller 必须
  //   useCallback 稳定,否则父级 inline lambda 每帧重建 → memo 失效 →
  //   setDropHot 60Hz 拖拽整树重渲 → Virtuoso 可见行每帧重渲 → 主线程耗尽
  //   → 拖拽卡顿。这些引用全部锁住,让 memo 命中。
  // r176:点文件夹行 = 设为落点 + 切换展开(树里没有「钻入」)。
  //   依赖收窄到具体函数 —— folders 对象身份随 dropHot / 展开态变化,
  //   挂在它上面等于每次拖拽热区变化都重建行回调,memo 全废。
  /* eslint-disable react-hooks/exhaustive-deps --
     r176:这 8 个回调都只调 folders 上的**单个方法**,依赖已窄化到该方法。
     exhaustive-deps 的告警是「调用成员函数必须把基对象 folders 整个列进
     deps」—— 但 folders 身份随 dropHot / expanded / editing / childrenByDir
     变化(hook 返回值是 useMemo),挂它 = 每次拖拽热区移动都重建全部行回调
     → FolderRowOption 的 memo 全废 → 60Hz 整树重渲(audit-r136 同款坑)。
     窄化后的 deps(folders.xxx)才是精确依赖:这些方法在 hook 内都是
     useCallback,deps 只含 kind / api / 稳定回调 → 身份跨渲染不变。 */
  const onFolderActivate = useCallback(
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

  const handleShowInFolder = useCallback(
    async (r: LiteratureResource) => {
      const dir = parentDirOf(r.absPath);
      // shell:open-path 打开的是「文件夹本身」(不选中文件)—— literature v1
      // 没有 showItemInFolder 通道(不加第 39 通道),openPath(dir) 是最近似。
      try {
        const res = await api.openPath(dir);
        if (!res.ok) {
          toast({ type: 'error', message: t('toast.showInFolderFailed', { msg: res.message }) });
        }
      } catch (err: unknown) {
        log.error('LiteratureList showInFolder failed', err);
        toast({
          type: 'error',
          message: t('toast.showInFolderFailed', { msg: errMsg(err) }),
        });
      }
    },
    [t, toast],
  );

  // r187:重命名 —— 打开弹窗(预填去扩展名的文件名)。
  const openRename = useCallback((res: LiteratureResource) => {
    const filename = filenameOf(res.absPath);
    const dot = filename.lastIndexOf('.');
    setRenameTarget(res);
    setRenameDraft(dot > 0 ? filename.slice(0, dot) : filename);
    setRenameError(null);
  }, []);

  const closeRename = useCallback(() => {
    if (renameBusy) return; // IPC 在飞:挡住双击关弹窗
    setRenameTarget(null);
    setRenameError(null);
  }, [renameBusy]);

  const doRename = useCallback(async () => {
    if (!renameTarget || renameBusy) return;
    const draft = renameDraft.trim();
    if (draft === '') return;
    setRenameBusy(true);
    setRenameError(null);
    try {
      const renamed = await renameFile(renameTarget.id, draft);
      toast({
        type: 'success',
        message: t('literature.renameSuccess', { name: filenameOf(renamed.absPath) }),
      });
      setRenameTarget(null);
    } catch (err: unknown) {
      // 错误就地显示在弹窗里(同 notes 域):toast 一闪而过,用户记不住
      //   「为啥没改成」,重开弹窗又得重新输。
      setRenameError(t('literature.renameErrorGeneral', { msg: errMsg(err) }));
    } finally {
      setRenameBusy(false);
    }
  }, [renameBusy, renameDraft, renameFile, renameTarget, t, toast]);

  // 资源行菜单(0007 轮对齐 NotesList 多选形态):
  //   * 多选:Cut / Copy / (Paste) / Delete —— 单选语义项(Rename /
  //     ShowInFolder)不出。
  //   * 单选:Rename(r187)/ Cut / Copy / (Paste) / ShowInFolder / Delete。
  //   * Paste 仅剪贴板非空时出现;粘进当前落点文件夹。
  const isMultiSelectMenu = menu !== null && selectedIds.size > 1 && selectedIds.has(menu.res.id);
  const menuItems = useMemo<ContextMenuItem[]>(() => {
    if (!menu) return [];
    const target = menu.res;
    const items: ContextMenuItem[] = [];
    // r187:重命名是单选语义项(与 notes 域一致:多选时不出)。
    if (!isMultiSelectMenu) {
      items.push({
        id: 'rename',
        label: t('literature.contextRename'),
        onSelect: () => openRename(target),
      });
    }
    items.push(
      { id: 'cut', label: t('literature.contextCut'), onSelect: () => cutSelection() },
      { id: 'copy', label: t('literature.contextCopy'), onSelect: () => copySelection() },
    );
    if (clipboard !== null) {
      items.push({
        id: 'paste',
        label: t('literature.contextPaste'),
        onSelect: () => void pasteToTarget(),
      });
    }
    if (!isMultiSelectMenu) {
      items.push({
        id: 'showInFolder',
        label: t('literature.contextShowInFolder'),
        onSelect: () => void handleShowInFolder(target),
      });
    }
    items.push({ id: 'sep1', type: 'separator' });
    items.push({
      id: 'delete',
      label: t('literature.contextDelete'),
      onSelect: () => void handleDeleteSelection(),
    });
    return items;
  }, [
    menu,
    isMultiSelectMenu,
    clipboard,
    t,
    openRename,
    cutSelection,
    copySelection,
    pasteToTarget,
    handleShowInFolder,
    handleDeleteSelection,
  ]);


  // === 导入(拖入 + 文件 picker 共用)===
  // 与 NotesList 的差异:不做 renderer 后缀白名单 —— 文献允许任意文件类型,
  // 非普通文件(目录 / symlink)由主进程 importLiteratureFile 拒(VALIDATION)。
  // 逐文件串行 await:store.importFromFile 每次成功后 load() 重拉,并发会把
  // 重拉叠成一团(串行 + in-flight 去重 = 稳)。
  const importFiles = useCallback(
    async (files: FileList | File[]) => {
      const dropped = Array.from(files);
      if (dropped.length === 0) {
        toast({ type: 'info', message: t('toast.importNoFile') });
        return;
      }
      let okCount = 0;
      let noPathCount = 0;
      const failed: string[] = [];
      for (const f of dropped) {
        const p = getDroppedFilePath(f);
        if (!p) {
          noPathCount += 1;
          continue;
        }
        try {
          // r161+ disk-folder:importFromFile 主进程侧始终落 kind 根
          //   (api.importLiteratureFromFile 不接受 targetRelPath),导入
          //   完成后若在某个文件夹内,把刚导入的副本用 api.litMove 搬到
          //   当前文件夹 —— 两步走形态(同 notes store paste(copy))。
          //   失败走 toast(import 成功 + 移动失败)用户能看见副本但位
          //   置在 kind 根,主动再移一次即可。
          //
          // r177:导入后**不再自动打开**(用户要求「导入文件后不应该马上
          //   自动打开」)。旧行为会在导入成功后 select(最后一条)+切到
          //   library 面板 —— 把用户正在读的 PDF 顶掉。搬移后的新 id
          //   (lit id = 'lit:'+absPath)没人再要用(不选中),只判成败。
          const r = await importFromFile(p);
          if (folders.targetRelPath !== null) {
            const mv = await api.litMove(r.id, folders.targetRelPath);
            if (!mv.ok) {
              failed.push(`${f.name}: import ok but move to folder failed (${mv.code})`);
            }
          }
          okCount += 1;
        } catch (err: unknown) {
          failed.push(`${f.name}: ${errMsg(err)}`);
        }
      }
      if (noPathCount > 0) {
        toast({
          type: 'warning',
          message: t('literature.dropNoPath', { n: noPathCount }),
          duration: 6000,
        });
      }
      if (okCount > 0) {
        // 不 select / 不切面板 —— 导入完只留列表里的新行 + 一条 toast。
        toast({ type: 'success', message: t('literature.importSuccess', { n: okCount }) });
      }
      if (failed.length > 0) {
        toast({
          type: 'error',
          message: t('literature.importFailedToast', { msg: failed.slice(0, 3).join('\n') }),
          duration: 6000,
        });
      }
    },
    [t, toast, importFromFile, folders.targetRelPath],
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

  // === 空白区域菜单(audit-r131)===
  //   挂在列表 wrapper 的 onContextMenu:资源行 / 文件夹行右键都已
  //   stopPropagation,冒泡到这里 = 空白(含空态 —— 空文件夹里也必须能
  //   粘贴,这是「剪切后无处可粘」报障的本体)。入口:导入文件 / 新建
  //   文件夹 / 粘贴(文献剪贴板)/ 粘贴(文件夹剪贴板)/ 全选。
  const [containerMenu, setContainerMenu] = useState<{ x: number; y: number } | null>(null);
  const handleContainerContextMenu = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    setContainerMenu({ x: e.clientX, y: e.clientY });
  }, []);

  // audit-r226:wrapper 级 DnD 落点三件套已收编进 useSidebarDropZone,
  //   handler 由上方解构提供;r134 语义注释见 hook 头注。


  // audit-r232:文件夹行菜单 + 空白区菜单两段逐字同构块已收编进
  //   hooks/use-sidebar-menus.ts(两域单一真相源,同 r224-r227 收编法);
  //   本域只注入「空白区首项」(文献=导入文件)与「粘贴项 label key」。
  const folderMenuItems = useFolderMenuItems({ folders, clipboard, pasteTo, runFolderOp });
  const containerMenuItems = useContainerMenuItems({
    folders,
    clipboard,
    pasteToTarget,
    runFolderOp,
    searchActive,
    visibleItems,
    primaryItem: { id: 'import', labelKey: 'literature.listEmptyAction', onSelect: triggerFilePicker },
    pasteLabelKey: 'literature.contextPaste',
    selectMany,
  });
  // audit-r136 (2026-10-19):Virtuoso itemContent 锁稳定引用 —— 行内本来是
  //   inline `(_index, row) => {...}` 闭包,父级任一 state 变化都换新函数引用
  //   → Virtuoso 看见 itemContent 变化就重渲所有可见 row;与「用 useCallback
  //   锁 callback 给 FolderRowOption」配对完成 memo 闭包。deps 只列真影响
  //   渲染输出的字段(visible 决定 + 选中态 + 剪贴板 + active)。
  const itemContent = useCallback(
    (_index: number, row: TreeRow<LiteratureResource>) => {
      if (row.rowType === 'folder') {
        const f = row.folder;
        return (
          <FolderRowOption
            folder={f}
            domId={sidebarRowDomId('lit-row', row.id)}
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
            domId={sidebarRowDomId('lit-row', row.id)}
            depth={row.depth}
            posInSet={row.posInSet}
            setSize={row.setSize}
            onCommit={commitFolderEdit}
            onCancel={folders.cancelEdit}
          />
        );
      }
      const r = row.item;
      return (
        <LiteratureRow
          res={r}
          isSelected={selectedId === r.id}
          isMultiSelected={selectedIds.has(r.id)}
          // audit-r143:键盘 roving active 项视觉态;selected 是主选中,
          //   active 是键盘当前 focus 项(FolderChrome 已用此模式)。
          isActive={activeId === r.id}
          isCut={clipboard?.mode === 'cut' && clipboard.ids.includes(r.id)}
          isFavorited={favoritedFileIds.has(r.id)}
          // r176:缩进层级(树里文件跟着所属目录缩进)。
          depth={row.depth}
          posInSet={row.posInSet}
          setSize={row.setSize}
          onSelect={handleSelect}
          onToggleFavorite={handleToggleFavorite}
          onContextMenu={openContextMenuForRow}
          onContextMenuAt={openContextMenuAt}
          onHover={handleHover}
          onDragStart={handleItemDragStart}
          // audit-r144:reorder 四件套 + 落点指示线(dragstart 已收编到父级 startItemsDrag)
          onReorderDragOver={handleItemReorderDragOver}
          onReorderDragLeave={handleItemReorderDragLeave}
          onReorderDrop={handleItemReorderDrop}
          onReorderDragEnd={handleItemReorderDragEnd}
          reorderIndicator={reorderIndicator?.id === r.id ? reorderIndicator.position : null}
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
      favoritedFileIds,
      handleSelect,
      handleToggleFavorite,
      openContextMenuForRow,
      openContextMenuAt,
      handleHover,
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
      aria-hidden={dragActive ? 'true' : undefined}
      onDragOver={handleDragOver}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* === Header(与 NotesList 同结构:模块名 label + 计数 + 操作按钮) === */}
      <div className="border-b border-border-subtle bg-bg flex-shrink-0">
        <div className="px-3 py-2 flex items-center gap-2">
          <span className="text-2xs font-semibold text-fg-secondary tracking-wider uppercase">
            {t('workbench.tabLibrary')}
          </span>
          <span
            className="text-2xs text-fg-tertiary tabular-nums"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {displayCount === items.length
              ? t('literature.listCount', { total: items.length })
              : t('literature.listCountFiltered', {
                  filtered: displayCount,
                  total: items.length,
                })}
          </span>
          <div className="flex-1" />
          {/* 「全部 / 仅收藏」radiogroup(audit-r72,旧 LibraryList filter chip
              原样恢复;!text-2xs !h-6 是 r41 竖排修复的 caller 侧半套) */}
          <div
            {...filterRadio.getContainerProps()}
            aria-label={t('literature.filterGroupAria')}
            className="flex items-center gap-0.5 panel p-0.5 text-2xs"
          >
            {(['all', 'favorites'] as const).map((mode) => (
              <RadioChip
                key={mode}
                {...filterRadio.getItemProps(mode)}
                aria-label={
                  mode === 'all'
                    ? t('literature.filterAllAria')
                    : t('literature.filterFavoritesAria')
                }
                title={
                  mode === 'all'
                    ? t('literature.filterAllAria')
                    : t('literature.filterFavoritesAria')
                }
                className="px-2 py-0.5 rounded !text-2xs !h-6"
              >
                {mode === 'all' ? t('literature.filterAll') : t('literature.filterFavorites')}
              </RadioChip>
            ))}
          </div>
          {/* 0007 虚拟文件夹:新建文件夹(mod+Shift+N,inline input 落当前夹) */}
          {/* r175:搜索态 disabled —— 与 NotesList 同款(hook 内部已 gate,
              按钮上把状态摆出来,避免「点了没反应」)。 */}
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
          <Button
            variant="ghost"
            size="xs"
            onClick={triggerFilePicker}
            aria-label={t('literature.importButtonAria')}
            title={t('literature.importButtonAria')}
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
              placeholder={t('literature.searchPlaceholder')}
              aria-label={t('literature.searchAria')}
              inputClassName="pl-7 pr-7 h-7 text-2xs"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label={t('literature.searchClearAria')}
                // 44×44 touch target(同 NotesList / 历史 LibraryList)
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
          lastError ? (
            <EmptyState
              size="sm"
              accent="library"
              icon={<FileText size={20} aria-hidden="true" />}
              title={t('literature.loadFailedTitle')}
              description={t('literature.loadFailedDesc')}
              liveRegion="assertive"
              action={
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    void load();
                  }}
                  aria-label={t('literature.loadFailedRetry')}
                  title={lastError ?? undefined}
                >
                  {t('literature.loadFailedRetry')}
                </Button>
              }
            />
          ) : (
            <EmptyState
              size="sm"
              accent="library"
              icon={<FileText size={20} aria-hidden="true" />}
              title={
                query.trim()
                  ? t('literature.emptySearchTitle', { query })
                  : filter === 'favorites'
                    ? t('literature.emptyFavoritesTitle')
                    : t('literature.listEmptyTitle')
              }
              description={
                query.trim()
                  ? t('literature.emptySearchDesc')
                  : filter === 'favorites'
                    ? t('literature.emptyFavorites')
                    : t('literature.listEmptyDesc')
              }
              liveRegion="polite"
              action={
                !query.trim() && filter === 'all' && (
                  <Button variant="primary" size="sm" onClick={triggerFilePicker}>
                    <Download size={12} aria-hidden="true" /> {t('literature.listEmptyAction')}
                  </Button>
                )
              }
            />
          )
        ) : (
          <div
            ref={listboxRef}
            // r176:listbox → tree —— 侧栏是层级结构,aria-level / aria-expanded
            //   只在 role=treeitem 上有效,行也一并升格(见 LiteratureRow /
            //   FolderRowOption)。
            role="tree"
            aria-multiselectable="true"
            aria-label={t('literature.listAria')}
            aria-activedescendant={activeId ? sidebarRowDomId('lit-row', activeId) : undefined}
            tabIndex={0}
            onKeyDown={handleListboxKeyDown}
            className="h-full outline-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
          >
            <Virtuoso
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

      {/* === 右键菜单(资源行 + 文件夹行,两份独立 state)=== */}
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={menuItems}
        onClose={() => setMenu(null)}
      />
      <ContextMenu
        open={folders.folderMenu !== null}
        x={folders.folderMenu?.x ?? 0}
        y={folders.folderMenu?.y ?? 0}
        items={folderMenuItems}
        onClose={() => folders.setFolderMenu(null)}
      />
      {/* === 空白区域右键菜单(audit-r131:导入 / 新建文件夹 / 粘贴 / 全选)=== */}
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
        ariaLabel={t('literature.dropOverlay')}
        text={t('literature.dropOverlay')}
        testId="literature-drop-overlay"
      />

      {/* hidden file picker(SR 跳过;由 header 导入按钮触发) */}
      <input
        ref={filePickerRef}
        type="file"
        multiple
        className="hidden"
        aria-hidden="true"
        onChange={onFilePickerChange}
      />

      {/* === r187:重命名弹窗(文献单文件改名,与 notes 域同款)=== */}
      {/* 语义:description 宣读「扩展名自动沿用」这条先验(用户改名前
          就知道不写扩展名会发生什么);error 走 Input.error(原语自带
          aria-invalid + role=alert),两条通道互不抢语义。 */}
      <Modal
        open={renameTarget !== null}
        onClose={closeRename}
        title={t('literature.renameTitle')}
        description={t('literature.renameExtensionHint')}
        initialFocusRef={renameInputRef}
        footer={
          <>
            <Button variant="ghost" onClick={closeRename} disabled={renameBusy}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={() => void doRename()}
              loading={renameBusy}
              disabled={renameDraft.trim() === ''}
            >
              {t('modal.renameLiteratureConfirm')}
            </Button>
          </>
        }
      >
        <label htmlFor="lit-rename-input" className="block text-xs text-fg-secondary mb-1.5">
          {t('literature.renameFilenameLabel')}
        </label>
        <Input
          id="lit-rename-input"
          ref={renameInputRef}
          value={renameDraft}
          onChange={(v) => {
            setRenameDraft(v);
            if (renameError) setRenameError(null);
          }}
          autoFocus
          error={renameError ?? undefined}
          onKeyDown={(e) => {
            // IME 选词期间的 Enter 不是提交(同 notes 域 r80)。
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              void doRename();
            }
          }}
        />
      </Modal>
    </div>
  );
}

// === 单行:文件图标 + 完整文件名 + size · timeAgo ===
// memo + 稳定 callback props(同 NoteRow):Virtuoso 大列表下只有受影响的行重渲。
const LiteratureRow = memo(function LiteratureRow({
  res,
  isSelected,
  isMultiSelected,
  isActive,
  isCut,
  isFavorited,
  depth,
  posInSet,
  setSize,
  onSelect,
  onToggleFavorite,
  onContextMenu,
  onContextMenuAt,
  onHover,
  onDragStart,
  // audit-r144:reorder 四件套(dragstart 已收编到 startItemsDrag 一次投递两 MIME)
  onReorderDragOver,
  onReorderDragLeave,
  onReorderDrop,
  onReorderDragEnd,
  reorderIndicator,
}: {
  res: LiteratureResource;
  isSelected: boolean;
  // 0007/多选(同 NoteRow):集合成员(含主选中)拿 aria-selected + 次级高亮。
  isMultiSelected: boolean;
  // audit-r143:键盘 roving active 视觉态(见 .list-row-active,globals.css)。
  //   selected = 主选中,active = 键盘当前 focus 项,二者独立。
  isActive: boolean;
  /** 在剪切剪贴板里 → 半透明(VS Code 待粘贴态)。 */
  isCut: boolean;
  isFavorited: boolean;
  /** r176:树层级缩进(根的直接子级 = 0)。 */
  depth: number;
  posInSet: number;
  setSize: number;
  // 第二参透传 MouseEvent → 父级按修饰键路由单选/toggle/range(见 handleSelect)
  onSelect: (res: LiteratureResource, e?: ReactMouseEvent) => void;
  onToggleFavorite: (e: ReactMouseEvent, res: LiteratureResource) => void | Promise<void>;
  onContextMenu: (res: LiteratureResource, e: ReactMouseEvent) => void;
  onContextMenuAt: (res: LiteratureResource, x: number, y: number) => void;
  onHover?: (res: LiteratureResource) => void;
  /** audit-r136:接 (res, e) 二参,内部 useMemo bound 到 row res,父级 useCallback 稳定 */
  onDragStart: (res: LiteratureResource, e: ReactDragEvent) => void;
  // audit-r144:reorder 落点四件套由父级统一从 useFolderSidebar.startItemsDrag
  //   投递的两 MIME 的 REORDER 那一份接听。dragstart 不再有 reorder handle
  //   分发 —— 整行直接走 onDragStart(startItemsDrag 一次性投递 MOVE + REORDER)。
  onReorderDragOver: (res: LiteratureResource, e: ReactDragEvent) => void;
  onReorderDragLeave: (res: LiteratureResource, e: ReactDragEvent) => void;
  onReorderDrop: (res: LiteratureResource, e: ReactDragEvent) => void;
  onReorderDragEnd: (e: ReactDragEvent) => void;
  reorderIndicator: 'before' | 'after' | null;
}) {
  const { t } = useTranslation();
  // 标题用完整文件名(带扩展名)—— 文献场景里 .pdf / .docx / .txt 后缀是
  // 用户区分同名文件的第一信息,DB title(去后缀)只进搜索 haystack。
  const filename = useMemo(() => filenameOf(res.absPath), [res.absPath]);
  const handleClick = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      onSelect(res, e);
    },
    [onSelect, res],
  );
  const handleMouseEnter = useCallback(() => onHover?.(res), [onHover, res]);
  // audit-r136:onDragStart 走 useMemo bound(res, ·),父级 useCallback 稳定后
  //   memo 命中,setDropHot 60Hz 不再连带 LiteratureRow 重渲。
  // audit-r144:整行 dragstart 走 onDragStart,父级 startItemsDrag 内
  //   writeMovePayload + writeReorderPayload 一次投递两个 MIME,row 内部
  //   无需再按 handle/非 handle 分发。
  const handleDragStart = useMemo(
    () => (e: ReactDragEvent) => onDragStart(res, e),
    [onDragStart, res],
  );
  // audit-r143:reorder 落点四件套
  const handleReorderDragOver = useMemo(
    () => (e: ReactDragEvent) => onReorderDragOver(res, e),
    [onReorderDragOver, res],
  );
  const handleReorderDragLeave = useMemo(
    () => (e: ReactDragEvent) => onReorderDragLeave(res, e),
    [onReorderDragLeave, res],
  );
  const handleReorderDrop = useMemo(
    () => (e: ReactDragEvent) => onReorderDrop(res, e),
    [onReorderDrop, res],
  );
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // audit-r73:Enter/Space 只在焦点就是行本身时接管 —— 行首 ★ button 是
      // tab stop,它获得焦点时 Enter/Space 的原生激活(toggle 收藏)会冒泡进
      // 这里,若不加 gate,「按星标」会连带切走右侧阅读面板(按键劫持)。
      // Shift+F10 刻意不设 gate:星标焦点下也要能唤出所在行菜单。
      if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
        e.preventDefault();
        onSelect(res);
        return;
      }
      // Shift+F10 → 菜单(合成坐标路径,同 NoteRow a11y H6)
      if (e.shiftKey && e.key === 'F10') {
        e.preventDefault();
        const target = e.currentTarget as HTMLElement;
        const rect = target.getBoundingClientRect();
        onContextMenuAt(res, rect.left + rect.width / 2, rect.top + rect.height / 2);
      }
    },
    [onSelect, res, onContextMenuAt],
  );
  const handleContextMenu = useCallback(
    (e: ReactMouseEvent) => onContextMenu(res, e),
    [onContextMenu, res],
  );
  const agoText = useMemo(() => timeAgo(res.mtime, t), [res.mtime, t]);
  return (
    <div
      // r176:listbox → tree —— 侧栏改树状后,行升格成 treeitem(aria-level
      //   / aria-expanded 只在 treeitem 上有效)。
      role="treeitem"
      aria-selected={isSelected || isMultiSelected}
      aria-posinset={posInSet}
      aria-setsize={setSize}
      aria-level={depth + 1}
      tabIndex={-1}
      aria-haspopup="menu"
      id={`lit-row-${res.id}`}
      data-literature-id={res.id}
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
      // r176:缩进 = 层级 × 12px(内联 style 覆盖 .list-row 的 px-3)。
      style={{ paddingLeft: 12 + depth * 12 }}
    >
      {/* ★ 收藏(行首,hover/focus 显现;选中态恒亮 —— 旧 LibraryList FileRow 原形制) */}
      <button
        type="button"
        onClick={(e) => void onToggleFavorite(e, res)}
        aria-label={
          isFavorited
            ? t('literature.removeFavoriteAria', { title: filename })
            : t('literature.addFavoriteAria', { title: filename })
        }
        aria-pressed={isFavorited}
        className={clsx(
          'w-5 h-5 flex items-center justify-center rounded transition-colors duration-120 flex-shrink-0',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
          isFavorited
            ? 'text-warning hover:text-warning/80'
            // audit-r151 (2026-10-19) UX HIGH #4:★ 控制不再 opacity-0 +
            //   group-hover:opacity-100(touch/tablet 用户无 hover 态,★ 完全
            //   不可见,a11y 1.4.1 / 2.5.5 失守)。常显 + 键盘 focus-visible
            //   仍加强可见(WCAG 2.4.7 焦点可见兜底)。
            : 'text-fg-tertiary hover:text-warning focus-visible:opacity-100',
        )}
      >
        <Star size={12} aria-hidden="true" fill={isFavorited ? 'currentColor' : 'none'} />
      </button>
      <FileText size={12} className="text-fg-tertiary flex-shrink-0" aria-hidden="true" />
      <div className="flex-1 min-w-0">
        <div className="list-row-title">{filename}</div>
        <div className="list-row-meta">
          {t('literature.metaSep', { size: formatSize(res.size), ago: agoText })}
        </div>
      </div>
      {/* audit-r143:落点指示线(before / after),2px 横线,absolute 贴 row 边。 */}
      {reorderIndicator === 'before' && (
        <span
          data-testid="lit-reorder-indicator-before"
          aria-hidden="true"
          className="absolute left-0 right-0 top-0 h-0.5 bg-accent pointer-events-none"
        />
      )}
      {reorderIndicator === 'after' && (
        <span
          data-testid="lit-reorder-indicator-after"
          aria-hidden="true"
          className="absolute left-0 right-0 bottom-0 h-0.5 bg-accent pointer-events-none"
        />
      )}
    </div>
  );
});
