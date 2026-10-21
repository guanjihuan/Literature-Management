// use-listbox-keys:侧栏 listbox 的容器级键盘处理(mod+c/x/v/a/n、F2、
//   Delete、Enter/Space commit、←/→ 树导航)。
//
// audit-r225 (2026-10-20):本 hook 是 NotesList / LiteratureList 里
//   handleListboxKeyDown 的同构块收编(收编前 153 行 vs 136 行,sim 0.80)。
//   差异全部收敛为注入点,行为逐路对账如下:
//   - mod+V:notes 走 `handlePaste()`(内部自行解析落点),lit 走
//     `pasteTo(folders.targetRelPath)` ⇒ 注入 `onPasteItems`;
//   - F2 在 item 行:notes = 重命名笔记(VS Code 同款,r134),lit 无此
//     分支(r71 文献重建未恢复磁盘 rename)⇒ 注入可选 `onRenameItem`,
//     不传则 F2 只处理文件夹行(= lit 原行为);
//   - Delete 在 item 行:notes `=== 'item'` + handleTrashSelection,lit
//     `!== 'input'` + handleDeleteSelection —— rowType 是封闭三元并
//     {'folder','item','input'}(lib/folder-tree.ts:85),folder 分支已
//     return,两种写法**等价** ⇒ 统一为 `=== 'item'` + 注入
//     `onDeleteSelection`;
//   - 其余(mod+c/x/a/n、Enter/Space gate、←/→ 树导航)两文件逐字相同,
//     r76/r131/r134/r176 的注释原样随行。
//
// 与 use-reorder-dnd 同一模式:`useLatestValue(opts)` + deps [latest] ⇒
//   handler 身份恒定(rows/visibleItems 每次渲染都变,旧 deps 数组让
//   handler 每帧换新;事件触发时现读最新值,语义等价但更稳)。

import { useCallback, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { TreeRow } from '../lib/folder-tree';
import { findFirstChildRow, findParentFolderRow } from '../lib/folder-tree';
import type { DiskFolderSidebar } from './useDiskFolderSidebar';
import { useLatestValue } from './useLatestValue';

export interface UseListboxKeysOptions<T> {
  rows: TreeRow<T>[];
  activeId: string | null;
  /** 当前文件夹可见项(mod+A 全选的范围)。 */
  visibleItems: T[];
  /** 条目剪贴板非空 ⇒ mod+V 走 onPasteItems,空则兜底文件夹剪贴板(r131)。 */
  clipboard: unknown | null;
  searchActive: boolean;
  folders: DiskFolderSidebar;
  copySelection: () => void;
  cutSelection: () => void;
  /** mod+V 且条目剪贴板非空时调用(两域落点解析不同,见头注)。 */
  onPasteItems: () => unknown;
  runFolderOp: (op: () => Promise<unknown>) => void;
  selectMany: (ids: string[]) => void;
  /** Delete 落在 item 行时调用(笔记=回收站 / 文献=删除,由 caller 定)。 */
  onDeleteSelection: () => unknown;
  /** Enter/Space 落在 item 行的 commit。 */
  handleSelect: (item: T) => void;
  handleActiveById: (id: string) => void;
  /** F2 落在 item 行时调用;不传 ⇒ F2 只处理文件夹行(文献域原行为)。 */
  onRenameItem?: (id: string) => void;
}

export function useListboxKeys<T extends { id: string }>(
  opts: UseListboxKeysOptions<T>,
): (e: ReactKeyboardEvent) => void {
  const latest = useLatestValue(opts);

  return useCallback(
    (e: ReactKeyboardEvent) => {
      const {
        rows,
        activeId,
        visibleItems,
        clipboard,
        searchActive,
        folders,
        copySelection,
        cutSelection,
        onPasteItems,
        runFolderOp,
        selectMany,
        onDeleteSelection,
        handleSelect,
        handleActiveById,
        onRenameItem,
      } = latest.current;
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) {
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === 'c') {
          e.preventDefault();
          copySelection();
          return;
        }
        if (k === 'x') {
          e.preventDefault();
          // audit-r131:active 行是文件夹 → 剪切文件夹(与 F2/Delete 的
          //   文件夹行语义对齐);否则按选区剪切条目。
          const rowX = activeId ? rows.find((r) => r.id === activeId) : undefined;
          if (rowX && rowX.rowType === 'folder') folders.cutFolder(rowX.folder.relPath);
          else cutSelection();
          return;
        }
        if (k === 'v') {
          e.preventDefault();
          // audit-r131:剪贴板二选一 —— 条目剪贴板优先,空则文件夹剪贴板
          //   (旧实现剪切文件夹后 Ctrl+V 无任何反应)。r134:搜索态不兜底
          //   文件夹剪贴板 —— 目标 currentId 在搜索视图里不可见,粘贴落点
          //   用户无法目视确认(类 newSub 消失)。
          if (clipboard !== null) void onPasteItems();
          else if (folders.folderClipboard !== null && !searchActive) {
            runFolderOp(() => folders.pasteFolderInto(folders.targetRelPath));
          }
          return;
        }
        // Shift+mod+A 也允许(全选时 Shift 常还压着)—— 只选当前文件夹可见项。
        if (k === 'a') {
          e.preventDefault();
          selectMany(visibleItems.map((x) => x.id));
          return;
        }
        if (k === 'n' && e.shiftKey) {
          e.preventDefault();
          // r134:搜索态不接收 mod+Shift+N —— 当前文件夹在搜索视图不可见,
          //   input 行提交后新夹落点用户看不见(同 r131 newSub 消失)。等
          //   用户清空搜索后建立文件夹即可。
          if (!searchActive) folders.startCreate();
          return;
        }
      }
      if (e.key === 'F2') {
        const row = activeId ? rows.find((r) => r.id === activeId) : undefined;
        if (row && row.rowType === 'folder') {
          e.preventDefault();
          folders.startRename(row.folder);
        } else if (row && row.rowType === 'item' && onRenameItem) {
          // r134:VS Code 同款 —— F2 在笔记行 = 重命名。文献域不传
          //   onRenameItem(r71 文献重建未恢复磁盘 rename),F2 只处理 folder。
          e.preventDefault();
          onRenameItem(row.item.id);
        }
        return;
      }
      if (e.key === 'Delete' && activeId) {
        const row = rows.find((r) => r.id === activeId);
        if (row && row.rowType === 'folder') {
          e.preventDefault();
          void folders.requestDelete(row.folder);
          return;
        }
        if (row && row.rowType === 'item') {
          e.preventDefault();
          void onDeleteSelection();
        }
        return;
      }
      // audit-r76 (2026-10-17):Enter/Space 容器级 commit —— 旧实现 commit 只挂
      //   在行级 onKeyDown,而行 tabIndex=-1 只有「先鼠标点过行」才持有 DOM
      //   焦点;纯键盘路径(Tab 进 listbox → 方向键移 activeId → Enter)焦点
      //   停在容器上,commit 永远不触发(r45 契约「commit 由 click / Enter
      //   处理」在纯键盘路径下形同虚设)。
      //   gate `e.target === e.currentTarget`:行持有焦点时(点过行)行级
      //   handler 已 commit,事件冒泡到容器不能二次触发(同行级 r73 gate
      //   互斥模式)。
      // r176:树语义 —— active 行是文件夹 → Enter/Space = 设为落点 + 切换展开
      //   (不再是「钻入」,树里没有钻入这回事)。
      if ((e.key === 'Enter' || e.key === ' ') && !mod && e.target === e.currentTarget) {
        const row = activeId ? rows.find((r) => r.id === activeId) : undefined;
        if (row && row.rowType === 'folder') {
          e.preventDefault();
          folders.activateFolder(row.folder.relPath);
          return;
        }
        if (row && row.rowType === 'item') {
          e.preventDefault();
          handleSelect(row.item);
        }
        return;
      }
      // r176:树键盘模型 —— ←/→ 归树用(useListboxRove 只占 ↑↓HomeEnd,
      //   且它只 preventDefault 不 stopPropagation ⇒ 容器的 React onKeyDown
      //   照样收到这两个键,互不打架):
      //     → 折叠的文件夹 = 展开;已展开 = 跳到第一个子行
      //     ← 展开的文件夹 = 折叠;否则跳到父文件夹行
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const idx = activeId ? rows.findIndex((r) => r.id === activeId) : -1;
        const row = idx >= 0 ? rows[idx] : undefined;
        if (!row) return;
        if (e.key === 'ArrowRight') {
          if (row.rowType !== 'folder') return; // 文件行左右无意义
          e.preventDefault();
          if (!row.expanded) {
            folders.expandFolder(row.folder.relPath);
            return;
          }
          const child = findFirstChildRow(rows, idx);
          if (child) handleActiveById(child.id);
          return;
        }
        // ArrowLeft
        e.preventDefault();
        if (row.rowType === 'folder' && row.expanded) {
          folders.collapseFolder(row.folder.relPath);
          return;
        }
        const parent = findParentFolderRow(rows, row);
        if (parent) handleActiveById(parent.id);
        return;
      }
    },
    [latest],
  );
}
