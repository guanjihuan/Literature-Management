// 工作台扩展 IPC:独立收藏。接收写入 → emit 'changed' → IPC.FAVORITES_CHANGED
// 推送渲染端,业务逻辑收敛主进程。group CRUD(V1.4 下线,group 是 read-only
// metadata 无 IPC consumer)后续 V2.0 需要管理时再 wire。
import { IPC, type WorkspacePaths } from '../../shared/types';
import { handle, requireObject, requireString } from './wrap';
import { getFavoritesService } from '../workspace/favorites';
import { buildWorkspacePaths } from './paths';
import {
  MAX_IPC_PATH_CHARS,
  MAX_IPC_PATH_CHARS as MAX_FAVORITES_FILE_ID_CHARS,
  MAX_NOTE_TITLE_CHARS,
} from './path-limits';

export function registerWorkspaceIPC(): void {
  const favorites = getFavoritesService();

  // ===== 独立收藏 =====
  // FAVORITES_LIST 过滤 group —— renderer 只消费 file entry(★ filter /
  // favoritedFileIds Set),group 是 read-only metadata,filter 后返 FavoritesFileEntry[]
  handle<[], Awaited<ReturnType<typeof favorites.listEntries>>>(IPC.FAVORITES_LIST, async () =>
    favorites.listEntries().filter((e) => e.kind === 'file'),
  );
  handle(IPC.FAVORITES_TOGGLE, async (_e, fileId: unknown, info?: unknown) => {
    // ValidationError 让 wrap.ts 归类 VALIDATION,UI 端可拿 field 做字段级高亮
    // audit-r124:fileId / relPath 上限从 MAX_NOTE_FIELD_CHARS(256)改为
    //   MAX_IPC_PATH_CHARS(4096)。256 是「id=16 字符 hex」时代的产物,而
    //   literature 收藏的 fileId 实为 'lit:'+绝对路径(LiteratureList.tsx 传
    //   r.id),深层 Windows 路径 >256 字符完全常规 → 点 ★ 恒 VALIDATION
    //   「收藏失败」,功能对长路径用户不可用。relPath 同理由收藏 toggle 的
    //   schema 早已声明 4096,运行时与 schema 对齐。
    const fileIdStr = requireString(IPC.FAVORITES_TOGGLE, fileId, 'fileId', {
      maxLen: MAX_FAVORITES_FILE_ID_CHARS,
    });
    // info 存在时必须是 object(否则 VALIDATION);内部字段若存在必须是 string
    // (否则 VALIDATION 透传 field);undefined 走 '' fallback 兼容既有行为。
    // 旧实现 `typeof o.title === 'string' ? o.title : ''` 是 silent coercion,
    // renderer 注入 `{ title: 42 }` 静默存成 '' 落盘
    let infoClean: { title: string; relPath: string } | undefined;
    if (info !== undefined && info !== null) {
      const o = requireObject(IPC.FAVORITES_TOGGLE, info);
      // title/relPath 加 maxLen 防止 renderer 注入 1MB 字符串撑爆 favorites.md
      infoClean = {
        title:
          o.title === undefined
            ? ''
            : requireString(IPC.FAVORITES_TOGGLE, o.title, 'title', {
                maxLen: MAX_NOTE_TITLE_CHARS,
              }),
        relPath:
          o.relPath === undefined
            ? ''
            : requireString(IPC.FAVORITES_TOGGLE, o.relPath, 'relPath', {
                maxLen: MAX_IPC_PATH_CHARS,
              }),
      };
    }
    const favorited = await favorites.toggle(fileIdStr, infoClean);
    return { favorited, fileId: fileIdStr };
  });

  // ===== 模块数据路径 =====
  // 渲染层「在文件管理器中打开」按钮:派生自 getRootPath() + WORKSPACE_DATA_LAYOUT,
  // 一次拉取,模块切换时无 IPC
  handle<[], WorkspacePaths>(IPC.WORKSPACE_GET_PATHS, async () => buildWorkspacePaths());

  // audit-r211:配对的 pull 通道 FAVORITES_GET_STATE 整对下线 —— 它与
  //   FAVORITES_LIST 同源同形(都是 listEntries() 过滤 file),而 renderer
  //   从来没调用过它(src/renderer/ 全域零调用点)。「push 先于 listener
  //   注册」的竞态由 useSyncStores 的「先订阅再 load」覆盖(2026-09-10 的修法)。
}
