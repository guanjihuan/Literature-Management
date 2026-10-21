// src/renderer/src/lib/folder-view.ts
//
// r161+ disk-folder:侧栏**行 id / 分组判据**的低层工具。
//
// r176 改造:本文件原先还兼管「钻入式行合成」(visibleItemRows /
//   visibleFolderRows / FolderListRow / ItemListRow / NewFolderListRow /
//   SidebarRow / makeItemRow / makeFolderRow / NEW_FOLDER_ROW_ID)——
//   那些是「只显示当前目录一层」的产物,树状改造后**全部下线**,行合成
//   搬到 lib/folder-tree.ts(纯函数 + 树的行类型)。
//
// 本文件现在只留三样底层契约:
//   - dirnameOfRelPath —— 资源归属判据(也与 store/notes.ts 和
//     shared/path-utils.ts 共享,跨层同款)
//   - folderRowId —— 文件夹行 id('folder:<relPath>')
//   - sidebarRowDomId —— rove / aria-activedescendant 的 DOM id 合成

/** 文件夹行 id —— 'folder:' 前缀避免与资源 id 空间碰撞。 */
export const folderRowId = (relPath: string): string => `folder:${relPath}`;

/** 资源行归一读取:dirname(relPath) 即归属(根 = '')。undefined relPath 当根兜底。 */
export function dirnameOfRelPath(item: { relPath?: string | null }): string {
  if (!item.relPath) return '';
  const idx = item.relPath.lastIndexOf('/');
  return idx < 0 ? '' : item.relPath.slice(0, idx);
}

/**
 * rove / aria-activedescendant 的 DOM id 合成(列表前缀 'lit-row' / 'note-row'):
 *   item   → `${prefix}-${id}`            (与改造前逐字节一致,tests 锁的
 *             `note-row-<id>` 选择器不受影响)
 *   folder → `${prefix}-folder-${relPath}`(folderRowId 去掉 'folder:' 前缀)
 *   input  → `${prefix}-folder-new`       (新建文件夹 inline input 行;
 *             旧实现靠 NEW_FOLDER_ROW_ID='folder:new' 的 slice 自然命中,
 *             r176 该常量改成 'input:new-folder' 避开与真名为 "new" 的
 *             文件夹撞 id —— 这里显式映射,DOM id 保持不变)
 * id 里允许冒号(getElementById 不是 CSS 选择器,无需 escape)。
 */
export function sidebarRowDomId(prefix: string, rowId: string): string {
  if (rowId.startsWith('folder:')) return `${prefix}-folder-${rowId.slice('folder:'.length)}`;
  if (rowId.startsWith('input:')) return `${prefix}-folder-new`;
  return `${prefix}-${rowId}`;
}
