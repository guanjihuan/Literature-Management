// src/renderer/src/hooks/useDiskFolderSidebar.ts
//
// r161+ disk-folder 完整状态机(r166 一次性接 6 旧 stub;r173 接通跨级
//   文件夹搬移;r174 修右键坐标;r175 加序号守卫 + rename idRemap)。
//
// r176:整体改成**树状** —— 状态机从「钻入式」三件套
//   (currentRelPath / subdirs / chain)
// 换成**树**三件套:
//   - childrenByDir:目录 relPath(根 = '')→ 子文件夹列表(**懒加载**)
//   - expanded:       已展开的文件夹 relPath 集合
//   - targetRelPath:  当前落点文件夹(新建 / 粘贴 / 导入 / 剪切粘贴的目标)
//
// 展开态 + 落点态放在**模块级 registry**(按 ResourceKind 分桶)——
// WorkbenchListPanel 切 tab 会 unmount 列表(lazy + 单挂一个),useState
// 会跟着丢,用户每切一次 tab 树就复位。registry 让展开态跨 tab 存活
// (仍是纯内存,不落盘 —— 需求就是「只在内存保持」)。
//
// 瞬时 UI 态(editing / folderMenu / folderClipboard / dropHot)保持
//   useState —— 切 tab 丢了无所谓。
//
// DnD 载荷与语义(r173 接通的那套)全部不变:
//   - startItemsDrag → 写 MOVE + REORDER 两 MIME
//   - startFolderDrag → 写 MOVE(type='folder')
//   - handleTargetDrop → 读 MOVE,文件夹走 folders-move-dir,资源走
//     api.notesMove / api.litMove
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { Api } from '@shared/api-types';
import type { DiskFolderNode, ResourceKind } from '@shared/types';
import { confirm } from '../lib/confirm';
import { hasMovePayload, readMovePayload, writeMovePayload, writeReorderPayload } from '../lib/folder-dnd';

export const ROOT_DROP_ID = '__root__';

export type FolderEditingState =
  | { mode: 'create'; parentRelPath: string | null; name: string }
  | { mode: 'rename'; folder: DiskFolderNode; name: string };

export interface FolderMenuState {
  folder: DiskFolderNode;
  x: number;
  y: number;
}

export interface DiskFolderSidebar {
  /** 当前落点文件夹 relPath(null = 根)。新建 / 粘贴 / 导入都落这里。 */
  readonly targetRelPath: string | null;
  /** 已展开的文件夹 relPath 集合(只读视图)。 */
  readonly expanded: ReadonlySet<string>;
  /** 目录 relPath(根 = '')→ 子文件夹列表(只读视图)。 */
  readonly childrenByDir: ReadonlyMap<string, readonly DiskFolderNode[]>;
  /**
   * 点文件夹行 = **设为落点 + 切换展开**(一次手势两件事,VS Code 同款:
   * 点一下展开、再点一下折叠,落点始终记着最后点过的那个)。
   */
  activateFolder(relPath: string): void;
  /** 展开 / 折叠某文件夹(展开时才懒加载子项)。 */
  toggleFolder(relPath: string): void;
  /** 展开某文件夹(幂等)。 */
  expandFolder(relPath: string): void;
  /** 折叠某文件夹(幂等)。 */
  collapseFolder(relPath: string): void;
  /** 展开一路祖先(逐段)—— 把某个路径在树里露出来。 */
  expandTo(relPath: string): void;
  /** 走 IPC 创建子目录(parentRelPath 下建 newName)。 */
  createFolder(parentRelPath: string | null, newName: string): Promise<{ relPath: string }>;
  /** 走 IPC 重命名(单段)。 */
  renameFolder(oldRelPath: string, newName: string): Promise<{ relPath: string }>;
  /** 走 IPC 整棵子树丢回收站。 */
  trashFolder(relPath: string): Promise<void>;
  /** 「把资源项批量搬到目标目录」—— 走 IPC.fs.rename 跨目录。
   *  r168:返回 idRemap(oldId → {id, absPath?/relPath?})给 handleTargetDrop
   *  顺路回写到 store;失败仍 throw(errors 累计,语义同 r167)。 */
  moveItems(
    targetRelPath: string | null,
    ids: string[],
  ): Promise<Map<string, { id: string; absPath?: string; relPath?: string }>>;
  /** inline 编辑(create / rename)的当前态;null = 无编辑。 */
  readonly editing: FolderEditingState | null;
  /** 文件夹行右键菜单打开态;null = 关闭。 */
  readonly folderMenu: FolderMenuState | null;
  /** 被剪切的文件夹 relPath;null = 无。 */
  readonly folderClipboard: string | null;
  /** 拖拽中 drop hot 的目标 key;null = 无。 */
  readonly dropHot: string | null;
  /** 「新建文件夹」inline input(parent = 当前落点)。 */
  startCreate(): void;
  /** 「新建子文件夹」inline input(parent = 指定文件夹)。 */
  startCreateSubfolder(parent: DiskFolderNode): void;
  /** 把指定文件夹设为 inline rename 态(name = folder.name)。 */
  startRename(folder: DiskFolderNode): void;
  /** inline input 提交 — mode 决定 createFolder / renameFolder,name trim 留空 = cancel。 */
  // r176:返回 boolean —— FolderChrome 的 onCommit 契约是
  //   Promise<boolean>(true = 行将被撤掉,input 保持 busy;false = 留在
  //   原地可重试)。此前 shim 用 any 掩盖了 commitEdit(Promise<void>)与
  //   FolderChrome(Promise<boolean>)的签名错配,shim 下线后暴露。
  commitEdit(name: string): Promise<boolean>;
  /** inline input 取消 — 清 editing。 */
  cancelEdit(): void;
  /** 删文件夹(confirm modal + 走 trashFolder)。 */
  requestDelete(folder: DiskFolderNode): Promise<void>;
  /** 剪切文件夹(存 folderClipboard);同文件夹再切 = 取消剪切。 */
  cutFolder(folderRelPath: string): void;
  /** 把剪贴板文件夹粘贴到 targetParentRelPath(null = 根)。r173 接新 IPC。 */
  pasteFolderInto(targetParentRelPath: string | null): Promise<void>;
  /** 把 folderRelPath 显式搬到 targetParentRelPath(null = 根)。返回搬后目录 relPath。 */
  moveFolderNow(
    folderRelPath: string,
    targetParentRelPath: string | null,
  ): Promise<string>;
  /** 右键文件夹行打开菜单。 */
  openFolderContextMenu(folder: DiskFolderNode, x: number, y: number): void;
  /** 关菜单(背景点击 / menu onClose)。 */
  setFolderMenu(menu: FolderMenuState | null): void;
  /** 拖拽 row — list dragstart handler 调,内部 writeMovePayload(items MIME)。 */
  startItemsDrag(ids: string[], e: ReactDragEvent): void;
  /** 拖拽 folder row — list dragstart handler 调,内部 writeMovePayload(folder MIME)。r173 接 drop。 */
  startFolderDrag(folder: DiskFolderNode, e: ReactDragEvent): void;
  /** drop target dragover。 */
  handleTargetDragOver(e: ReactDragEvent, targetKey: string): void;
  /** drop target dragleave。 */
  handleTargetDragLeave(e: ReactDragEvent, targetKey: string): void;
  /** drop target drop(读 readMovePayload + 走 moveItems / moveFolderNow)。 */
  handleTargetDrop(e: ReactDragEvent, targetKey: string): Promise<void>;
  /** 内部拖拽 gate(检查 RKMS_MOVE_MIME 是否有挂载);非内部拖拽 = false,list 不 preventDefault
   *  让外层 OS 文件 import 路径照常跑。 */
  isInternalDrag(e: ReactDragEvent): boolean;
}

interface UseDiskFolderSidebarOptions {
  kind: ResourceKind;
  searchActive: boolean;
  api: Api;
  // r168:handleTargetDrop 成功走完 ipc.move + 拿到新 id 后回调 —— 给 store
  //   一把 (oldId → newNote/Lit) 让它把 selectedId / activeNoteFull 跳到新 id。
  //   不传 = drag 路径不刷 store(兼容既有调用),store 内 paste(cut)/moveToFolder
  //   已经自带重映射。
  onItemsMoved?: (idRemap: Map<string, { id: string; absPath?: string; relPath?: string }>) => void;
}

// === 模块级 registry(按 kind 分桶)===
//   切 tab 会 unmount 列表 ⇒ useState 丢失展开态。registry 让展开态 /
//   落点态 / 子目录缓存在切 tab 后存活(仍是纯内存,重启即丢 —— 需求就是
//   「只在内存保持」)。
//   注意:registry 是**可变对象**,每次改都整体替换(新 Set / 新 Map)——
//   引用变了才会让消费方的 useMemo 失效重算;原地 mutate 会让 memo 命中
//   旧值(UI 不更新)。
interface FolderTreeRegistry {
  expanded: Set<string>;
  targetRelPath: string | null;
  childrenByDir: Map<string, readonly DiskFolderNode[]>;
}

const registries = new Map<ResourceKind, FolderTreeRegistry>();

function getRegistry(kind: ResourceKind): FolderTreeRegistry {
  let r = registries.get(kind);
  if (!r) {
    r = { expanded: new Set(), targetRelPath: null, childrenByDir: new Map() };
    registries.set(kind, r);
  }
  return r;
}

/**
 * 清空 registry —— **仅供测试**。
 *
 * registry 是模块级单例,测试之间共享会互相污染(前一个用例展开的目录
 * 泄漏到下一个)。生产代码不调。
 */
export function resetFolderTreeRegistry(kind?: ResourceKind): void {
  if (kind) {
    registries.delete(kind);
    return;
  }
  registries.clear();
}

/**
 * 两个目录子项列表是否**等价**(顺序 + 内容都相同)。
 *
 * r184:外部目录改动会触发整棵树的缓存重载 —— 若每次都无条件换引用,
 *   「内容其实没变」也会引发一次全树重渲(notes 域每存一次笔记就
 *   来一发)。这里做等价判定,内容没变就不动引用。
 */
function sameFolderList(a: readonly DiskFolderNode[], b: readonly DiskFolderNode[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.relPath !== y.relPath || x.name !== y.name || x.parentRelPath !== y.parentRelPath) {
      return false;
    }
  }
  return true;
}

/** relPath 前缀重映射:p 在 oldPrefix 子树内 → 换成 newPrefix 子树;否则原样。 */
function remapPath(p: string, oldPrefix: string, newPrefix: string): string {
  if (p === oldPrefix) return newPrefix;
  if (p.startsWith(`${oldPrefix}/`)) return `${newPrefix}${p.slice(oldPrefix.length)}`;
  return p;
}

/** p 是否在 prefix 子树内(含自身)。 */
function underPrefix(p: string, prefix: string): boolean {
  return p === prefix || p.startsWith(`${prefix}/`);
}

/** 目录 key 的前缀重映射(根 key = '' 不参与重映射)。 */
function remapDirKey(key: string, oldPrefix: string, newPrefix: string): string {
  if (key === '') return key;
  return remapPath(key, oldPrefix, newPrefix);
}

/**
 * 把一个 DiskFolderNode 的 relPath / parentRelPath 按前缀重映射。
 * 目录改名 / 搬移后,整棵子树的路径都变了 —— 缓存里的节点对象必须跟着改,
 * 否则树上画出来的层级是旧路径。
 */
function remapNode(
  node: DiskFolderNode,
  oldPrefix: string,
  newPrefix: string,
): DiskFolderNode {
  const relPath = remapPath(node.relPath, oldPrefix, newPrefix);
  const parentRelPath =
    node.parentRelPath === null ? null : remapPath(node.parentRelPath, oldPrefix, newPrefix);
  // 名字 = 新路径的最后一段(被改名的那个文件夹 = 新名;子孙 = 原名不变)。
  const name = relPath.slice(relPath.lastIndexOf('/') + 1) || node.name;
  return { ...node, relPath, parentRelPath, name };
}

export function useDiskFolderSidebar({
  kind,
  searchActive,
  api,
  onItemsMoved,
}: UseDiskFolderSidebarOptions): DiskFolderSidebar {
  // audit-r206:删除确认框文案要走 i18n(旧实现硬编码英文)。
  const { t } = useTranslation();
  const registry = useMemo(() => getRegistry(kind), [kind]);
  // registry 是外部可变存储 —— 用一个自增计数器触发重渲。
  const [, forceUpdate] = useReducer((x: number) => x + 1, 0);

  const [editing, setEditing] = useState<FolderEditingState | null>(null);
  const [folderMenu, setFolderMenu] = useState<FolderMenuState | null>(null);
  const [folderClipboard, setFolderClipboard] = useState<string | null>(null);
  const [dropHot, setDropHot] = useState<string | null>(null);

  // === 子目录懒加载 ===
  //   每个目录一次 listDirs IPC,结果进 childrenByDir 缓存。展开时才拉。
  //
  //   r175 的**序号守卫**在树形态下改成**按目录**计数:同一目录并发两次
  //   拉取(展开 → 立刻折叠 → 再展开)时,先发的响应后到会覆盖新快照。
  //   按目录计数让「A 目录的响应」不会污染「B 目录的缓存」。
  const loadSeqRef = useRef(new Map<string, number>());

  const loadChildren = useCallback(
    async (dirKey: string): Promise<void> => {
      const seq = (loadSeqRef.current.get(dirKey) ?? 0) + 1;
      loadSeqRef.current.set(dirKey, seq);
      const listDirs = kind === 'note' ? api.notesListDirs : api.litListDirs;
      // 根目录 = 空串(树内 key)→ IPC 侧是 null。
      const res = await listDirs(kind, dirKey === '' ? null : dirKey);
      if (loadSeqRef.current.get(dirKey) !== seq) return; // 已有更新的请求 → 丢弃陈旧快照
      const list = res.ok ? res.data : [];
      // r184:内容没变就不换引用 —— 否则每次外部事件(哪怕磁盘上什么
      //   都没变)都会引发一次全树重渲。
      const prev = registry.childrenByDir.get(dirKey);
      if (prev && sameFolderList(prev, list)) return;
      const next = new Map(registry.childrenByDir);
      next.set(dirKey, list);
      registry.childrenByDir = next;
      forceUpdate();
    },
    [kind, api, registry],
  );

  // === r184:外部目录改动 → 树缓存失效并重载 ===
  //
  // 树的 childrenByDir 是**懒加载 + 缓存**的,只靠应用自己的操作
  // (新建 / 改名 / 删除 / 搬移)去修正。用户在资源管理器里建了夹 / 删了
  // 夹 / 改了名 —— 磁盘变了,缓存没变 ⇒ 侧栏与文件夹对不上:
  //   - 外部新建的夹**永远不出现**(且 expandFolder 只在「没缓存过」时
  //     才拉 ⇒ 折叠再展开也刷不出来);
  //   - 外部删掉的夹**永远还在**(点进去是空的);
  //   - 外部改名的夹显示**旧名**,里面文件的 relPath 变了 ⇒ 文件行从
  //     当前目录视图里「消失」(用户视角:文件凭空不见了)。
  //
  // 修法:订阅本域的 changed 推送(notes:changed / literature:changed),
  //   把**所有已缓存目录**重拉一遍,并清掉已经不存在(孤儿)的缓存键。
  //   重拉是幂等的,内容没变不动引用(见 sameFolderList)。
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshTree = useCallback(async (): Promise<void> => {
    const keys = [...registry.childrenByDir.keys()];
    await Promise.all(keys.map((k) => loadChildren(k)));
    // 孤儿键清理:某个目录被外部删掉 → 它不再出现在任何父目录的子项
    // 里 → 它的缓存键也不该留着(留着的话展开态残留,再次展开会
    // 拉回一棵幽灵子树)。可达性从根 '' 往下走一遍即可。
    const childrenOf = new Map<string, string[]>();
    for (const [k, list] of registry.childrenByDir) {
      childrenOf.set(k, list.map((n) => n.relPath));
    }
    const reachable = new Set<string>();
    const stack: string[] = [''];
    while (stack.length > 0) {
      const k = stack.pop()!;
      if (reachable.has(k)) continue;
      reachable.add(k);
      for (const c of childrenOf.get(k) ?? []) stack.push(c);
    }
    let pruned = false;
    const kept = new Map<string, readonly DiskFolderNode[]>();
    for (const [k, v] of registry.childrenByDir) {
      if (reachable.has(k)) kept.set(k, v);
      else pruned = true;
    }
    if (pruned) {
      registry.childrenByDir = kept;
    }
    // 展开态:已经不存在的目录不该留在 expanded 里(留着的话展开态与
    // 磁盘对不上,且再次展开会拉回一棵幽灵子树)。
    let expandedChanged = false;
    const expanded = new Set<string>();
    for (const p of registry.expanded) {
      if (reachable.has(p)) expanded.add(p);
      else expandedChanged = true;
    }
    if (expandedChanged) {
      registry.expanded = expanded;
    }
    // 落点:落点目录被外部删掉后,落点必须回根 —— 否则「新建 / 粘贴」
    //   会**默默把那个夹重新建出来**(moveFile 会 mkdir -p 父目录),
    //   用户刚删掉的夹又凭空回来了。
    //   前提:根的子项已加载过(否则 reachable 是空的,会误清)。
    let targetChanged = false;
    if (registry.childrenByDir.has('') && registry.targetRelPath !== null) {
      if (!reachable.has(registry.targetRelPath)) {
        registry.targetRelPath = null;
        targetChanged = true;
      }
    }
    if (pruned || expandedChanged || targetChanged) {
      forceUpdate();
    }
  }, [registry, loadChildren]);

  const scheduleRefresh = useCallback((): void => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    // 200ms 防抖:一次批量导入 / 外部同步会连着来好几个事件。
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null;
      void refreshTree();
    }, 200);
  }, [refreshTree]);

  // 订阅本域的 changed 推送 —— 外部(OS / 其它应用)改了磁盘目录结构
  // 后,树必须跟着变。
  useEffect(() => {
    const sub = kind === 'note' ? api.onNotesChanged : api.onLiteratureChanged;
    if (typeof sub !== 'function') return;
    const off = sub(() => {
      scheduleRefresh();
    });
    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      off();
    };
  }, [kind, api, scheduleRefresh]);

  // 挂载 / kind 变化时拉一次根目录的子项(顶层文件夹)。
  useEffect(() => {
    void loadChildren('');
  }, [loadChildren]);

  // === 展开 / 折叠 / 落点 ===
  const expandFolder = useCallback(
    (relPath: string) => {
      if (!registry.expanded.has(relPath)) {
        const next = new Set(registry.expanded);
        next.add(relPath);
        registry.expanded = next;
        forceUpdate();
      }
      if (!registry.childrenByDir.has(relPath)) void loadChildren(relPath);
    },
    [registry, loadChildren],
  );

  const collapseFolder = useCallback(
    (relPath: string) => {
      if (!registry.expanded.has(relPath)) return;
      const next = new Set(registry.expanded);
      next.delete(relPath);
      registry.expanded = next;
      forceUpdate();
    },
    [registry],
  );

  const toggleFolder = useCallback(
    (relPath: string) => {
      if (registry.expanded.has(relPath)) collapseFolder(relPath);
      else expandFolder(relPath);
    },
    [registry, expandFolder, collapseFolder],
  );

  /** 点文件夹行:设为落点 + 切换展开(一次手势两件事)。 */
  const activateFolder = useCallback(
    (relPath: string) => {
      registry.targetRelPath = relPath;
      const next = new Set(registry.expanded);
      if (next.has(relPath)) {
        next.delete(relPath);
      } else {
        next.add(relPath);
        if (!registry.childrenByDir.has(relPath)) void loadChildren(relPath);
      }
      registry.expanded = next;
      forceUpdate();
    },
    [registry, loadChildren],
  );

  /** 展开一路祖先(逐段),并把沿途目录都拉起来。 */
  const expandTo = useCallback(
    (relPath: string) => {
      const segs = relPath.split('/').filter((s) => s.length > 0);
      if (segs.length === 0) return;
      const paths: string[] = [];
      let acc = '';
      for (const s of segs) {
        acc = acc ? `${acc}/${s}` : s;
        paths.push(acc);
      }
      const next = new Set(registry.expanded);
      for (const p of paths) next.add(p);
      registry.expanded = next;
      forceUpdate();
      for (const p of paths) {
        if (!registry.childrenByDir.has(p)) void loadChildren(p);
      }
    },
    [registry, loadChildren],
  );

  /**
   * 结构变更(改名 / 删除 / 搬移)后同步树状态。
   *
   * - newPrefix === null → 整棵子树消失:展开态 / 缓存 / 落点里的相关项清掉
   * - 否则 → 前缀重映射(oldRelPath → newRelPath),缓存里的节点对象也跟着改
   *   (否则树上画的是旧路径)
   */
  const applyStructuralChange = useCallback(
    (oldPrefix: string, newPrefix: string | null) => {
      // 1) 展开态
      const expanded = new Set<string>();
      for (const p of registry.expanded) {
        if (!underPrefix(p, oldPrefix)) {
          expanded.add(p);
          continue;
        }
        if (newPrefix === null) continue; // 子树没了 → 展开态一并清
        expanded.add(remapPath(p, oldPrefix, newPrefix));
      }
      registry.expanded = expanded;

      // 2) 子目录缓存
      const children = new Map<string, readonly DiskFolderNode[]>();
      for (const [k, v] of registry.childrenByDir) {
        if (underPrefix(k, oldPrefix)) {
          if (newPrefix === null) continue; // 整棵子树没了
          // key 重映射 + 节点对象重映射
          children.set(
            remapDirKey(k, oldPrefix, newPrefix),
            v.map((n) => remapNode(n, oldPrefix, newPrefix)),
          );
          continue;
        }
        // 不在子树内的目录:其直接子节点里可能**就是**被改名的那个文件夹
        // → 节点本身要改 relPath / name;被删掉的子树 → 节点直接消失。
        children.set(
          k,
          v
            .filter((n) => newPrefix !== null || !underPrefix(n.relPath, oldPrefix))
            .map((n) => (newPrefix === null ? n : remapNode(n, oldPrefix, newPrefix))),
        );
      }
      registry.childrenByDir = children;

      // 3) 落点
      if (registry.targetRelPath !== null && underPrefix(registry.targetRelPath, oldPrefix)) {
        registry.targetRelPath = newPrefix === null ? null : remapPath(registry.targetRelPath, oldPrefix, newPrefix);
      }
      forceUpdate();
    },
    [registry],
  );

  // === IPC 写入类操作 ===
  const createFolder = useCallback(
    async (parentRelPath: string | null, newName: string) => {
      const trimmed = newName.trim();
      if (!trimmed) throw new Error('folder name empty');
      const targetRel = parentRelPath ? `${parentRelPath}/${trimmed}` : trimmed;
      const mkdir = kind === 'note' ? api.notesMkdir : api.litMkdir;
      const res = await mkdir(targetRel);
      if (!res.ok) throw new Error(res.message);
      // 父目录的子项变了 —— 重载父目录。
      const parentKey = parentRelPath ?? '';
      await loadChildren(parentKey);
      return { relPath: res.data.relPath };
    },
    [kind, api, loadChildren],
  );

  // r175:重命名文件夹 —— 主进程把「物理搬家 + 子树内每个资源 id 重算」
  //   一起做完并返回 idRemap。这里把 idRemap 交给 onItemsMoved → store 把
  //   selectedId / activeNoteFull 跟到新 id;否则选中态钉在死 id 上,后续
  //   任何操作(打开 / 保存 / 删除)都 NOT_FOUND。
  const renameFolder = useCallback(
    async (oldRelPath: string, newName: string) => {
      const trimmed = newName.trim();
      if (!trimmed) throw new Error('folder name empty');
      const renameDir = kind === 'note' ? api.notesRenameDir : api.litRenameDir;
      const res = await renameDir(oldRelPath, trimmed);
      if (!res.ok) throw new Error(res.message);
      const remap = new Map<string, { id: string; absPath?: string; relPath?: string }>();
      for (const item of res.data.idRemap) {
        remap.set(item.oldId, {
          id: item.newId,
          absPath: item.absPath,
          relPath: item.relPath,
        });
      }
      if (remap.size > 0 && onItemsMoved) {
        onItemsMoved(remap);
      }
      // 改名 ⇒ 整棵子树的 relPath 全变。展开态 / 子目录缓存 / 落点都要跟着改。
      const newRel = res.data.relPath;
      applyStructuralChange(oldRelPath, newRel);
      // 父目录的子项变了 —— 重载父目录(拿到权威数据)。
      const parentKey = oldRelPath.includes('/')
        ? oldRelPath.slice(0, oldRelPath.lastIndexOf('/'))
        : '';
      await loadChildren(parentKey);
      return { relPath: newRel };
    },
    [kind, api, applyStructuralChange, loadChildren, onItemsMoved],
  );

  const trashFolder = useCallback(
    async (relPath: string) => {
      const trash = kind === 'note' ? api.notesTrashDir : api.litTrashDir;
      const res = await trash(relPath);
      if (!res.ok) throw new Error(res.message);
      // 整棵子树消失 ⇒ 展开态 / 缓存 / 落点里的相关项全部清掉。
      applyStructuralChange(relPath, null);
      const parentKey = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
      await loadChildren(parentKey);
    },
    [kind, api, applyStructuralChange, loadChildren],
  );

  // r168:moveItems 收 idRemap 并返回 —— handleTargetDrop 拿到返回后顺手
  //   调 onItemsMoved(idRemap),把 store 侧 selectedId / activeNoteFull
  //   跳到新 id(同 paste(cut)/moveToFolder 路径的隐式重映射)。部分失败
  //   仍 throw,语义与 r167 兼容 —— 全成功才 fire callback。
  const moveItems = useCallback(
    async (
      targetRelPath: string | null,
      ids: string[],
    ): Promise<Map<string, { id: string; absPath?: string; relPath?: string }>> => {
      if (ids.length === 0) return new Map();
      const move = kind === 'note' ? api.notesMove : api.litMove;
      const target = targetRelPath ?? '';
      const errors: Array<{ id: string; code: string; message: string }> = [];
      const idRemap = new Map<string, { id: string; absPath?: string; relPath?: string }>();
      for (const id of ids) {
        const res = await move(id, target);
        if (!res.ok) {
          errors.push({ id, code: res.code, message: res.message });
        } else {
          // notesMove.data = { id, relPath } ;litMove.data = { id, absPath }。
          // 两者 schema 不同但只有对应 kind 走到对应 IPC,不会互串。
          idRemap.set(id, res.data);
        }
      }
      if (errors.length > 0) {
        const first = errors[0]!;
        const wrapped = new Error(
          `moveItems failed ${errors.length}/${ids.length}: ${first.message}`,
        ) as Error & { code?: string; errors?: typeof errors };
        wrapped.code = first.code;
        wrapped.errors = errors;
        throw wrapped;
      }
      return idRemap;
    },
    [kind, api],
  );

  // === r166:inline 编辑(create / rename)===
  // r175:搜索态下 startCreate / startCreateSubfolder **直接 no-op**。
  //   搜索态的 inline input 行被 rows 组装侧 gate 掉(`!searchActive` 才
  //   push input 行)—— 于是旧实现「进搜索态点 ✚ 按钮」会:setEditing
  //   置成 create,但没有 input 行渲染,用户看到**什么都不发生**,而且
  //   editing 状态卡在 create,清空搜索后 input 行会突然冒出来。
  //   键盘入口(mod+Shift+N)早已 gate 在 !searchActive,这里把守卫收到
  //   hook 内部 → 工具栏按钮 / 右键菜单 / 快捷键三条入口行为统一。
  //
  // r176:父目录 = **当前落点**(不再是「钻入到的目录」)。落点若处于折叠态,
  //   input 行会落在看不见的地方 ⇒ 顺带把落点展开(及祖先)。
  const startCreate = useCallback(() => {
    if (searchActive) return;
    const parent = registry.targetRelPath;
    if (parent !== null) expandTo(parent);
    setEditing({ mode: 'create', parentRelPath: parent, name: '' });
  }, [searchActive, registry, expandTo]);

  const startCreateSubfolder = useCallback(
    (parent: DiskFolderNode) => {
      if (searchActive) return;
      expandTo(parent.relPath);
      setEditing({ mode: 'create', parentRelPath: parent.relPath, name: '' });
    },
    [searchActive, expandTo],
  );

  const startRename = useCallback((folder: DiskFolderNode) => {
    setEditing({ mode: 'rename', folder, name: folder.name });
  }, []);
  const cancelEdit = useCallback(() => {
    setEditing(null);
  }, []);
  const commitEdit = useCallback(
    async (name: string): Promise<boolean> => {
      if (!editing) return false;
      const trimmed = name.trim();
      if (!trimmed) {
        // 空名 = 取消 —— 行会消失,视作「已处理」。
        cancelEdit();
        return true;
      }
      if (editing.mode === 'create') {
        await createFolder(editing.parentRelPath, trimmed);
      } else {
        await renameFolder(editing.folder.relPath, trimmed);
      }
      setEditing(null);
      return true;
    },
    [editing, createFolder, renameFolder, cancelEdit],
  );

  // === r166:删除文件夹(confirm + trashFolder)===
  //
  // audit-r206 (2026-10-20):确认框从 **原生 window.confirm** 换成应用内
  //   ConfirmDialog(lib/confirm),两个理由:
  //   ① **文案硬编码英文** —— 旧实现直接写死
  //      `Delete folder "X" and all its contents?`,中文用户在 zh-CN 界面
  //      点「删除文件夹」弹出的是英文原生对话框(全仓最后一个 window.confirm)。
  //   ② **原生 confirm 阻塞渲染进程**,且完全脱离应用主题 —— 项目自己在
  //      SettingsPage 里写过这条结论(「用应用内 ConfirmDialog 而不是
  //      window.confirm —— 后者会阻塞渲染进程,且完全脱离应用主题」),
  //      此处只是漏改。
  //   语义变化:原生 confirm 同步返回;应用内 confirm 是 Promise(且带队列,
  //   同一时刻已有弹窗时排队)。调用方本来就 `void folders.requestDelete(...)`
  //   (fire-and-forget),异步化不影响调用点。
  const requestDelete = useCallback(
    async (folder: DiskFolderNode) => {
      const confirmed = await confirm({
        title: t('folders.deleteConfirmTitle'),
        description: t('folders.deleteConfirmBody', { name: folder.name }),
        confirmLabel: t('folders.deleteConfirmLabel'),
        danger: true,
      });
      if (!confirmed) return;
      await trashFolder(folder.relPath);
    },
    [trashFolder, t],
  );

  // === r166:剪贴板(cut + paste)===
  const cutFolder = useCallback((folderRelPath: string) => {
    setFolderClipboard((cur) => (cur === folderRelPath ? null : folderRelPath));
  }, []);

  // r173:目录(子树)跨父目录搬移 —— 走新 IPC(notes:folders-move-dir /
  //   literature:folders-move-dir)。
  //
  // 搬完把 idRemap 交给 onItemsMoved —— store 用它把 selectedId /
  //   activeNoteFull 跟到新 id(否则选中态指向已不存在的 id)。
  const moveFolderNow = useCallback(
    async (folderRelPath: string, targetParentRelPath: string | null) => {
      const moveDir = kind === 'note' ? api.notesMoveDir : api.litMoveDir;
      const res = await moveDir(folderRelPath, targetParentRelPath);
      if (!res.ok) throw new Error(res.message);
      const remap = new Map<string, { id: string; absPath?: string; relPath?: string }>();
      for (const item of res.data.idRemap) {
        remap.set(item.oldId, {
          id: item.newId,
          absPath: item.absPath,
          relPath: item.relPath,
        });
      }
      if (remap.size > 0 && onItemsMoved) {
        onItemsMoved(remap);
      }
      // 整棵子树的 relPath 变了 —— 展开态 / 缓存 / 落点跟着改。
      const newRelPath = res.data.relPath;
      if (newRelPath !== folderRelPath) {
        applyStructuralChange(folderRelPath, newRelPath);
      }
      // 旧父目录 + 新父目录的子项都变了 —— 两边都重载。
      const oldParentKey = folderRelPath.includes('/')
        ? folderRelPath.slice(0, folderRelPath.lastIndexOf('/'))
        : '';
      const newParentKey = targetParentRelPath ?? '';
      await loadChildren(oldParentKey);
      if (newParentKey !== oldParentKey) await loadChildren(newParentKey);
      return newRelPath;
    },
    [kind, api, applyStructuralChange, loadChildren, onItemsMoved],
  );

  const pasteFolderInto = useCallback(
    async (targetParentRelPath: string | null) => {
      if (!folderClipboard) return;
      // 失败时 moveFolderNow throw —— 剪贴板保留,用户可重试
      await moveFolderNow(folderClipboard, targetParentRelPath);
      setFolderClipboard(null);
    },
    [folderClipboard, moveFolderNow],
  );

  // === r166:右键菜单开/关===
  const openFolderContextMenu = useCallback(
    (folder: DiskFolderNode, x: number, y: number) => {
      setFolderMenu({ folder, x, y });
    },
    [],
  );

  // === r166:dragstart(走 folder-dnd 的 MIME)===
  // audit-r144:一次 setData 两个 MIME —— MOVE 表「移到文件夹 / 当前目录
  //   落点」语义(读 readMovePayload),REORDER 表「同列内重排」语义
  //   (读 readReorderPayload,targetId 占位 = id 即被拖项,落点由
  //   row-level handler 再算 before/after)。drop 端按 hasMove / hasReorder
  //   自然判定两条 pipeline 不互串。effectAllowed = 'move' 在
  //   writeReorderPayload / writeMovePayload 内已设。
  const startItemsDrag = useCallback(
    (ids: string[], e: ReactDragEvent) => {
      const head = ids[0] ?? '';
      writeMovePayload(e.dataTransfer, { type: 'items', kind, ids, relPaths: [] });
      writeReorderPayload(e.dataTransfer, { id: head, targetId: head, before: true, kind });
    },
    [kind],
  );
  const startFolderDrag = useCallback(
    (folder: DiskFolderNode, e: ReactDragEvent) => {
      // r173:ids 必须是 [relPath] 占位 —— readMovePayload 拒收空 ids 数组
      //   (旧写法 ids: [] 让文件夹拖拽载荷在读端被整条丢掉,drop 端永远
      //   收不到,拖文件夹一直是死的)。占位值 = 被搬目录的 relPath。
      writeMovePayload(e.dataTransfer, {
        type: 'folder',
        kind,
        ids: [folder.relPath],
        relPaths: [folder.relPath],
      });
    },
    [kind],
  );

  // === r166:drop target(dragover/drop/drop leave + drop hot state)===
  const isInternalDrag = useCallback((e: ReactDragEvent) => {
    return hasMovePayload(e.dataTransfer);
  }, []);
  const handleTargetDragOver = useCallback(
    (e: ReactDragEvent, targetKey: string) => {
      if (!isInternalDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      setDropHot(targetKey);
    },
    [isInternalDrag],
  );
  const handleTargetDragLeave = useCallback(
    (e: ReactDragEvent, targetKey: string) => {
      if (!isInternalDrag(e)) return;
      const related = e.relatedTarget as Node | null;
      if (related && (e.currentTarget as Node).contains(related)) return;
      setDropHot((cur) => (cur === targetKey ? null : cur));
    },
    [isInternalDrag],
  );
  const handleTargetDrop = useCallback(
    async (e: ReactDragEvent, targetKey: string) => {
      const payload = readMovePayload(e.dataTransfer);
      setDropHot(null);
      if (!payload) return;
      if (payload.kind !== kind) return;
      e.preventDefault();
      e.stopPropagation();
      if (payload.type === 'folder') {
        // r173:文件夹拖到另一个目录 —— 走 moveDir IPC(整棵子树搬移)。
        //   targetKey = 目标目录 relPath(文件夹行落点),根 = ROOT_DROP_ID。
        const folderRelPath = payload.relPaths[0];
        if (!folderRelPath) return;
        const folderTarget = targetKey === ROOT_DROP_ID ? null : targetKey;
        // r174:拖回自己身上 = no-op(此前会一路走到 service 的
        //   「cannot move a folder into its own subtree」→ 弹一个错误
        //   toast,用户却什么都没拖成,像出了故障)。自己 = 静默返回。
        if (folderTarget === folderRelPath) return;
        await moveFolderNow(folderRelPath, folderTarget);
        return;
      }
      // items 走跨目录 moveItems + r168:拿到 idRemap 后回调 store 刷
      //   selectedId / activeNoteFull,统一 drag / cut-paste 两条 pipeline。
      const target = targetKey === ROOT_DROP_ID ? null : targetKey;
      const idRemap = await moveItems(target, payload.ids);
      if (idRemap.size > 0 && onItemsMoved) {
        onItemsMoved(idRemap);
      }
    },
    [kind, moveItems, moveFolderNow, onItemsMoved],
  );

  const { targetRelPath, expanded, childrenByDir } = registry;

  return useMemo(
    () => ({
      targetRelPath,
      expanded,
      childrenByDir,
      activateFolder,
      toggleFolder,
      expandFolder,
      collapseFolder,
      expandTo,
      createFolder,
      renameFolder,
      trashFolder,
      moveItems,
      editing,
      folderMenu,
      folderClipboard,
      dropHot,
      startCreate,
      startCreateSubfolder,
      startRename,
      commitEdit,
      cancelEdit,
      requestDelete,
      cutFolder,
      pasteFolderInto,
      moveFolderNow,
      openFolderContextMenu,
      setFolderMenu,
      startItemsDrag,
      startFolderDrag,
      handleTargetDragOver,
      handleTargetDragLeave,
      handleTargetDrop,
      isInternalDrag,
    }),
    [
      targetRelPath,
      expanded,
      childrenByDir,
      activateFolder,
      toggleFolder,
      expandFolder,
      collapseFolder,
      expandTo,
      createFolder,
      renameFolder,
      trashFolder,
      moveItems,
      editing,
      folderMenu,
      folderClipboard,
      dropHot,
      startCreate,
      startCreateSubfolder,
      startRename,
      commitEdit,
      cancelEdit,
      requestDelete,
      cutFolder,
      pasteFolderInto,
      moveFolderNow,
      openFolderContextMenu,
      setFolderMenu,
      startItemsDrag,
      startFolderDrag,
      handleTargetDragOver,
      handleTargetDragLeave,
      handleTargetDrop,
      isInternalDrag,
    ],
  );
}
