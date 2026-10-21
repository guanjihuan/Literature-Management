// src/main/ipc/folders.ts
//
// r161+ disk-folder:侧栏 VS Code 式文件管理走真实磁盘目录,不再有 DB 虚拟
//   folders 表。8 通道两两对称服务 notes / literature 两棵 kind 树:
//
//   list-dirs(parentRelPath|null) -> DiskFolderNode[]
//     一层直接子目录(非递归,深度无限 deep-walk 留给 caller 显式逐层 enter)
//     dot 隐藏 / symlink / 非目录全部跳过;按名字自然序升序
//
//   mkdir(relPath) -> { relPath }
//     在 kind 树下创建完整 relPath(可含 '/',自动递归父目录);
//     路径已存在且是目录 → no-op 幂等
//
//   rename-dir(oldRelPath, newName) -> { relPath }
//     单段 rename —— 只换最后一段 basename,跨级不支持(跨级先 mkdir 目标)
//     同级同名拒绝
//
//   trash-dir(relPath) -> null
//     整棵子树走 shell.trashItem(可恢复);symlink 拒收
//
//   所有路径必须落在 <rootPath>/<kind>/ 子树内,safe-write 守门越界 reject
import { join } from 'path';
import { promises as fs } from 'fs';
import { IPC, WORKSPACE_DATA_LAYOUT } from '../../shared/types';
import { handle, requireString } from './wrap';
import { MAX_IPC_PATH_CHARS } from './path-limits';
import { ValidationError, AppError, errMsg } from '../utils/error';
import { tr } from '../i18n';
import { createLogger } from '../utils/logger';
import { getRootPath, safeMkdir, safeRecursiveTrash, listSubdirs } from '../utils/safe-write';
import { validateRelPath, validateFolderName } from '@shared/rel-path';
import { remapFavoriteIds, type FavoriteIdRemap } from '../workspace/favorites';
import type { DiskFolderNode, FolderMoveResult, ResourceKind } from '@shared/types';
import type { NotesService } from '../notes/service';
import type { LiteratureService } from '../literature/literature-service';

const log = createLogger('folders-ipc');

// r186:relPath 校验收成**一份** —— shared/rel-path.ts。
//   旧版本地三份规则互相不一致(本文件的段正则拒收「首字符是空白」,
//   notes/literature 两个 service 却放行),后果是「应用能往一个自己不
//   承认存在的夹里搬数据」:磁盘上名字以空格开头的夹,侧栏列得出来却
//   点不进去(本文件拒收),而笔记/文献的 move 放行 → 笔记搬得进去、
//   界面找不到。详见 shared/rel-path.ts 头注。
//
//   本文件只做「错误类型 + 消息前缀」的翻译,判定逻辑全部委托给 shared。

function requireKind(channel: string, value: unknown): ResourceKind {
  if (value !== 'note' && value !== 'literature') {
    throw new ValidationError(`${channel}: field "kind" must be 'note' | 'literature'`, 'kind');
  }
  return value;
}

/**
 * 校验 IPC 传入的 relPath 是「<rootPath>/<kind>/ 下」的合法 POSIX 相对路径。
 *   拒收:绝对路径、含 .. 越界、空字符串作 null 时本函数不调用(null 走专门 path)
 *   接收:'foo' / 'foo/bar'(POSIX 风格,win32 也走 '/')
 * 校验失败抛 VALIDATION + field='relPath'。
 */
export function requireRelPath(channel: string, value: unknown, field: string): string {
  const s = requireString(channel, value, field, { maxLen: MAX_IPC_PATH_CHARS });
  const problem = validateRelPath(s);
  if (problem) {
    throw new ValidationError(`${channel}: field "${field}" ${problem.message}`, field);
  }
  return s;
}

function requireNullableRelPath(channel: string, value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return requireRelPath(channel, value, field);
}

export function requireFolderName(channel: string, value: unknown, field: string): string {
  const s = requireString(channel, value, field, { maxLen: MAX_IPC_PATH_CHARS });
  // 单段 name 与 relPath 里的段走**同一份**核心规则,再叠加创建策略
  // (段长 ≤ 100)—— 否则会出现「能用 name 建的夹,不能用 path 进」的不变量
  // I1 被破坏(旧实现:FOLDER_NAME_RE 放行 'a..b',requireRelPath 却拒收)。
  const problem = validateFolderName(s);
  if (problem) {
    throw new ValidationError(`${channel}: field "${field}" ${problem.message}`, field);
  }
  return s;
}

/**
 * mkdir 的 relPath —— 整条走路径规则(核心),**叶子段**额外走创建策略
 * (名字 ≤ 100 字符):叶子才是这次真正新建的那个夹的名字。
 *
 * 父段只按路径规则(不限长度):它们多半是磁盘上**已存在**的目录
 * (用户在资源管理器里建的、可能超长),不该因此拒绝「在里面建子夹」。
 */
export function requireNewFolderRelPath(
  channel: string,
  value: unknown,
  field: string,
): string {
  const s = requireRelPath(channel, value, field);
  const leaf = s.slice(s.lastIndexOf('/') + 1);
  const problem = validateFolderName(leaf);
  if (problem) {
    throw new ValidationError(`${channel}: field "${field}" ${problem.message}`, field);
  }
  return s;
}

/**
 * 目标**父目录** relPath 校验 —— 与 requireRelPath 的区别:根目录用空串
 *   表示(不是 null),且空串是合法值(不代表「段非法」)。
 *   null / undefined / '' → '' (根)
 *   'foo' / 'foo/bar'     → 原样
 *   '..' / 绝对路径 / 空段 / '.' 开头段 → VALIDATION
 */
export function requireParentRelPath(channel: string, value: unknown, field: string): string {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value !== 'string') {
    throw new ValidationError(`${channel}: field "${field}" must be a string`, field);
  }
  const problem = validateRelPath(value, { allowRoot: true });
  if (problem) {
    throw new ValidationError(`${channel}: field "${field}" ${problem.message}`, field);
  }
  return value;
}

/**
 * r189:文件夹(子树)改名 / 跨目录搬移后,把子树里每个资源的收藏(★)跟着走。
 *
 * r182 只接了**单文件**的改名 / 搬移(见 ipc/notes.ts、ipc/literature.ts),
 * 文件夹层的接线被 r182 的提交说明显式推迟(r183 的 folders.ts 合流后再补)，
 * 一直没补 ⇒ 用户可复现的 bug:
 *   1. ★ 一个文件夹里的文献;
 *   2. 右键该文件夹 → 重命名(或剪切 → 粘贴到别的目录);
 *   3. 文件夹在树上改名/搬走了,但**★ 静默消失** —— favorites.md 里还留着
 *      旧 fileId,而新 id 是按路径算出来的(notes: fm.id = SHA-256(relPath)
 *      前 16 位;literature: 'lit:' + POSIX 绝对路径)⇒ 旧 id 再也不会命中
 *      任何一行,那条收藏变成永远点不亮的孤儿。
 *
 * path 字段的形态**按域不同**(写错形态 ⇒ ★ 还在但面板里的路径指向不存在的文件):
 *   - notes      = 相对 notes 根的 relPath(notes 侧 toggle 传 relPath);
 *   - literature = **绝对** POSIX 路径(literature 侧 toggle 传 absPath)。
 *
 * best-effort:收藏改写失败**不能**让已经成功的目录操作变成失败。
 */
async function remapFavoritesForSubtree(
  idRemap: FolderMoveResult['idRemap'],
  kind: ResourceKind,
): Promise<void> {
  if (idRemap.length === 0) return;
  const items: FavoriteIdRemap[] = idRemap.map((it) => ({
    oldId: it.oldId,
    newId: it.newId,
    path: kind === 'literature' ? it.absPath : it.relPath,
  }));
  try {
    const n = await remapFavoriteIds(items);
    if (n > 0) log.info('favorites remapped after folder change', { kind, count: n });
  } catch (err: unknown) {
    log.warn('favorites remap failed after folder change', { kind, err: errMsg(err) });
  }
}

export function registerFoldersIPC(
  notesService: NotesService,
  literatureService: LiteratureService,
): void {
  handle<[unknown, unknown], DiskFolderNode[]>(
    IPC.NOTES_FOLDERS_LIST_DIRS,
    async (_e, kindRaw, parentRelRaw) => {
      const kind = requireKind(IPC.NOTES_FOLDERS_LIST_DIRS, kindRaw);
      const parentRel = requireNullableRelPath(
        IPC.NOTES_FOLDERS_LIST_DIRS,
        parentRelRaw,
        'parentRelPath',
      );
      return listSubdirs(getRootPath(), kind, parentRel);
    },
  );

  handle<[unknown], { relPath: string }>(
    IPC.NOTES_FOLDERS_MKDIR,
    async (_e, relRaw) => {
      const relPath = requireNewFolderRelPath(IPC.NOTES_FOLDERS_MKDIR, relRaw, 'relPath');
      // notes 域在 <rootPath>/notes/<relPath> 建 —— 显式拼绝对路径
      const abs = join(getRootPath(), WORKSPACE_DATA_LAYOUT.NOTES_DIR, relPath);
      await safeMkdir(abs);
      return { relPath };
    },
  );

  // r175:重命名文件夹 —— 走 service.renameDir,不再裸 fs.rename。
  //
  // 旧实现(本 handler 内联 fs.rename)只搬目录,**不重钉子树里每个笔记的
  // frontmatter id、不更新 DB 的 rel_path**。笔记 id 与路径强绑定
  // (fm.id = SHA-256(relPath) 前 16 位)⇒ 重命名目录后 id 全变而
  // byId / 文件 / DB 三处指向不同 id ⇒ 打开刚改名的笔记必 NOT_FOUND,
  // 且下一次写盘会重烧 id 令 renderer 手里那个 id 变死 id(之后的保存
  // 全部 NOT_FOUND,用户新敲的字困在草稿里,重启即丢)。
  // service.renameDir 负责「物理搬家 + 逐个重钉 id + DB rename +
  // byId 换键」,并返回 idRemap 让 renderer 把选中态跟到新 id。
  handle<[unknown, unknown], FolderMoveResult>(
    IPC.NOTES_FOLDERS_RENAME_DIR,
    async (_e, oldRelRaw, newNameRaw) => {
      const oldRelPath = requireRelPath(IPC.NOTES_FOLDERS_RENAME_DIR, oldRelRaw, 'oldRelPath');
      const newName = requireFolderName(IPC.NOTES_FOLDERS_RENAME_DIR, newNameRaw, 'newName');
      const rootPath = getRootPath();
      const oldAbs = join(rootPath, WORKSPACE_DATA_LAYOUT.NOTES_DIR, oldRelPath);
      // 同级重名检测:目标 basename 在父目录下不存在
      const parentAbs = join(oldAbs, '..');
      try {
        const entries = await fs.readdir(parentAbs, { withFileTypes: true });
        if (entries.some((e) => e.isDirectory() && e.name === newName)) {
          throw new AppError('DUPLICATE_NAME', tr('diskFolder.duplicateName', { name: newName }));
        }
      } catch (err: unknown) {
        if (err instanceof AppError) throw err;
        if ((err as { code?: string }).code !== 'ENOENT') throw err;
      }
      const newRel = oldRelPath.includes('/')
        ? oldRelPath.slice(0, oldRelPath.lastIndexOf('/') + 1) + newName
        : newName;
      const renamed = await notesService.renameDir(oldRelPath, newRel);
      await remapFavoritesForSubtree(renamed.idRemap, 'note');
      log.info('notes folder renamed', { oldRelPath, relPath: renamed.relPath });
      return renamed;
    },
  );

  handle<[unknown], null>(
    IPC.NOTES_FOLDERS_TRASH_DIR,
    async (_e, relRaw) => {
      const relPath = requireRelPath(IPC.NOTES_FOLDERS_TRASH_DIR, relRaw, 'relPath');
      const abs = join(getRootPath(), WORKSPACE_DATA_LAYOUT.NOTES_DIR, relPath);
      await safeRecursiveTrash(abs);
      log.info('notes folder trashed', { relPath });
      return null;
    },
  );

  // ---- literature 域对称 ----
  handle<[unknown, unknown], DiskFolderNode[]>(
    IPC.LITERATURE_FOLDERS_LIST_DIRS,
    async (_e, kindRaw, parentRelRaw) => {
      const kind = requireKind(IPC.LITERATURE_FOLDERS_LIST_DIRS, kindRaw);
      const parentRel = requireNullableRelPath(
        IPC.LITERATURE_FOLDERS_LIST_DIRS,
        parentRelRaw,
        'parentRelPath',
      );
      return listSubdirs(getRootPath(), kind, parentRel);
    },
  );

  handle<[unknown], { relPath: string }>(
    IPC.LITERATURE_FOLDERS_MKDIR,
    async (_e, relRaw) => {
      const relPath = requireNewFolderRelPath(IPC.LITERATURE_FOLDERS_MKDIR, relRaw, 'relPath');
      const abs = join(getRootPath(), WORKSPACE_DATA_LAYOUT.LITERATURE_DIR, relPath);
      await safeMkdir(abs);
      return { relPath };
    },
  );

  // r175:文献域对称 —— 走 literatureService.renameDir(见上方 notes 版注释)
  //   文献 id = 'lit:'+toPosix(absPath),目录改名 ⇒ 子树里每个文献的
  //   absPath 变 ⇒ id 变;旧实现裸 fs.rename 后 byId / DB / 磁盘三处
  //   脱节,renderer 手里选中态指向已不存在的路径。
  handle<[unknown, unknown], FolderMoveResult>(
    IPC.LITERATURE_FOLDERS_RENAME_DIR,
    async (_e, oldRelRaw, newNameRaw) => {
      const oldRelPath = requireRelPath(IPC.LITERATURE_FOLDERS_RENAME_DIR, oldRelRaw, 'oldRelPath');
      const newName = requireFolderName(IPC.LITERATURE_FOLDERS_RENAME_DIR, newNameRaw, 'newName');
      const rootPath = getRootPath();
      const oldAbs = join(rootPath, WORKSPACE_DATA_LAYOUT.LITERATURE_DIR, oldRelPath);
      const parentAbs = join(oldAbs, '..');
      try {
        const entries = await fs.readdir(parentAbs, { withFileTypes: true });
        if (entries.some((e) => e.isDirectory() && e.name === newName)) {
          throw new AppError('DUPLICATE_NAME', tr('diskFolder.duplicateName', { name: newName }));
        }
      } catch (err: unknown) {
        if (err instanceof AppError) throw err;
        if ((err as { code?: string }).code !== 'ENOENT') throw err;
      }
      const newRel = oldRelPath.includes('/')
        ? oldRelPath.slice(0, oldRelPath.lastIndexOf('/') + 1) + newName
        : newName;
      const renamed = await literatureService.renameDir(oldRelPath, newRel);
      await remapFavoritesForSubtree(renamed.idRemap, 'literature');
      log.info('literature folder renamed', { oldRelPath, relPath: renamed.relPath });
      return renamed;
    },
  );

  handle<[unknown], null>(
    IPC.LITERATURE_FOLDERS_TRASH_DIR,
    async (_e, relRaw) => {
      const relPath = requireRelPath(IPC.LITERATURE_FOLDERS_TRASH_DIR, relRaw, 'relPath');
      const abs = join(getRootPath(), WORKSPACE_DATA_LAYOUT.LITERATURE_DIR, relPath);
      await safeRecursiveTrash(abs);
      log.info('literature folder trashed', { relPath });
      return null;
    },
  );

  // ---- r173:目录(子树)跨父目录搬移 ----
  //
  // 场景:侧栏「剪切文件夹 → 粘贴到另一个目录」「把文件夹拖到别的目录」
  //   「移到根目录」。此前 renderer 侧的 pasteFolderInto / moveFolderNow
  //   全是 throw「not yet supported」的占位,文件夹拖拽的 dataTransfer
  //   payload 又因 ids: [] 被 readMovePayload 拒收 —— 三条路径全断。
  //
  // 与单文件 move(IPC.NOTES_MOVE / IPC.LITERATURE_MOVE)的差别:搬的是
  //   整棵子树,里面每个资源 id 都变(notes id 随 relPath、lit id 随
  //   absPath),所以返回 idRemap 让 renderer 把选中态跟过去。
  handle<[unknown, unknown], FolderMoveResult>(
    IPC.NOTES_FOLDERS_MOVE_DIR,
    async (_e, oldRelRaw, newParentRelRaw) => {
      const oldRelPath = requireRelPath(
        IPC.NOTES_FOLDERS_MOVE_DIR,
        oldRelRaw,
        'oldRelPath',
      );
      const newParentRelPath = requireParentRelPath(
        IPC.NOTES_FOLDERS_MOVE_DIR,
        newParentRelRaw,
        'newParentRelPath',
      );
      const moved = await notesService.moveDir(oldRelPath, newParentRelPath);
      await remapFavoritesForSubtree(moved.idRemap, 'note');
      log.info('notes folder moved', { oldRelPath, relPath: moved.relPath });
      return moved;
    },
  );

  handle<[unknown, unknown], FolderMoveResult>(
    IPC.LITERATURE_FOLDERS_MOVE_DIR,
    async (_e, oldRelRaw, newParentRelRaw) => {
      const oldRelPath = requireRelPath(
        IPC.LITERATURE_FOLDERS_MOVE_DIR,
        oldRelRaw,
        'oldRelPath',
      );
      const newParentRelPath = requireParentRelPath(
        IPC.LITERATURE_FOLDERS_MOVE_DIR,
        newParentRelRaw,
        'newParentRelPath',
      );
      const moved = await literatureService.moveDir(oldRelPath, newParentRelPath);
      await remapFavoritesForSubtree(moved.idRemap, 'literature');
      log.info('literature folder moved', { oldRelPath, relPath: moved.relPath });
      return moved;
    },
  );
}
