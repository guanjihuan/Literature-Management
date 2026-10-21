// Notes IPC handlers:NotesService 在 start() 已 chokidar 监听 + 内存索引,
// IPC 只做参数校验 + DB FTS 同步;per-file notes 已退役,source 桥接层与
// NOTES_*_FOR_SOURCE 通道全部删除。
import { IPC } from '../../shared/types';
// audit-r73:handleZod / getSettings / ZodNotesResyncProgress* import 随
//   NOTES_RESCYNC_PROGRESS(_GET_STATE)死对下线移除(本文件此前唯一 handleZod
//   使用点就是那条 GET_STATE handler)。
import { handle, requireString } from './wrap';
import { getRootPath } from '../utils/safe-write';
import { assertFileExists } from '../utils/file-check';
// DB 同步走 ResourcesRepo;notes 表退役,deleteNote / renameNoteInDB / NoteRow 删除
import { deleteResource } from '../db/resources-repo';
import { noteResourceId } from '@shared/resource-id';
import { LibraryError, ValidationError, errMsg } from '../utils/error';
import { tr } from '../i18n';
import type { NotesService } from '../notes/service';
import { toNotePath } from '../notes/path-mapping';
import { createLogger } from '../utils/logger';
import {
  MAX_IPC_PATH_CHARS,
  MAX_NOTE_BODY_BYTES,
  MAX_NOTE_FIELD_CHARS,
  MAX_NOTE_TITLE_BYTES,
  MAX_NOTE_TITLE_CHARS,
  requireAbsolutePath,
} from './path-limits';
import { revealInOSFileManagerSafe } from '../utils/reveal';
import type { NotesImportResult } from '@shared/api-types';
import { remapFavoriteIds, removeFavoriteIds } from '../workspace/favorites';

// resources_fts 无触发器,全部写路径由 ResourcesRepo 单事务「FTS DELETE →
// 主表 upsert → FTS INSERT」承担。NOTES_WRITE / NOTES_CREATE 的 DB 上行在
// NotesService.write/create 内(修 r45 缺口:删 syncNoteToDB 后这两条不再写主表)。

const log = createLogger('ipc-notes');

/**
 * r182:笔记 id 变更(改名 / 跨文件夹搬移)后,把收藏条目的 fileId 跟着改 ——
 *   否则用户的 ★ 在操作成功的瞬间静默消失(favorites.md 里留着旧 id,
 *   UI 按 id 过滤,旧 id 再也不会命中任何一行)。
 *
 * best-effort:收藏改写失败**不能**让已经成功的文件操作变成失败。
 */
async function remapFavoritesForNote(item: {
  oldId: string;
  newId: string;
  path?: string;
}): Promise<void> {
  try {
    const n = await remapFavoriteIds([item]);
    if (n > 0) log.info('favorites remapped after note change', { count: n });
  } catch (err: unknown) {
    log.warn('favorites remap failed after note change', { err: errMsg(err) });
  }
}

/**
 * r198:笔记被移入回收站后,清掉它的收藏条目 —— 否则 favorites.md 里留着
 *   一条永远命中不了的孤儿(★ 状态错位 + 死条目堆积)。
 *   best-effort:收藏清理失败**不能**让已经成功的删除变成失败。
 */
async function removeFavoritesForNote(id: string): Promise<void> {
  try {
    const n = await removeFavoriteIds([id]);
    if (n > 0) log.info('favorites removed after note trash', { count: n });
  } catch (err: unknown) {
    log.warn('favorites cleanup failed after note trash', { err: errMsg(err) });
  }
}

// parseNoteSource 已下线 —— library-file 上下文不存在后,3 个 ForSource handler
// 全部删除,parseNoteSource 失去 caller,一并清理。

export function registerNotesIPC(svc: NotesService): void {
  // NOTES_LIST 走 listSummaries(不返 body),需要时按 id 走 NOTES_READ 拉单条。
  // r161 disk-folder:summary 自身含 relPath,物理目录即组织层;
  //   renderer 端按 dirname(relPath) === currentRelPath 过滤即可,
  //   DB 合并层删除(folders 表已下线,folderId 概念不再存在)
  handle(IPC.NOTES_LIST, async () => {
    return svc.listSummaries();
  });

  handle(IPC.NOTES_READ, async (_e, id: string) => {
    const idStr = requireString(IPC.NOTES_READ, id, 'id', { maxLen: MAX_NOTE_FIELD_CHARS });
    const n = svc.findById(idStr);
    if (!n) {
      // NOT_FOUND 而非静默 null(NOTES_CHANGED + listener 已覆盖 rename race,
      // 不需 null 兜底)
      throw new LibraryError('NOT_FOUND', tr('notes.notFound', { id: idStr }));
    }
    return n;
  });

  handle(
    IPC.NOTES_WRITE,
    async (
      _e,
      id: string,
      body: string,
      title?: string,
      // expectedMtime 透传:renderer loadFullNote 时记下 activeNoteFull.mtime,
      // save 时回传,主进程比对磁盘 mtime 与期望值,不一致抛 CONFLICT(防 OneDrive /
      // Vim 等外部修改被静默覆盖)。number 而非 string —— 走 Number.isFinite 校验。
      // 无 expectedMtime 时保持 last-writer-wins(向后兼容老 caller)。
      expectedMtime?: number,
    ) => {
      const idStr = requireString(IPC.NOTES_WRITE, id, 'id', { maxLen: MAX_NOTE_FIELD_CHARS });
      const bodyStr = requireString(IPC.NOTES_WRITE, body, 'body', {
        maxBytes: MAX_NOTE_BODY_BYTES,
      });
      let titleStr: string | undefined;
      if (title !== undefined) {
        // title maxBytes 兜底 CJK / emoji UTF-8 多字节放大(200 char CJK ~600B)
        titleStr = requireString(IPC.NOTES_WRITE, title, 'title', {
          maxLen: MAX_NOTE_TITLE_CHARS,
          maxBytes: MAX_NOTE_TITLE_BYTES,
        });
      }
      let expectedMtimeMs: number | undefined;
      if (expectedMtime !== undefined) {
        // audit-r151:Number.isFinite 排除 NaN/Infinity,但放过负数 —— mtimeMs
        //   永远 ≥ 0,负值与磁盘 mtime 比对恒不等 → 写操作**永远**抛 CONFLICT。
        //   旧实现对负值 silently 拒,用户体验是「保存按钮按了也没反应」。
        //   显式 negative 校验让 UI 看到 VALIDATION 而非 CONFLICT,定位更快。
        if (typeof expectedMtime !== 'number' || !Number.isFinite(expectedMtime) || expectedMtime < 0) {
          throw new LibraryError(
            'VALIDATION',
            tr('notes.invalidExpectedMtime', { value: String(expectedMtime) }),
          );
        }
        expectedMtimeMs = expectedMtime;
      }
      const n = await svc.write(idStr, bodyStr, titleStr, expectedMtimeMs);
      // r192:id 漂移 —— svc.write 在 frontmatter 的 id 与「当前 relPath 的哈希」
      //   不一致时,会把 fm.id **重钉**为 computeFileId(relPath) 并返回**新 id**
      //   (旧 id 的 byId 键 + DB 行已被删掉)。收藏条目按 fileId 索引 ⇒ 旧 id
      //   变成永远命中不了的孤儿 ⇒ ★ 在保存成功的瞬间静默消失(r189 同款,
      //   只是触发点是「保存」而不是「改名 / 搬移」)。跟着改。
      if (n.id !== idStr) {
        await remapFavoritesForNote({ oldId: idStr, newId: n.id, path: n.relPath });
      }
      // FTS 失败 → 主表 INSERT 同事务回滚 → wrap.ts 冒泡 INTERNAL,三态一致
      return n;
    },
  );

  handle(IPC.NOTES_CREATE, async (_e, filename: string) => {
    const filenameStr = requireString(IPC.NOTES_CREATE, filename, 'filename', {
      maxLen: MAX_NOTE_FIELD_CHARS,
    });
    // svc.create 抛 LibraryError('DUPLICATE_NAME') 或普通 IO 错,原样上抛:
    // store.create retry loop 精准识别 DUPLICATE_NAME 自动换名重试,其它错误透传
    const n = await svc.create(filenameStr);
    return n;
  });

  handle(IPC.NOTES_TRASH, async (_e, id: string) => {
    const idStr = requireString(IPC.NOTES_TRASH, id, 'id', { maxLen: MAX_NOTE_FIELD_CHARS });
    // 删除走系统回收站(electron shell.trashItem,经 svc.trash → safeTrash),
    // 用户可恢复。audit 2026-09-10:DB delete 走 onAfterTrash:之前 onBeforeUnlink
    // 顺序在删除失败(EPERM / OneDrive sync lock / AV 扫描)时留下"DB 永久 stale,
    // 文件还在"鬼影 —— user 看到"看得见搜不着",只有手动重 save 才能修复。改成
    // onAfterTrash 后:删除失败 → byId/DB/文件三态一致(无变化)user 重试即可。
    await svc.trash(
      idStr,
      // onBeforeTrash 不再 DB delete,仅 hook 入口(rename race 仍由 writeLock 串行化保证)
      undefined,
      // DB delete 在 trash 成功后执行 —— deleteResource(ResourceId 带 note: 前缀)
      () => deleteResource(noteResourceId(idStr)),
    );
    // r198:文件已进回收站 ⇒ 收藏条目跟着清(否则 ★ 状态错位 + 死条目堆积)
    await removeFavoritesForNote(idStr);
  });

  handle(IPC.NOTES_RENAME_FILE, async (_e, id: string, newFilename: string) => {
    const idStr = requireString(IPC.NOTES_RENAME_FILE, id, 'id', { maxLen: MAX_NOTE_FIELD_CHARS });
    const newFilenameStr = requireString(IPC.NOTES_RENAME_FILE, newFilename, 'newFilename', {
      maxLen: MAX_NOTE_FIELD_CHARS,
    });
    // audit-r151:DB tx 已经在 svc.renameFile 内 writeLock 串行化(见
    //   notes/service.ts:renameFile 注释)—— 旧实现 IPC handler 在
    //   writeLock 释放后再跑 renameResource,DB 失败时 byId 已更新,
    //   出现 disk 新文件 + byId 新 id + DB 旧 row + FTS 旧行的三态漂移。
    //   现在 svc 内部先 disk rename → DB tx → byId mutation,失败 throw
    //   时 byId 保持原状,chokidar 'unlink' + 'add' 触发 scheduleReload
    //   重建 byId 把新文件按新 relPath 入 byId。Self-healing,handler
    //   只需做参数校验 + DUPLICATE_NAME → VALIDATION 翻译。
    try {
      const renamed = await svc.renameFile(idStr, newFilenameStr);
      // r182:笔记 id = SHA-256(relPath) 前 16 位 ⇒ 改名后 id 变 ⇒ 收藏条目
      //   的 fileId 变孤儿(★ 静默消失)。这里把收藏跟着改。
      await remapFavoritesForNote({
        oldId: idStr,
        newId: renamed.id,
        path: renamed.relPath,
      });
      return renamed;
    } catch (err: unknown) {
      // DUPLICATE_NAME 转 VALIDATION:create 早就翻译过,rename 一直漏 —— 用户撞名
      // 时看 IO_ERROR 误导为系统问题。修复后两边 UX 一致
      if (err instanceof LibraryError && err.code === 'DUPLICATE_NAME') {
        throw new ValidationError(err.message, 'newFilename', err);
      }
      throw err;
    }
  });

  // r161+ disk-folder Phase 2b:跨文件夹移动(id, targetRelPath) →
  //   { relPath, id }。targetRelPath 是「目标目录」相对路径('' = 根,
  //   'foo', 'foo/bar'),不含文件名 —— svc.moveFile 内部拼 newRelPath =
  //   ${targetRelPath}/${basename(oldRelPath)}。
  //
  // 边界由 standalone.moveNoteAcrossFolders 承担(targetRelPath 段校验 +
  //   越界 resolveInsideRootPath + 自动 mkdir 父 + EEXIST → DUPLICATE_NAME +
  //   ENOENT → NOT_FOUND),handler 只做参数校验 + 错误码翻译。
  handle<[string, string], { relPath: string; id: string }>(
    IPC.NOTES_MOVE,
    async (_e, idRaw, targetRelPathRaw) => {
      const idStr = requireString(IPC.NOTES_MOVE, idRaw, 'id', {
        maxLen: MAX_NOTE_FIELD_CHARS,
      });
      const targetRelPathStr = requireString(IPC.NOTES_MOVE, targetRelPathRaw, 'targetRelPath', {
        maxLen: MAX_IPC_PATH_CHARS,
      });
      const moved = await svc.moveFile(idStr, targetRelPathStr);
      // r182:搬移改 relPath ⇒ 改 id ⇒ 收藏条目跟着改(★ 不该在搬完的瞬间消失)
      await remapFavoritesForNote({
        oldId: idStr,
        newId: moved.id,
        path: moved.relPath,
      });
      return { relPath: moved.relPath, id: moved.id };
    },
  );

  // 拖入导入:单文件一次 IPC,renderer 批量拖入时循环发 N 次;主进程 NotesService.writeLock
  // 串行化(见 service.ts:writeLock),无需额外并发控制。notes.createNote 内部已
  // emit('changed') → renderer reload,无需主动 listNotes
  //
  // r175:走 svc.importFile 而不是裸 helper —— 旧实现导入完全绕开 service,
  //   导入的笔记不进 byId / resources 表:renderer 紧接着的「移入当前文件夹」
  //   必 NOT_FOUND,且全局搜索永远搜不到(见 service.importFile 注释)。
  handle<[string], NotesImportResult>(IPC.NOTES_IMPORT_FROM_FILE, async (_event, rawPath) => {
    const filePath = requireString(IPC.NOTES_IMPORT_FROM_FILE, rawPath, 'path', {
      maxLen: MAX_IPC_PATH_CHARS,
    });
    requireAbsolutePath(filePath, { ipc: IPC.NOTES_IMPORT_FROM_FILE, field: 'path' });
    // 安全边界由 notes/import.ts 承担(后缀白名单 + lstat symlink skip +
    // 单 fd TOCTOU 防换 symlink + 5MB 上限),与 reader 通道同源同等级
    return svc.importFile(filePath);
  });

  // NOTES_*_FOR_SOURCE 已下线 —— per-file notes 退役,3 个 handler 删除;
  // AI 模块 2026-09 V1.6 下线后,IPC.AI_GET 及 ai/<hash>.md 读写层整体消失
  // (audit-r78:原文误引了一个从未进过 IPC enum 的 WRITE 通道 key —— 考古
  //  git 历史证实;AI 内容写入本就走 fs,无独立通道。误引链已就此斩断)

  // 「在文件管理器中显示」。历史上与 library:show-in-folder 对称(r56 已随
  // library 域下线);notes 域是唯一存活实现。Win/Mac 走
  // shell.showItemInFolder(选中),Linux 降级 openPath(父目录)。单 syscall
  // fs.open 预检文件存在,防 shell 调用时文件已被外部删导致静默 no-op
  handle(IPC.NOTES_SHOW_IN_FOLDER, async (_e, id: string) => {
    const idStr = requireString(IPC.NOTES_SHOW_IN_FOLDER, id, 'id', {
      maxLen: MAX_NOTE_FIELD_CHARS,
    });
    const n = svc.findById(idStr);
    if (!n) {
      throw new LibraryError('NOT_FOUND', tr('notes.notFound', { id: idStr }));
    }
    const absPath = toNotePath(getRootPath(), n.relPath);
    await assertFileExists(absPath, tr('notes.notFoundPath', { path: absPath }), log);
    await revealInOSFileManagerSafe(absPath);
  });

  // audit-r73:此处原为 NOTES_RESCYNC_PROGRESS_GET_STATE 的 handleZod ——
  // 配对的 push 通道从未有 send 点,GET_STATE 从未有 renderer 调用方,整对删除。
  // ghost 行清理由 NotesService.resyncIfNeeded 就地完成。
  // audit-r156:settings.notesResyncPending 同链路一并删除。
}
