// src/renderer/src/components/common/FolderChrome.tsx
//
// r161+ disk-folder:FolderNode 整体下线,改为 DiskFolderNode(relPath 树)。
//   「id」语义改为 relPath 字符串(无独立 folder_id);`name` / `parentRelPath`
//   与原 FolderNode 对应。
//
// r176:左侧栏改**树状** —— 本文件随之改造:
//   - **删** FolderBreadcrumb(面包屑下线 —— 树里目录层级直接摊开,不再
//     需要「面包屑 + 单层列表」这套钻入式导航)。
//   - FolderRowOption 升格成 **treeitem**:加 chevron(展开/折叠)、
//     depth 缩进、aria-level / aria-expanded;`onOpen` 改名 `onActivate`
//     (语义从「钻入」变成「设为落点 + 切换展开」)。
//   - FolderCreateRow(新建文件夹 inline input)同款加 depth 缩进。
import { memo, useCallback, useMemo, useState } from 'react';
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Folder, FolderPlus } from 'lucide-react';
import type { DiskFolderNode } from '@shared/types';
import { clsx } from '../../lib/clsx';
import { createLogger } from '../../lib/logger-client';
import { Input } from '../ui/Input';

const log = createLogger('FolderChrome');

// === inline 命名输入(Phase 1 简化版:无 IPC 落盘,只 hold 住 value)===
function FolderNameInput({
  initial,
  ariaLabel,
  onCommit,
  onCancel,
}: {
  initial: string;
  ariaLabel: string;
  onCommit: (name: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const commit = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const ok = await onCommit(value);
      // ok=false = 没提交成(行还在)⇒ 解除 busy 让用户能改名字重试。
      if (!ok) setBusy(false);
    } catch (err: unknown) {
      // r176:onCommit 失败(rejected)时不能把 busy 永久钉死 —— 输入框
      //   会卡在 disabled 状态,用户看着像「改名没反应」。解开 busy 并
      //   记日志(错误 toast 由调用方抛 toast,这里只保底不崩)。
      setBusy(false);
      log.error('FolderNameInput commit failed', err);
    }
  }, [busy, onCommit, value]);
  return (
    <Input
      value={value}
      onChange={setValue}
      placeholder={t('folders.namePlaceholder')}
      aria-label={ariaLabel}
      inputClassName="h-6 text-2xs"
      disabled={busy}
      onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          void commit();
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          if (!busy) onCancel();
        }
      }}
      onBlur={() => {
        if (busy) return;
        // audit-r155(r166):blur = commit if dirty, cancel if clean。
        //   VS Code / Finder 通用语义:用户敲完字走神,blur 应保留输入而非吞;
        //   没动笔的 blur 才走 cancel(避免 onCancel 副作用如 creating flag
        //   reset 被空改触发)。同 FolderNameInput onBlur commit-on-dirty 7 例
        //   行为级契约(见 folder-name-input-blur-commit.test.tsx)。
        if (value.trim() !== initial.trim()) void commit();
        else onCancel();
      }}
    />
  );
}

// === 文件夹行 ===
// r174:本组件此前是 Phase 1 stub —— 声明了 onContextMenu / onContextMenuAt /
//   onHover 三个 prop 却**一个都没用**,并且 draggable={false} 让浏览器根本
//   不发起原生 drag。后果(全部是「文件夹功能是死的」):
//   - 右键文件夹 → 菜单永远不弹(NotesList / LiteratureList 里那套
//     folderMenuItems:剪切 / 粘贴 / 移到根目录 / 删除 全都够不着);
//   - 文件夹行 hover → activeId 不跟手(键盘 roving 与 SR 的
//     aria-activedescendant 落在别的行上);
//   - 文件夹拖拽 → r173 接好的 folders-move-dir 链路永远收不到载荷。
//   本轮把三个 prop 真正接上,draggable 打开(renaming 态关掉,免得拖 input)。
//
// r176:升格为 **treeitem** —— 加 chevron / depth 缩进 / aria-level /
//   aria-expanded;`onOpen` → `onActivate`(语义:设为落点 + 切换展开)。
export const FolderRowOption = memo(function FolderRowOption({
  folder,
  domId,
  isActive,
  isCut,
  isDropHot,
  isRenaming,
  depth,
  expanded,
  hasChildren,
  isTarget,
  posInSet,
  setSize,
  onActivate,
  onContextMenu,
  onContextMenuAt,
  onHover,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onCommitRename,
  onCancelRename,
}: {
  folder: DiskFolderNode;
  domId: string;
  isActive: boolean;
  isCut: boolean;
  isDropHot: boolean;
  isRenaming: boolean;
  /** 缩进层级(根的直接子级 = 0)。 */
  depth: number;
  /** 是否处于展开态。 */
  expanded: boolean;
  /** 是否有子节点(决定画不画 chevron)。 */
  hasChildren: boolean;
  /** 是否是当前落点文件夹(新建 / 粘贴的目标)。 */
  isTarget: boolean;
  posInSet: number;
  setSize: number;
  onActivate: (folder: DiskFolderNode) => void;
  onContextMenu: (folder: DiskFolderNode, e: ReactMouseEvent) => void;
  onContextMenuAt: (folder: DiskFolderNode, x: number, y: number) => void;
  onHover: (folder: DiskFolderNode) => void;
  onDragStart: (folder: DiskFolderNode, e: ReactDragEvent) => void;
  onDragOver: (id: string, e: ReactDragEvent) => void;
  onDragLeave: (id: string, e: ReactDragEvent) => void;
  onDrop: (id: string, e: ReactDragEvent) => void;
  onCommitRename: (name: string) => Promise<boolean>;
  onCancelRename: () => void;
}) {
  const { t } = useTranslation();
  const handleClick = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      if (!isRenaming) onActivate(folder);
    },
    [onActivate, folder, isRenaming],
  );
  const handleContextMenu = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      onContextMenu(folder, e);
    },
    [onContextMenu, folder],
  );
  const handleMouseEnter = useCallback(() => {
    onHover(folder);
  }, [onHover, folder]);
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isRenaming) return;
      if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
        e.preventDefault();
        onActivate(folder);
        return;
      }
      // a11y H6 同款(NoteRow / LiteratureRow 同款契约):Shift+F10 /
      //   ContextMenu 键打开右键菜单。走坐标路径 onContextMenuAt ——
      //   合成 MouseEvent 会丢掉 preventDefault 等原生字段,坐标路径
      //   不造那类谎言。
      if (e.shiftKey && e.key === 'F10') {
        e.preventDefault();
        const target = e.currentTarget as HTMLElement;
        const rect = target.getBoundingClientRect();
        onContextMenuAt(folder, rect.left + rect.width / 2, rect.top + rect.height / 2);
      }
    },
    [onActivate, folder, isRenaming, onContextMenuAt],
  );
  // audit-r136:r166 真正接 drag 4 件 —— 每行 useMemo 包一层把 folder / prop
  //   闭包进 handler,让 row 渲染稳定(callback identity 不变 → row memo
  //   不破)。folder.relPath 作 id 传 prop(DiskFolderNode 字段名)。
  //   锁的契约:tests/unit/renderer/layout/folder-row-callback-stability.test.tsx
  //   (audit-r229 补齐 8 例:回调载荷 = 当前 folder / 当前 relPath、不许 stale
  //   closure、行重渲稳定性)——
  //   期望 useMemo 形态 + folder.id 形参 —— folder.id 实际是 folder.relPath
  //   的语义别名(r161 disk-folder 后 DiskFolderNode 无独立 id 字段),本
  //   测试在 r166 同步把 .id 翻成 .relPath。
  const handleDragStart = useMemo(
    () => (e: ReactDragEvent) => onDragStart(folder, e),
    [onDragStart, folder],
  );
  const handleDragOver = useMemo(
    () => (e: ReactDragEvent) => onDragOver(folder.relPath, e),
    [onDragOver, folder.relPath],
  );
  const handleDragLeave = useMemo(
    () => (e: ReactDragEvent) => onDragLeave(folder.relPath, e),
    [onDragLeave, folder.relPath],
  );
  const handleDrop = useMemo(
    () => (e: ReactDragEvent) => onDrop(folder.relPath, e),
    [onDrop, folder.relPath],
  );
  return (
    <div
      role="treeitem"
      aria-selected={isActive}
      aria-posinset={posInSet}
      aria-setsize={setSize}
      aria-level={depth + 1}
      aria-expanded={hasChildren ? expanded : undefined}
      tabIndex={-1}
      aria-haspopup="menu"
      id={domId}
      data-folder-relpath={folder.relPath}
      // r174:draggable 打开 —— 此前写死 false,浏览器压根不发起原生 drag,
      //   r173 接好的文件夹拖拽搬移链路永远收不到载荷。renaming 态关掉
      //   (行内有 input,拖 input 会误触)。
      draggable={!isRenaming}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onContextMenu={handleContextMenu}
      onMouseEnter={handleMouseEnter}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={clsx(
        'list-row group',
        isActive && !isRenaming && 'list-row-selected',
        isCut && 'opacity-50',
        isTarget && !isActive && 'list-row-tree-target',
        isDropHot && 'ring-1 ring-accent bg-accent/10',
      )}
      // r176:缩进 = 层级 × 12px。走内联 style 覆盖 .list-row 的 px-3
      //   (utilities 层优先级高于 components 层,不能靠 class 改 padding)。
      style={{ paddingLeft: 12 + depth * 12 }}
    >
      {/* chevron —— 纯装饰(aria-hidden),展开态由 aria-expanded 传达。 */}
      {hasChildren ? (
        <ChevronRight
          size={12}
          aria-hidden="true"
          className={clsx(
            'text-fg-tertiary flex-shrink-0 transition-transform',
            expanded && 'rotate-90',
          )}
        />
      ) : (
        <span className="w-3 flex-shrink-0" aria-hidden="true" />
      )}
      <Folder size={12} className="text-accent flex-shrink-0" aria-hidden="true" />
      <div className="flex-1 min-w-0">
        {isRenaming ? (
          <FolderNameInput
            initial={folder.name}
            ariaLabel={t('folders.renameAria')}
            onCommit={onCommitRename}
            onCancel={onCancelRename}
          />
        ) : (
          <div className="list-row-title">{folder.name}</div>
        )}
      </div>
    </div>
  );
});

// === 新建文件夹 inline 行(Phase 1 简化)===
export const FolderCreateRow = memo(function FolderCreateRow({
  domId,
  depth,
  posInSet,
  setSize,
  onCommit,
  onCancel,
}: {
  domId: string;
  /** 缩进层级(根的直接子级 = 0)。r176:input 行挂在目标文件夹**下面**。 */
  depth: number;
  posInSet: number;
  setSize: number;
  onCommit: (name: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="treeitem"
      aria-selected={false}
      aria-posinset={posInSet}
      aria-setsize={setSize}
      aria-level={depth + 1}
      tabIndex={-1}
      id={domId}
      data-testid="folder-create-row"
      className="list-row"
      style={{ paddingLeft: 12 + depth * 12 }}
      onClick={(e) => e.preventDefault()}
    >
      <span className="w-3 flex-shrink-0" aria-hidden="true" />
      <FolderPlus size={12} className="text-accent flex-shrink-0" aria-hidden="true" />
      <div className="flex-1 min-w-0">
        <FolderNameInput
          initial=""
          ariaLabel={t('folders.newFolderAria')}
          onCommit={onCommit}
          onCancel={onCancel}
        />
      </div>
    </div>
  );
});
