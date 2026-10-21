// use-folder-ops:侧栏「文件夹操作 + 剪贴板粘贴」的失败反馈包装 ——
//   ① runFolderOp(r173):文件夹搬移类 op(粘贴文件夹 / 移到根目录 / 拖到
//      别的目录)的失败反馈 —— hook 侧抛错,调用点是 `void fn()` 的话会
//      变成 unhandled rejection(用户看不到任何提示,只当按钮没生效),
//      这里统一 catch ⇒ log + toast;
//   ② commitFolderEdit(r176):FolderChrome 的 onCommit 契约 =
//      Promise<boolean>(true = 行将被撤掉,input 保持 busy;false = 留在
//      原地可重试)—— folders.commitEdit 失败会 throw(IPC 报错),这里
//      包一层:弹 toast + 返回 false,输入框回到可编辑态(不卡 busy);
//   ③ pasteTo(0007):粘贴(mod+V / 右键)目标 = 落点文件夹(null = 根);
//      剪切 = 改归属,复制 = 复制后放进目标夹。失败 toast,clipboard 保留
//      可重试(store 契约)。r176:目标从「钻入到的目录」改成「当前落点
//      文件夹」。
//   附:pasteToTarget = pasteTo(folders.targetRelPath) 的便捷封装 ——
//      收编前 notes 叫 handlePaste、lit 在调用点内联,同义。
//
// audit-r227 (2026-10-20):NotesList / LiteratureList 同构块收编 ④。
//   三段两版逐字相同,仅两个注入点:
//   - logTag('NotesList' / 'LiteratureList'):log.error 消息前缀;
//   - pasteFailedKey('toast.pasteNoteFailed' / 'literature.pasteFailedToast')
//     :pasteTo 失败 toast 的 i18n key(两域 locale 树不同);
//   folderMoveFailed 的 key 两域相同('toast.folderMoveFailed'),无需注入。
//
// 与 r224-r226 同一模式:useLatestValue(opts) ⇒ 所有 handler 身份恒定。
//   (收编前 commitFolderEdit 靠 eslint-disable + 窄化 deps 到
//   folders.commitEdit 保身份 —— folders 基对象随 dropHot/expanded/editing
//   变化,挂上它等于每次拖拽热区移动都重建回调、行 memo 全废(audit-r136);
//   latest 模式从结构上消掉这个问题,disable 注释随之退役。)

import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../lib/toast';
import { errMsg } from '../lib/error';
import { createLogger } from '../lib/logger-client';
import type { DiskFolderSidebar } from './useDiskFolderSidebar';
import { useLatestValue } from './useLatestValue';

const log = createLogger('useFolderOps');

export interface UseFolderOpsOptions {
  /** log.error 消息前缀(收编前 = 组件名)。 */
  logTag: string;
  /** pasteTo 失败 toast 的 i18n key(两域 locale 树不同)。 */
  pasteFailedKey: string;
  folders: DiskFolderSidebar;
  /** store 的 paste(targetFolderId):失败会 throw,clipboard 保留。 */
  pasteClipboard: (targetFolderId: string | null) => Promise<unknown>;
}

export function useFolderOps(opts: UseFolderOpsOptions): {
  runFolderOp: (op: () => Promise<unknown>) => void;
  commitFolderEdit: (name: string) => Promise<boolean>;
  pasteTo: (targetFolderId: string | null) => Promise<void>;
  pasteToTarget: () => void;
} {
  const { t } = useTranslation();
  const toast = useToast((s) => s.show);
  const latest = useLatestValue(opts);

  const runFolderOp = useCallback(
    (op: () => Promise<unknown>) => {
      void op().catch((err: unknown) => {
        log.error(`${latest.current.logTag} folder op failed`, err);
        toast({ type: 'error', message: t('toast.folderMoveFailed', { msg: errMsg(err) }) });
      });
    },
    [latest, toast, t],
  );

  const commitFolderEdit = useCallback(
    async (name: string): Promise<boolean> => {
      try {
        await latest.current.folders.commitEdit(name);
        return true;
      } catch (err: unknown) {
        log.error(`${latest.current.logTag} folder edit failed`, err);
        toast({ type: 'error', message: t('toast.folderMoveFailed', { msg: errMsg(err) }) });
        return false;
      }
    },
    [latest, toast, t],
  );

  const pasteTo = useCallback(
    async (targetFolderId: string | null) => {
      try {
        await latest.current.pasteClipboard(targetFolderId);
      } catch (err: unknown) {
        log.error(`${latest.current.logTag} paste failed`, err);
        toast({ type: 'error', message: t(latest.current.pasteFailedKey, { msg: errMsg(err) }) });
      }
    },
    [latest, toast, t],
  );

  const pasteToTarget = useCallback(() => {
    void pasteTo(latest.current.folders.targetRelPath);
  }, [latest, pasteTo]);

  return { runFolderOp, commitFolderEdit, pasteTo, pasteToTarget };
}
