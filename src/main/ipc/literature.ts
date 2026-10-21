// 文献模块 IPC(audit-r71)—— resources 单表上的操作四通道:
//   literature:list / literature:import-from-file / literature:delete /
//   literature:get-state
//
// r187:加 literature:rename-file —— 文献**单文件**重命名(与 notes 域的
//   notes:rename-file 对称)。此前 literature 域只能搬移、不能改名,两侧
//   操作集不对应(笔记能改名 / 文献不能),用户诉求「相关的文件操作也是
//   对应的」在这一条上不成立。
//
// domain 用 literature 不用 library:library:* 操作面在 r56 已整体退役,
// ipc-handlers smoke 锁死 library 域恰 1 个 handler(readFileForReader)且
// 退役通道不得复活(library:list 等 not.toContain)。readFileForReader 继续
// 归 registerLibraryIPC,文献行点开阅读的数据流 = list 拿 absPath →
// Reader 走 readFileForReader(bytes 类)或 rkms://(PDF/图片)。
//
// audit-r136:接入 LiteratureService —— list / GET_STATE 直返 svc.list()
// (byId 全量按 mtime 倒序),背后是 chokidar 监听 <rootPath>/literature/
// + reload 内 active disk↔DB diff(磁盘有 DB 无 → upsert filename-only 行,
// DB 有磁盘无 → 删 ghost 行)。push 通道 LITERATURE_CHANGED 由主进程
// index.ts 单独订阅 svc 'changed' 事件 + broadcastToAllWindows 桥接,
// 此文件不持推送逻辑(单一职责:IPC handler 落点)。GET_STATE 是 r54 I4
// pull-snapshot 配对契约(防「主进程 push 已先于 renderer listener」竞态),
// 契约由 pull-snapshot-companion.test.ts 锁住。
import type { LiteratureImportResult, LiteratureRenameResult } from '@shared/api-types';
import { IPC, type LiteratureResource, type ResourceId } from '../../shared/types';
import { handle, requireString } from './wrap';
import { MAX_IPC_PATH_CHARS, requireAbsolutePath } from './path-limits';
import type { LiteratureService } from '../literature/literature-service';
import { remapFavoriteIds, removeFavoriteIds } from '../workspace/favorites';
import { errMsg } from '../utils/error';
import { createLogger } from '../utils/logger';

const log = createLogger('ipc-literature');

/**
 * r182:文献 id 变更(搬进/搬出文件夹)后,把收藏条目的 fileId 跟着改 ——
 *   否则用户的 ★ 在操作成功的瞬间静默消失。
 *   best-effort:失败不影响已经成功的文件操作。
 */
async function remapFavoritesForLiterature(item: {
  oldId: string;
  newId: string;
  path?: string;
}): Promise<void> {
  try {
    const n = await remapFavoriteIds([item]);
    if (n > 0) log.info('favorites remapped after literature move', { count: n });
  } catch (err: unknown) {
    log.warn('favorites remap failed after literature move', { err: errMsg(err) });
  }
}

/**
 * r198:文献被删除(移入回收站)后,清掉它的收藏条目。
 *   文献 id = 'lit:'+toPosix(absPath) ⇒ 同一个文件从原路径再导入一次会
 *   **复用同一个 id** ⇒ 不清掉孤儿条目的话,新行会继承旧 ★(用户没点过
 *   却显示已收藏),再点一下反而是「取消收藏」。
 *   best-effort:收藏清理失败**不能**让已经成功的删除变成失败。
 */
async function removeFavoritesForLiterature(id: string): Promise<void> {
  try {
    const n = await removeFavoriteIds([id]);
    if (n > 0) log.info('favorites removed after literature delete', { count: n });
  } catch (err: unknown) {
    log.warn('favorites cleanup failed after literature delete', { err: errMsg(err) });
  }
}

export function registerLiteratureIPC(svc: LiteratureService): void {
  // audit-r136:走 svc.list() 而不是 listResources —— service 的 byId 反映
  //   最近一次 disk↔DB diff 状态(含 OS 拖入 / 外部删的 row);repo 读的是
  //   DB 持久层,两路径最终收敛同一形态,但 svc 路径省一次 SQL,且 byId 已
  //   按 mtime 倒序排好,renderer 拿到不用再排。
  handle<[], LiteratureResource[]>(IPC.LITERATURE_LIST, () => svc.list());
  // audit-r211:配对的 pull 通道 LITERATURE_GET_STATE 整对下线 —— 它与
  //   LITERATURE_LIST 同源同形(都是 svc.list()),而 renderer 从来没调用过它
  //   (src/renderer/ 全域零调用点)。「push 先于 listener 注册」的竞态由
  //   「先订阅再 load」覆盖(store 模块顶层订阅 → 组件 useEffect 里首次 load)。

  handle<[string], LiteratureImportResult>(IPC.LITERATURE_IMPORT_FROM_FILE, async (_event, raw) => {
    // 源路径在 rootPath 外也必须放行 —— 它本来就是 OS 拖入的外部文件,
    // requireAbsolutePath 只挡相对路径注入(audit-r64 pickLibraryPath EPERM
    // 回归的教训:导入边界不套 allowed-root)。
    const sourcePath = requireString(IPC.LITERATURE_IMPORT_FROM_FILE, raw, 'path', {
      maxLen: MAX_IPC_PATH_CHARS,
    });
    requireAbsolutePath(sourcePath, {
      ipc: IPC.LITERATURE_IMPORT_FROM_FILE,
      field: 'path',
    });
    // audit-r170:导入收进 service —— 旧实现在 handler 里直调
    //   importLiteratureFile + upsertResource,**没更新 svc.byId**,于是
    //   「导入后立刻搬进文件夹」(复制粘贴 / OS 拖入两条路径)必然 NOT_FOUND,
    //   文件停在 literature 根。svc.importFile 把 DB 行与 byId 在同一次
    //   writeLock 内落地,搬移立刻可见。
    const imported = await svc.importFile(sourcePath);
    return imported;
  });

  handle<[string], null>(IPC.LITERATURE_DELETE, async (_event, raw) => {
    // 上限用 MAX_IPC_PATH_CHARS 而非 MAX_LIBRARY_ID_CHARS(64):id 的 raw 段
    // 就是完整路径,64 字符会把正常深路径条目误杀。
    const id = requireString(IPC.LITERATURE_DELETE, raw, 'id', {
      maxLen: MAX_IPC_PATH_CHARS,
    }) as ResourceId;
    // audit-r160:走 svc.remove(id) 而不是裸 fs.unlink + deleteResource
    //   —— 旧实现绕开 LiteratureService.writeLock,文件 + DB 删了 byId
    //   仍含 entry,chokidar 'unlink' 触发 scheduleReload + reload 走
    //   ~50ms 间,IPC.LITERATURE_LIST 走 byId 返回已删文件,UI 短暂闪老条目。
    //   svc.remove 内部三件(file / DB / byId)同 writeLock 内顺序,emit
    //   'changed' 推 renderer 拉新状态。note id 注入由 svc.remove 内部
    //   byId.get 失败抛 NOT_FOUND 统一兜底(注:db rows kind 过滤不再做
    //   —— byId 仅含 lit,kind 检查是冗余)。
    await svc.remove(id);
    // r198:文件已进回收站 ⇒ 收藏条目跟着清(否则同路径再导入会继承旧 ★)
    await removeFavoritesForLiterature(id);
    return null;
  });

  // r161+ disk-folder Phase 2b:跨文件夹移动文献(id, targetRelPath) →
  //   { absPath, id }。targetRelPath 是「目标目录」相对路径('' = 根,
  //   'foo', 'foo/bar'),不含文件名 —— svc.moveFile 内部拼 newAbsPath =
  //   `<rootPath>/literature/${targetRelPath}/${basename(oldAbsPath)}`。
  //
  // 边界由 svc.moveFile 承担(targetRelPath 段校验 + 越界 reject + 自动
  //   mkdir 父 + EEXIST → VALIDATION + ENOENT → NOT_FOUND),handler 只做
  //   参数校验 + 透传。
  handle<[string, string], { absPath: string; id: ResourceId }>(
    IPC.LITERATURE_MOVE,
    async (_e, idRaw, targetRelPathRaw) => {
      const id = requireString(IPC.LITERATURE_MOVE, idRaw, 'id', {
        maxLen: MAX_IPC_PATH_CHARS,
      }) as ResourceId;
      const targetRelPath = requireString(IPC.LITERATURE_MOVE, targetRelPathRaw, 'targetRelPath', {
        maxLen: MAX_IPC_PATH_CHARS,
      });
      const moved = await svc.moveFile(id, targetRelPath);
      // r182:文献 id = 'lit:'+toPosix(absPath) ⇒ 搬一次 id 就变 ⇒ 收藏条目
      //   的 fileId 变孤儿(★ 静默消失)。这里把收藏跟着改;path 用新的
      //   absPath(literature 侧 renderer 存的就是绝对路径)。
      await remapFavoritesForLiterature({
        oldId: id,
        newId: moved.id,
        path: moved.absPath,
      });
      return { absPath: moved.absPath, id: moved.id };
    },
  );

  // r187:文献单文件重命名(与 notes:rename-file 对称)——
  //   只改文件名,保留所在目录。lit id = 'lit:'+toPosix(absPath) ⇒ 改名后
  //   id 变 ⇒ 收藏条目的 fileId 变孤儿(★ 静默消失)⇒ 同搬移路径把收藏跟过去。
  handle<[string, string], LiteratureRenameResult>(
    IPC.LITERATURE_RENAME_FILE,
    async (_e, idRaw, newFilenameRaw) => {
      const id = requireString(IPC.LITERATURE_RENAME_FILE, idRaw, 'id', {
        maxLen: MAX_IPC_PATH_CHARS,
      }) as ResourceId;
      // 文件名不是路径 —— 长度上限给足(255 文件名 + 一点余量),但不允许
      //   空串。真正的合法性(分隔符 / 保留字符 / 撞名)在 service 侧的
      //   planLiteratureRename 里判,错误码语义更准(VALIDATION)。
      const newFilename = requireString(IPC.LITERATURE_RENAME_FILE, newFilenameRaw, 'newFilename', {
        maxLen: 512,
      });
      const renamed = await svc.renameFile(id, newFilename);
      await remapFavoritesForLiterature({
        oldId: id,
        newId: renamed.id,
        path: renamed.absPath,
      });
      return {
        id: renamed.id,
        absPath: renamed.absPath,
        oldAbsPath: renamed.oldAbsPath,
      };
    },
  );
}
