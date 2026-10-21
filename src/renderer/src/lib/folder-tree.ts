// src/renderer/src/lib/folder-tree.ts
//
// r176:左侧栏文件列表改**树状** —— 目录层级直接摊开,不再「点进去钻入」。
//
// 此前(r161~r175)是**钻入式**:点文件夹 → 进入该目录 → 顶部出现面包屑 →
// 列表只显示该目录的**一层**直接子级。用户想看目录层级本身,却必须一层层
// 点进去 + 读面包屑。本模块把「行合成」从钻入式改成树式。
//
// 形状(与 VS Code 资源管理器一致):
//   <根>├── <子文件夹>…        ← 文件夹在前
//        ├── <文件>…          ← 文件在后
//        └── <子文件夹>…
//   - depth 从 0 起(根的直接子级 = 0)
//   - 折叠的文件夹不递归下去;展开的才把子树插在它自己下面
//   - 搜索态:跨目录全局命中 → 扁平文件行,不渲染文件夹行(VS Code 同理)
//
// 三个数据源(全部由调用方喂进来,本模块无 IO / 无 React):
//   childrenByDir:目录 relPath(根 = '')→ 该目录的**子文件夹**列表
//   itemsByDir:   目录 relPath(根 = '')→ 该目录直属的**资源行**
//   expanded:     已展开的文件夹 relPath 集合
//
// 为什么单独一个模块:树行合成是纯计算,放 lib 里能不起 React 就单测
// (行为锁:tests/unit/renderer/lib/folder-tree.test.ts)。行类型也从 folder-view.ts
// 搬过来 —— 避免两个模块互相 import 形成环。
import type { DiskFolderNode } from '@shared/types';
import { dirnameOfRelPath, folderRowId } from './folder-view';

/**
 * 「新建文件夹」inline input 行的固定 id。
 *
 * r176 换了命名空间:旧值 'folder:new' 与**真名为 "new" 的文件夹**的行 id
 * ('folder:new')字面撞车 —— 两行同 id ⇒ Virtuoso computeItemKey 撞 key、
 * aria-activedescendant 指错行。'input:' 前缀与 'folder:' 资源 id 空间
 * 天然隔离。
 */
export const NEW_FOLDER_ROW_ID = 'input:new-folder';

/** 树行 —— 文件夹分支。 */
export interface TreeFolderRow {
  rowType: 'folder';
  /** 行 id = folderRowId(relPath) = 'folder:<relPath>'。 */
  id: string;
  folder: DiskFolderNode;
  /** 缩进层级(根的直接子级 = 0)。 */
  depth: number;
  /** 是否处于展开态。 */
  expanded: boolean;
  /**
   * 是否有子节点(画不画 chevron)。
   * 未知态(该目录还没 listDirs 过)按**乐观**处理 = true,展开后由缓存纠正。
   */
  hasChildren: boolean;
  /** 是否是当前落点文件夹(新建 / 粘贴的目标)。 */
  isTarget: boolean;
  /** 所在目录的 relPath(根 = '')。 */
  parentRelPath: string;
  /** 同级序号(1-based)—— 与同目录的文件夹 / 文件 / input 行合算。 */
  posInSet: number;
  /** 同级总数。 */
  setSize: number;
}

/** 树行 —— 资源分支(笔记 / 文献)。 */
export interface TreeItemRow<T> {
  rowType: 'item';
  /** 行 id = 资源自身 id。 */
  id: string;
  item: T;
  depth: number;
  parentRelPath: string;
  posInSet: number;
  setSize: number;
}

/** 树行 —— 新建文件夹 inline input 分支。 */
export interface TreeInputRow {
  rowType: 'input';
  id: string;
  depth: number;
  parentRelPath: string;
  posInSet: number;
  setSize: number;
}

export type TreeRow<T> = TreeFolderRow | TreeItemRow<T> | TreeInputRow;

/** 资源按所属目录分组(dirname(relPath) → 该目录直属的资源)。 */
export function groupItemsByDir<T extends { relPath?: string | null }>(
  items: readonly T[],
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const it of items) {
    const dir = dirnameOfRelPath(it);
    const arr = out.get(dir);
    if (arr) arr.push(it);
    else out.set(dir, [it]);
  }
  return out;
}

/** 目录是否有子节点 —— 未知(未加载)时乐观返回 true。 */
function dirHasChildren<T>(
  relPath: string,
  childrenByDir: ReadonlyMap<string, readonly DiskFolderNode[]>,
  itemsByDir: ReadonlyMap<string, readonly T[]>,
): boolean {
  const items = itemsByDir.get(relPath);
  if (items && items.length > 0) return true;
  const children = childrenByDir.get(relPath);
  if (children) return children.length > 0;
  // 还没 listDirs 过 —— 乐观画 chevron,展开后缓存会纠正(空目录则消失)。
  return true;
}

export interface BuildTreeRowsArgs<T> {
  /** 目录 relPath(根 = '')→ 子文件夹列表。 */
  childrenByDir: ReadonlyMap<string, readonly DiskFolderNode[]>;
  /** 目录 relPath(根 = '')→ 直属资源行。 */
  itemsByDir: ReadonlyMap<string, readonly T[]>;
  /** 已展开的文件夹 relPath。 */
  expanded: ReadonlySet<string>;
  /** 当前落点文件夹 relPath(null = 根)。 */
  targetRelPath: string | null;
  /** 搜索态 —— 扁平返回 searchItems,不渲染文件夹行。 */
  searchActive: boolean;
  /** 搜索态的扁平命中列表(已按 query 过滤)。 */
  searchItems?: readonly T[];
  /**
   * 待渲染的「新建文件夹」inline input —— 挂在哪个目录下。
   * null = 不渲染。parentRelPath 为 null = 根目录。
   */
  pendingInput?: { parentRelPath: string | null } | null;
}

/**
 * 合成树行(深度优先)。
 *
 * 同一目录下的顺序:**文件夹 → input 行 → 文件**(VS Code 资源管理器同款:
 * 文件夹在前,文件在后)。
 *
 * aria-posinset / aria-setsize 按**同级**算(同一 parentRelPath 的文件夹 +
 * 文件 + input 行合起来是一个集合),不是全局序号 —— 树语义下 setsize
 * 描述的是「我这一层有几个兄弟」。
 */
export function buildTreeRows<T extends { id: string }>(
  args: BuildTreeRowsArgs<T>,
): TreeRow<T>[] {
  const { childrenByDir, itemsByDir, expanded, targetRelPath, searchActive } = args;

  if (searchActive) {
    const items = args.searchItems ?? [];
    return items.map((item, i) => ({
      rowType: 'item' as const,
      id: item.id,
      item,
      depth: 0,
      parentRelPath: '',
      posInSet: i + 1,
      setSize: items.length,
    }));
  }

  const out: TreeRow<T>[] = [];
  // pendingInput.parentRelPath = null 表示「在**根目录**下建」—— 与
  // 「没有 pendingInput」是两回事,不能混。r176 初版用
  // `pendingInput?.parentRelPath ?? null` 归一,把「根目录」也变成了
  // null,于是 `inputParent !== null` 恒假 → **在根目录新建文件夹时
  // input 行永远不渲染**(用户点 ✚ 什么都不发生)。改成两个字段:
  //   pending      = 有没有待渲染的 input 行
  //   inputDirKey  = 它挂在哪个目录下(根 = '')
  const pending = args.pendingInput ?? null;
  const inputDirKey = pending ? (pending.parentRelPath ?? '') : null;

  const visit = (dirRelPath: string, depth: number): void => {
    const folders = childrenByDir.get(dirRelPath) ?? [];
    const items = itemsByDir.get(dirRelPath) ?? [];
    const hasInput = pending !== null && inputDirKey === dirRelPath;
    const setSize = folders.length + items.length + (hasInput ? 1 : 0);
    let pos = 0;

    for (const f of folders) {
      pos += 1;
      const isExpanded = expanded.has(f.relPath);
      out.push({
        rowType: 'folder',
        id: folderRowId(f.relPath),
        folder: f,
        depth,
        expanded: isExpanded,
        hasChildren: dirHasChildren(f.relPath, childrenByDir, itemsByDir),
        isTarget: targetRelPath === f.relPath,
        parentRelPath: dirRelPath,
        posInSet: pos,
        setSize,
      });
      if (isExpanded) visit(f.relPath, depth + 1);
    }

    if (hasInput) {
      pos += 1;
      out.push({
        rowType: 'input',
        id: NEW_FOLDER_ROW_ID,
        depth,
        parentRelPath: dirRelPath,
        posInSet: pos,
        setSize,
      });
    }

    for (const it of items) {
      pos += 1;
      out.push({
        rowType: 'item',
        id: it.id,
        item: it,
        depth,
        parentRelPath: dirRelPath,
        posInSet: pos,
        setSize,
      });
    }
  };

  visit('', 0);
  return out;
}

/**
 * 找某行的**父文件夹行**(树键盘 ← 键用)。
 *
 * 判据 = 存在一个文件夹行,其 relPath === 当前行的 parentRelPath。
 * 根目录下的行没有父文件夹行 → 返回 null(调用方 no-op)。
 */
export function findParentFolderRow<T>(
  rows: readonly TreeRow<T>[],
  row: TreeRow<T>,
): TreeFolderRow | null {
  if (!row.parentRelPath) return null;
  for (const r of rows) {
    if (r.rowType === 'folder' && r.folder.relPath === row.parentRelPath) return r;
  }
  return null;
}

/**
 * 找某文件夹行的**第一个子行**(树键盘 → 键用)。
 *
 * 树是**扁平**渲染的(Virtuoso 一维列表),子行紧跟在父文件夹行之后 ——
 * 所以第一个子行 = 下一行(前提:父文件夹处于展开态)。
 */
export function findFirstChildRow<T>(
  rows: readonly TreeRow<T>[],
  index: number,
): TreeRow<T> | null {
  const row = rows[index];
  if (!row || row.rowType !== 'folder' || !row.expanded) return null;
  return rows[index + 1] ?? null;
}
