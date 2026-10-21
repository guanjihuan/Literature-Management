// 侧栏右键菜单构造(收编 ⑤,r232)。
//
// NotesList / LiteratureList 里有两段**逐字同构**的菜单构造块:
//
//   ① 文件夹行菜单(folderMenuItems):新建子夹 / 重命名 / 剪切 /
//      粘贴(内容)/ 粘贴(文件夹)/ 移到根 / 删除 —— 两域的 id、
//      i18n key(folders.* 全共用)、动作、deps 全部一致;
//   ② 空白区菜单(containerMenuItems):首项(笔记=新建笔记,文献=导入)/
//      新建文件夹 / 粘贴(内容)/ 粘贴(文件夹)/ 全选 —— 只差首项与粘贴项
//      的 label key。
//
// 为什么值得收编(与 r224-r227 同一条理由):这两段是**用户可见的操作面**,
//   孪生块一旦分叉,后果是「某一域的某个文件夹操作消失或指向错目标」——
//   r228 就是孪生分叉长成真 bug 的实例(笔记域少一行 setActiveId ⇒ F2
//   重命名旧行)。收编后分叉在结构上不可能再长出来。
//
// 差异全部收敛为注入点(见两处 opts 注释),组件侧只保留「本域特有」的部分:
//   - 文件夹行菜单:**零注入**(完全共用);
//   - 空白区菜单:首项(本域主操作)+ 粘贴项 label key(两域 locale 树不同)。
//
// 行为契约(与收编前逐条一致,守卫见
// tests/unit/renderer/hooks/use-sidebar-menus.test.ts):
//   - 文件夹行菜单:menu 为空 ⇒ 空数组;「粘贴(内容)」仅在剪贴板非空时出现;
//     「粘贴(文件夹)」仅在文件夹剪贴板非空**且**不是自己时出现(防自粘);
//     「移到根」仅在非根目录出现;「删除」恒在末尾(前置 separator);
//   - 空白区菜单:搜索态隐藏「新建文件夹」与「粘贴(文件夹)」(落点在搜索视图
//     不可见 ⇒ 操作结果用户无法目视确认,同 r131/r134);粘贴块与「全选」各自
//     带 separator;「全选」仅在有可见条目时出现。
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { ContextMenuItem } from '../lib/context-menu-item';
import type { DiskFolderSidebar } from './useDiskFolderSidebar';

export interface SidebarFolderMenuOptions {
  /** useDiskFolderSidebar 的返回值(folderMenu / folderClipboard / 各动作)。 */
  folders: DiskFolderSidebar;
  /** 内容剪贴板(笔记/文献域各自的剪贴板状态);非 null ⇒ 有内容可粘。 */
  clipboard: unknown;
  /** 粘贴内容到指定文件夹(hooks/use-folder-ops.ts 提供)。 */
  pasteTo: (targetFolderId: string | null) => Promise<void>;
  /** 文件夹级异步动作的统一失败包装(hooks/use-folder-ops.ts 提供)。 */
  runFolderOp: (op: () => Promise<unknown>) => void;
}

/** 文件夹行右键菜单 —— 两域零注入,完全共用。 */
export function useFolderMenuItems(opts: SidebarFolderMenuOptions): ContextMenuItem[] {
  const { folders, clipboard, pasteTo, runFolderOp } = opts;
  const { t } = useTranslation();
  return useMemo<ContextMenuItem[]>(() => {
    const fm = folders.folderMenu;
    if (!fm) return [];
    const items: ContextMenuItem[] = [
      {
        id: 'newSub',
        label: t('folders.contextNewSubfolder'),
        onSelect: () => folders.startCreateSubfolder(fm.folder),
      },
      {
        id: 'rename',
        label: t('folders.contextRenameFolder'),
        onSelect: () => folders.startRename(fm.folder),
      },
      {
        id: 'cut',
        label: t('folders.contextCutFolder'),
        onSelect: () => folders.cutFolder(fm.folder.relPath),
      },
    ];
    if (clipboard !== null) {
      items.push({
        id: 'pasteItems',
        label: t('folders.contextPasteItems'),
        // r161+ disk-folder:DiskFolderNode 字段名 relPath(无独立 id)——
        //   旧 fm.folder.id 已是 undefined,过去 2 个 release 静默把资源
        //   粘贴到根而非所选文件夹,本轮修。
        onSelect: () => void pasteTo(fm.folder.relPath),
      });
    }
    if (folders.folderClipboard !== null && folders.folderClipboard !== fm.folder.relPath) {
      items.push({
        id: 'pasteFolder',
        label: t('folders.contextPasteFolder'),
        onSelect: () => runFolderOp(() => folders.pasteFolderInto(fm.folder.relPath)),
      });
    }
    // parentRelPath 缺省 = null(根);若非根 → 显示「移到根」菜单,目标目录
    //   moveFolderNow(folderRelPath, null)。
    if (fm.folder.parentRelPath !== null) {
      items.push({
        id: 'moveToRoot',
        label: t('folders.contextMoveFolderToRoot'),
        onSelect: () => runFolderOp(() => folders.moveFolderNow(fm.folder.relPath, null)),
      });
    }
    items.push({ id: 'sep1', type: 'separator' });
    items.push({
      id: 'delete',
      label: t('folders.contextDeleteFolder'),
      onSelect: () => void folders.requestDelete(fm.folder),
    });
    return items;
  }, [folders, clipboard, pasteTo, runFolderOp, t]);
}

export interface SidebarContainerMenuOptions {
  folders: DiskFolderSidebar;
  clipboard: unknown;
  /** 粘贴内容到当前落点文件夹(hooks/use-folder-ops.ts 提供)。 */
  pasteToTarget: () => void;
  runFolderOp: (op: () => Promise<unknown>) => void;
  /** 搜索态:隐藏「新建文件夹」/「粘贴(文件夹)」(落点不可见)。 */
  searchActive: boolean;
  /** 当前可见条目(只用到 id);决定「全选」是否出现。 */
  visibleItems: ReadonlyArray<{ id: string }>;
  /** 本域主操作(笔记域=新建笔记,文献域=导入文件)。 */
  primaryItem: { id: string; labelKey: string; onSelect: () => void };
  /** 粘贴项 label key(两域 locale 树不同:notes.contextPaste / literature.contextPaste)。 */
  pasteLabelKey: string;
  /** 全选(把可见条目的 id 一次选中;store action 名沿用 selectMany)。 */
  selectMany: (ids: string[]) => void;
}

/** 空白区(容器)右键菜单 —— 两域只差首项与粘贴项 label。 */
export function useContainerMenuItems(opts: SidebarContainerMenuOptions): ContextMenuItem[] {
  const {
    folders,
    clipboard,
    pasteToTarget,
    runFolderOp,
    searchActive,
    visibleItems,
    primaryItem,
    pasteLabelKey,
    selectMany,
  } = opts;
  const { t } = useTranslation();
  // primaryItem 是对象字面量,每次渲染新身份 ⇒ 拆成三个字段做 deps,
  // 免得整段 memo 每帧重算。
  const primaryId = primaryItem.id;
  const primaryLabelKey = primaryItem.labelKey;
  const primaryOnSelect = primaryItem.onSelect;
  return useMemo<ContextMenuItem[]>(() => {
    const items: ContextMenuItem[] = [
      {
        id: primaryId,
        label: t(primaryLabelKey),
        onSelect: () => primaryOnSelect(),
      },
    ];
    // r134:搜索态不出现「新建文件夹」/「粘贴文件夹」 —— 落点在 currentId,
    //   该夹在搜索视图不可见,操作结果用户无法目视确认(类 r131 newSub 消失)。
    //   剪贴板粘贴、全选、主操作保留(均影响 visibleItems,有反馈)。
    if (!searchActive) {
      items.push({
        id: 'newFolder',
        label: t('folders.contextNewFolder'),
        onSelect: () => folders.startCreate(),
      });
    }
    const pastes: ContextMenuItem[] = [];
    if (clipboard !== null) {
      pastes.push({
        id: 'paste',
        label: t(pasteLabelKey),
        onSelect: () => void pasteToTarget(),
      });
    }
    if (folders.folderClipboard !== null && !searchActive) {
      pastes.push({
        id: 'pasteFolder',
        label: t('folders.contextPasteFolder'),
        onSelect: () => runFolderOp(() => folders.pasteFolderInto(folders.targetRelPath)),
      });
    }
    if (pastes.length > 0) items.push({ id: 'sep1', type: 'separator' }, ...pastes);
    if (visibleItems.length > 0) {
      items.push({ id: 'sep2', type: 'separator' });
      items.push({
        id: 'selectAll',
        label: t('folders.contextSelectAll'),
        onSelect: () => selectMany(visibleItems.map((x) => x.id)),
      });
    }
    return items;
  }, [
    t,
    primaryId,
    primaryLabelKey,
    primaryOnSelect,
    folders,
    clipboard,
    pasteToTarget,
    runFolderOp,
    visibleItems,
    selectMany,
    searchActive,
    pasteLabelKey,
  ]);
}
