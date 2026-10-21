import { contextBridge, ipcRenderer, webUtils } from 'electron';
import {
  IPC,
  AppSettings,
  LiteratureResource,
  ReadFileForReaderResult,
  SearchHit,
  StandaloneNote,
  StandaloneNoteSummary,
  DiskFolderNode,
  FolderMoveResult,
  ResourceKind,
  WorkspacePaths,
  BootstrapPayload,
  STARTUP_PROGRESS_EVENT_TYPES,
  StartupProgressEvent,
  StartupProgressEventType,
  StartupProgressSnapshot,
  FavoritesFileEntry,
  IpcResult,
  ResourceId,
  ToastPushPayload,
  TOAST_EVENT_TYPES,
} from '../shared/types';
// audit v2.0 Phase 0a (2026-09-17):Api interface 从 renderer 手抄迁移到
//   src/shared/api-types.ts 单一真相源。preload 用 `const api: Api = {...}`
//   强制对齐 contract —— preload 增删 method 时 TS 编译期会因 assignability
//   失败报红。`typeof api` 在 generic invokeGuard<T> 上会被泛到 unknown,
//   所以不能继续靠 typeof 拿 Api type。
//
// 注意:下方 invokeGuard<T> 调用需要解析 generic 实参,所以 BootstrapPayload
//   / AppSettings 等 type 仍要 import —— 即使 Api 已经声明过返回类型,
//   TS 不会从 Api 反向回填 generic 上下文。
import type {
  Api,
  LiteratureImportResult,
  LiteratureRenameResult,
  NotesImportResult,
} from '../shared/api-types';
// audit r29 (2026-09-21):cq H2 — invokeGuard reject 分支走 errMsg 共享 helper,
//   preload 跑在 main 进程(与 main/utils/error 同侧),不引 renderer/lib/error;
//   inline `err instanceof Error ? err.message : String(err)` 是第 3 处重复。
// audit-r229:改直连 @shared/display-string —— errMsg 本体已下沉到 shared
//   (此前与 main/utils/error.ts 的实现逐字孪生,r217 只下沉了底座)。这同时
//   修掉 preload 的**运行时**引 main:main/utils/error 会把 main 的模块图
//   拖进 renderer 进程的启动路径,与「preload 只做桥、不含业务」冲突;
//   与 r140 把 MAX_TOAST_MESSAGE_CHARS 搬去 @shared/limits/ipc 同款修法。
import { errMsg } from '@shared/display-string';

// audit 2026-09-10:contextBridge 边界 runtime 校验 —— 原实现 4 个 on* listener
//   把 contextBridge 擦到 unknown 的第二参数直接 `as T` 强转,主进程一旦
//   发送异常载荷(regression / 版本错位)会走 `undefined.something` 抛错把
//   renderer 整死。统一走 assertPayload 入口,类型不对就 warn + 跳过,
//   不会让 handler 拿到 undefined 触发 NPE。
//   故意不抛:contextBridge 内抛错会冒泡到 electron 内部状态,不如静默
//   跳过 + log.warn 留 trace,行为降级为"本次事件丢失",下次正常事件照常
//   走通。
function assertPayload<T>(
  channel: string,
  payload: unknown,
  // 验证函数:返回 true 表示形状匹配,false 表示跳过 handler。
  validate: (p: unknown) => p is T,
): T | null {
  if (validate(payload)) return payload;
  // 故意不 throw —— 渲染层 IPC 事件丢失比整死主进程友好;log 留 trace。
  console.warn(`[preload] ${channel} payload shape mismatch, dropping event`, payload);
  return null;
}

// audit 2026-09-16 r21:H13 — ipcRenderer.invoke 的 runtime 形状守卫。
//   原 35 处 `as Promise<IpcResult<T>>` 都是类型撒谎:ipcRenderer.invoke
//   在主进程 handler throw / channel 缺失 / 序列化失败时直接 reject,
//   渲染端 await 永远 pending,无 toast / 无日志,体验上是"按钮没反应"。
//   修复:包一层 invokeGuard,reject 时自动 reject 一个带 {ok:false,...}
//   的 IpcResult,渲染端按统一路径处理错误。
function isIpcResult(value: unknown): value is IpcResult<unknown> {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.ok === true) return 'data' in v;
  if (v.ok === false) return typeof v.code === 'string' && typeof v.message === 'string';
  return false;
}
/**
 * IPC 调用护栏 —— 把 wire 层的不确定形状收敛成 `IpcResult`。
 *
 * audit 2026-10-01 语义说明(改过,别改回去):
 *   - **形状不对**(主进程正常回了但 envelope 被 regress / channel 错位 / 序列化
 *     异常)→ resolve 成 `{ok:false, code:'INTERNAL'}`。这是可预期的业务错误,
 *     渲染层 `unwrap()` 统一按 `!ok` 处理。
 *   - **调用被拒**(handler throw / channel 不存在 / contextBridge 断连)→
 *     **reject**。旧实现把它 resolve 成 `{ok:false}` 是错的,详见下方注释。
 */
function invokeGuard<T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> {
  return ipcRenderer.invoke(channel, ...args).then(
    (raw: unknown): IpcResult<T> => {
      if (isIpcResult(raw)) return raw as IpcResult<T>;
      // 形状不对 —— 主进程 regress / channel 错位 / 序列化异常。降级为
      // 错误响应,让渲染端走统一错误路径(toast 等)。
      console.warn(`[preload] ${channel} returned non-IpcResult envelope`, raw);
      return {
        ok: false,
        code: 'INTERNAL',
        message: `[preload] ${channel} returned non-IpcResult envelope`,
      };
    },
    (err: unknown): never => {
      // 主进程 handler throw / channel 缺失 / 序列化失败 → ipcRenderer.invoke reject。
      //
      // audit 2026-10-01:HIGH — 这里是 `.then(onFulfilled, onRejected)` 的**第二个
      //   参数**,旧实现 `return { ok:false, code:'IPC_REJECTED', message }` 把
      //   rejection 转成了 **fulfillment**。后果是全仓所有
      //   `api.xxx().catch(...)` 永远不可能执行(实测 17 处死代码),而其中
      //   settings.ts 的 `.then(() => localStorage.removeItem(...))` 更会在
      //   `{ok:false}` 时照样删掉兜底 key,让 pending layout 永久丢失 ——
      //   典型的「错误被静默吞掉」。
      //   另:形状不对的 envelope(上一个 handler 分支)仍然 return,那是
      //   **主进程正常回了但内容坏了**,属于可预期的业务错误,保持 resolve。
      const message = errMsg(err);
      console.warn(`[preload] ${channel} invoke rejected`, message);
      // 抛出的对象在结构上与 renderer 的 IpcError 对齐(name/code/message),
      // 于是 catch 块里读 err.code / errMsg(err) 的既有写法照常工作。
      const wrapped = new Error(`[preload] ${channel} invoke rejected: ${message}`) as Error & {
        code?: string;
        field?: string;
        size?: number;
      };
      wrapped.name = 'IpcError';
      // audit-r161:透传主进程 AppError 跨 structured clone 保留的 code/field/size
      const errObj =
        err && typeof err === 'object' ? (err as Record<string, unknown>) : null;
      if (errObj) {
        if (typeof errObj['code'] === 'string') wrapped.code = errObj['code'];
        if (typeof errObj['field'] === 'string') wrapped.field = errObj['field'];
        if (typeof errObj['size'] === 'number') wrapped.size = errObj['size'];
      }
      if (!wrapped.code) wrapped.code = 'IPC_REJECTED';
      throw wrapped;
    },
  );
}

// audit r52 (2026-10-15) C5:toast message 字符上限 —— 主进程一次塞 100MB
//   字符串让 renderer 撑爆是 DoS。集中到 `@shared/limits/ipc`:
//   MAX_TOAST_MESSAGE_CHARS 后,main + preload 共享单一来源(r52 之前在
//   main/ipc/path-limits,preload 跨进程 import main 间接,搬到 shared 直连)。
import { MAX_TOAST_MESSAGE_CHARS } from '@shared/limits/ipc';

// audit-r92:toast type 边界白名单由 @shared/types TOAST_EVENT_TYPES 单源 tuple
//   派生(对齐 STARTUP_PROGRESS 守卫的 Set 派生模式)。放模块作用域:每事件
//   重建 Set 是纯浪费(STARTUP 侧在 listener 体内构造,属同款小 perf 噪声,
//   此处不复制该写法)。
const ALLOWED_TOAST_TYPES = new Set<ToastPushPayload['type']>(TOAST_EVENT_TYPES);

// audit v2.0 Phase 0a:`const api: Api` 强制实现 contract,新增/删 method
//   时 TS 编译期报红。
// audit-r56:删 pickLibraryPath / pickImportRoot / libraryMigrationMove / Keep /
//   libraryMigrationGetState / onLibraryMigrationProgress / listLibrary /
//   rescanLibrary / changeLibraryPath / restoreDefaultLibraryPath / openFile /
//   importFiles / importPaths / onLibraryChanged / onLibraryScanProgress /
//   onLibraryScanDone / libraryScanProgressGetState —— library 整体下线。
//   留下的文献管理 surface 唯一一条:readFileForReader,入参从 string(id) 改成
//   string(absPath),与 src/main/library/reader.ts 同步。importNoteFromFile
//   返回类型由 ImportFilesResult 改成 NotesImportResult(语义同源但避免
//   让人误以为与 library 导入共用)。
const api: Api = {
  version: '0.1.0',
  platform: process.platform,

  // perf(2026-08-22):启动期一次性拉取 settings + workspace paths。
  // 替代启动期 useSettingsStore.load() + usePathsStore.load() 的两次串行 IPC,
  // 合并为单次 roundtrip,消除中间渲染态。
  // audit 2026-08-26 (round 16):cast 改成 IpcResult<BootstrapPayload> —— 之前
  // `as Promise<BootstrapPayload>` 是类型撒谎(wrap.ts 实际返回 { ok, data })。
  bootstrap: () => invokeGuard<BootstrapPayload>(IPC.APP_BOOTSTRAP),

  // 设置
  getSettings: () => invokeGuard<AppSettings>(IPC.SETTINGS_GET),
  updateSettings: (patch: Partial<AppSettings>) =>
    invokeGuard<AppSettings>(IPC.SETTINGS_UPDATE, patch),
  pickDataPath: () => invokeGuard<string | null>(IPC.SETTINGS_PICK_DATA_PATH),
  migrateData: (newPath: string) => invokeGuard<AppSettings>(IPC.SETTINGS_MIGRATE_DATA, newPath),
  // 恢复默认数据路径 —— 走 location.defaultDataPath()。返回最新 settings。
  restoreDefaultDataPath: () => invokeGuard<AppSettings>(IPC.SETTINGS_RESTORE_DEFAULT_DATA),

  // 文献管理 —— audit-r56 后唯一 surface
  // r191 更正:旧注释说「入参 absPath 由 renderer 从 <input type="file"> +
  // webUtils.getPathForFile() 派生」—— **已不成立**。OS 文件选择器只用于
  // **导入**(拷贝进工作区),不用于读;本通道的唯一生产调用点是
  // renderer/Reader.tsx 的 `api.readFileForReader(file.absPath)`,file 是
  // literature store 的一行 ⇒ absPath 恒在 <rootPath>/literature/ 内。
  // 主进程自 r191 起对这层入参加**工作区白名单**(区外 / symlink 逃逸 → EPERM),
  // 与 rkms:// 协议、shell.open-path 同款。
  // 主进程 src/main/library/reader.ts:readFileForReader 不再做 id 查表,
  // 直接按 path 读 bytes + size + mtime。
  readFileForReader: (absPath: string) =>
    invokeGuard<ReadFileForReaderResult>(IPC.LIBRARY_READER_FOR_FILE, absPath),

  // 文献操作面(audit-r71)—— resources 单表 list / 拷入式导入 / 删除。
  // v1 无 push 通道:import / delete 成功后 renderer(store/literature.ts)
  // 主动 listLiterature() 重拉。
  listLiterature: () => invokeGuard<LiteratureResource[]>(IPC.LITERATURE_LIST),
  importLiteratureFromFile: (sourceAbsPath: string) =>
    invokeGuard<LiteratureImportResult>(IPC.LITERATURE_IMPORT_FROM_FILE, sourceAbsPath),
  deleteLiterature: (id: string) => invokeGuard<null>(IPC.LITERATURE_DELETE, id),
  // audit-r136:literature push 订阅 —— LiteratureService.chokidar add/change/
  //   unlink → reload() → byId 重建 → emit('changed') → 主进程 broadcastToAllWindows
  //   (IPC.LITERATURE_CHANGED) → 这里 listener 转发到 renderer useLiteratureStore。
  //   镜像 onNotesChanged 形态(handler 无参,disposer 返 removeListener)。
  //   契约锁 subscription-disposer-contract.test.ts。
  onLiteratureChanged: (handler: () => void) => {
    const listener = () => handler();
    ipcRenderer.on(IPC.LITERATURE_CHANGED, listener);
    return () => ipcRenderer.removeListener(IPC.LITERATURE_CHANGED, listener);
  },
  // audit-r211:配对的 pull 通道 literatureGetState 整对下线 —— 它与
  //   listLiterature 同源同形(都是 svc.list()),而 renderer 从来没调用过它。
  //   「push 先于 listener 注册」的竞态由「先订阅再 load」覆盖。

  // 笔记
  // perf (2026-09-06):listNotes 返回精简版 summary,无 body。详见 shared/types
  //   StandaloneNoteSummary。body 走 NOTES_READ 按 id 按需拉。
  listNotes: () => invokeGuard<StandaloneNoteSummary[]>(IPC.NOTES_LIST),
  // audit 2026-09-21 audit-r24 — readNote 找不到 id 抛 NOT_FOUND,不再返 null。
  //   泛型与 shared/api-types.ts 的契约一致,去掉 `| null` 防止 renderer
  //   误走防御性 null 路径(实际不可能命中)。
  readNote: (id: string) => invokeGuard<StandaloneNote>(IPC.NOTES_READ, id),
  // audit 2026-10-08 (HIGH):expectedMtime 透传 —— 主进程比对当前 mtime 与
  // renderer 期望值,不一致抛 CONFLICT,防止外部修改被静默覆盖(详见
  // shared/api-types.ts 的 writeNote 注释)。无 expectedMtime 走 last-writer-wins。
  writeNote: (id: string, body: string, title?: string, expectedMtime?: number) =>
    invokeGuard<StandaloneNote>(IPC.NOTES_WRITE, id, body, title, expectedMtime),
  createNote: (filename: string) => invokeGuard<StandaloneNote>(IPC.NOTES_CREATE, filename),
  trashNote: (id: string) => invokeGuard<void>(IPC.NOTES_TRASH, id),
  // audit-r73 (2026-10-17) CRITICAL:此前只透传 newFilename,**丢掉了 id** ——
  //   主进程 handler requireStrings(id, newFilename) 两参都必传,于是运行时
  //   重命名笔记文件永远 VALIDATION 失败。契约锁 tests/unit/preload/
  //   invoke-arg-passthrough.test.ts(全 invoke 方法逐参透传行为级守卫)。
  renameNoteFile: (id: string, newFilename: string) =>
    invokeGuard<StandaloneNote>(IPC.NOTES_RENAME_FILE, id, newFilename),
  // 笔记「在文件管理器中显示」。方法名加 Note 前缀以区分 id 空间
  // (历史上曾与 library:show-in-folder 对称,library 通道 r56 已下线)。
  showNoteInFolder: (id: string) => invokeGuard<void>(IPC.NOTES_SHOW_IN_FOLDER, id),
  // 拖入导入:从 OS 拖入的 .md 文件 → 主进程解析 + createNote + writeNote。
  //   走 createNote/writeNote 会自动 emit NOTES_CHANGED,renderer 不需主动 reload。
  // audit-r56:返回类型由 ImportFilesResult 改为 NotesImportResult —— 形态
  //   相同(都是 copied / skipped / errors / warnings / createdIds),但语义上
  //   只服务笔记导入,避免与「library 导入」残留概念混淆。
  importNoteFromFile: (path: string) =>
    invokeGuard<NotesImportResult>(IPC.NOTES_IMPORT_FROM_FILE, path),
  // r161+ disk-folder:侧栏文件管理走真实磁盘目录,2 域 × 4 操作 = 8 wrapper
  //   (notes/literature 各管各的 kind 树,不走旧的 folders 域)
  notesListDirs: (kind: ResourceKind, parentRelPath: string | null) =>
    invokeGuard<DiskFolderNode[]>(IPC.NOTES_FOLDERS_LIST_DIRS, kind, parentRelPath),
  notesMkdir: (relPath: string) =>
    invokeGuard<{ relPath: string }>(IPC.NOTES_FOLDERS_MKDIR, relPath),
  notesRenameDir: (oldRelPath: string, newName: string) =>
    invokeGuard<FolderMoveResult>(IPC.NOTES_FOLDERS_RENAME_DIR, oldRelPath, newName),
  notesTrashDir: (relPath: string) =>
    invokeGuard<null>(IPC.NOTES_FOLDERS_TRASH_DIR, relPath),
  litListDirs: (kind: ResourceKind, parentRelPath: string | null) =>
    invokeGuard<DiskFolderNode[]>(IPC.LITERATURE_FOLDERS_LIST_DIRS, kind, parentRelPath),
  litMkdir: (relPath: string) =>
    invokeGuard<{ relPath: string }>(IPC.LITERATURE_FOLDERS_MKDIR, relPath),
  litRenameDir: (oldRelPath: string, newName: string) =>
    invokeGuard<FolderMoveResult>(IPC.LITERATURE_FOLDERS_RENAME_DIR, oldRelPath, newName),
  litTrashDir: (relPath: string) =>
    invokeGuard<null>(IPC.LITERATURE_FOLDERS_TRASH_DIR, relPath),
  // r161+ disk-folder Phase 2c:跨文件夹移动资源。targetRelPath null = 根
  //   ('' 段)。notes 返 { relPath, id },literature 返 { absPath, id }。
  notesMove: (id: string, targetRelPath: string | null) =>
    invokeGuard<{ relPath: string; id: string }>(IPC.NOTES_MOVE, id, targetRelPath ?? ''),
  litMove: (id: string, targetRelPath: string | null) =>
    invokeGuard<{ absPath: string; id: ResourceId }>(IPC.LITERATURE_MOVE, id, targetRelPath ?? ''),
  // r187:文献单文件重命名(与 notesRenameFile 对称)。lit id = 'lit:'+absPath
  //   ⇒ 改名后 id 变,返回新 id + 新旧 absPath 让 renderer 把选中态与
  //   收藏条目跟到新 id。
  litRenameFile: (id: string, newFilename: string) =>
    invokeGuard<LiteratureRenameResult>(
      IPC.LITERATURE_RENAME_FILE,
      id,
      newFilename,
    ),
  // audit-r173:目录(子树)跨父目录搬移。targetParentRelPath null = 根('' 段)。
  notesMoveDir: (oldRelPath: string, newParentRelPath: string | null) =>
    invokeGuard<FolderMoveResult>(
      IPC.NOTES_FOLDERS_MOVE_DIR,
      oldRelPath,
      newParentRelPath ?? '',
    ),
  litMoveDir: (oldRelPath: string, newParentRelPath: string | null) =>
    invokeGuard<FolderMoveResult>(
      IPC.LITERATURE_FOLDERS_MOVE_DIR,
      oldRelPath,
      newParentRelPath ?? '',
    ),
  // audit-r73:删 notesResyncProgressGetState —— NOTES_RESCYNC_PROGRESS(push)
  //   从未有任何 send 点、GET_STATE 从未有 renderer 调用方,整对下线。
  //   ghost 行清理自 audit-r124 起由 NotesService.resyncIfNeeded 就地完成。
  //   audit-r156:settings.notesResyncPending 字段同链路一并删除。

  // 收藏 — audit-r211:favoritesGetState 已整对下线(空壳 API),
  //   favorites 的 push 订阅见下方 onFavoritesChanged。

  // 搜索
  search: (query: string) => invokeGuard<SearchHit[]>(IPC.SEARCH_QUERY, query),

  // 收藏夹 — 读 list / 写 toggle 是仅剩的 2 个公开 API。
  // 重构 (2026-09 V1.4):createGroup / deleteGroup / addItemToGroup / removeItemFromGroup /
  //   setGroupDescription 全部删除 —— favorites 分组 read-only;V2.0 需要管理 UI 时再 wire。
  // audit-r56:LibraryList 退役。audit-r72:★ toggle 与「全部/仅收藏」chip 过滤
  //   现由 LiteratureList 承担(旧组件删除,r71/r72 重建时接线恢复)。Api 表面不动。

  // 事件订阅
  // audit-r56:删 onLibraryChanged / onLibraryScanProgress / onLibraryScanDone
  //   —— library 推送通道整体下线。ScanErrorSummary / ScanSummary type
  //   guard helper 也一并删除(无 consumer)。
  onNotesChanged: (handler: () => void) => {
    const listener = () => handler();
    ipcRenderer.on(IPC.NOTES_CHANGED, listener);
    return () => ipcRenderer.removeListener(IPC.NOTES_CHANGED, listener);
  },
  // audit 2026-09-14 r7:主进程 → renderer 推 toast 通道。payload 形态 =
  //   @shared/types ToastPushPayload(type 派生自单源 tuple,见下守卫)。
  //   renderer 端 useToast.show() 包装消费。
  // audit round 9 (2026-09-15):补 assertPayload 守卫 —— 其它 on* listener
  //   (MENU_INVOKE / STARTUP_PROGRESS / WINDOW_MAXIMIZE_CHANGED)
  //   都有 shape 校验,TOAST_PUSH 是唯一裸 `handler(payload as never)` 的 listener。
  //   现状 message 是 React text 渲染,XSS 走不通,但未来若有 consumer 走
  //   dangerouslySetInnerHTML,主进程一次 type 漏发 / duration=NaN 就会静默 RCE。
  //   与其它 listener 对齐守卫:type 在白名单 + message 是非空 string + duration 数字。
  // audit-r92 (2026-10-17):type 白名单改由 TOAST_EVENT_TYPES 派生 Set(CQ-002
  //   同款修法,对齐 STARTUP_PROGRESS 守卫)—— 原 `t !== 'info' && ...` 4 条件
  //   手抄是跨进程 5 份拷贝里唯一有运行时强制力的一份:ToastType 加成员时
  //   TS 不会碰它,新 type 事件在边界被静默丢弃(console.warn 不进 renderer UI)。
  onToastPush: (handler: (payload: ToastPushPayload) => void) => {
    const listener = (_: unknown, payload: unknown) => {
      const ok = assertPayload(
        IPC.TOAST_PUSH,
        payload,
        (p): p is ToastPushPayload => {
          if (typeof p !== 'object' || p === null) return false;
          const o = p as Record<string, unknown>;
          const t = o['type'];
          if (!ALLOWED_TOAST_TYPES.has(t as ToastPushPayload['type'])) return false;
          const m = o['message'];
          if (typeof m !== 'string' || m.length === 0 || m.length > MAX_TOAST_MESSAGE_CHARS) {
            return false;
          }
          const d = o['duration'];
          // audit round 14 (2026-09-15):CQ-006 — duration NaN / Infinity
          //   守卫。setTimeout(NaN) 永不触发,toast 永久不消失;Infinity
          //   等同极长 timeout(几亿年),setTimeout 内部 clamp 到 1ms,
          //   行为虽不崩但语义错。
          if (d !== undefined && (typeof d !== 'number' || !Number.isFinite(d))) return false;
          return true;
        },
      );
      if (ok !== null) handler(ok);
    };
    ipcRenderer.on(IPC.TOAST_PUSH, listener);
    return () => ipcRenderer.removeListener(IPC.TOAST_PUSH, listener);
  },

  // 独立收藏 — 重构 (2026-09 V1.4):group CRUD 5 个方法(createFavoriteGroup / delete
  //   / addItem / removeItem / setGroupDescription)删除 —— ★ toggle 与 chip
  //   过滤曾由 LibraryList 提供。
  // audit r54 (2026-10-16) I6:从 FavoritesEntry[] 收紧到 FavoritesFileEntry[],
  //   与 IPC handler filter 对齐(group 无 renderer consumer)。
  // audit-r56:LibraryList 退役。audit-r72:chip 过滤现由 LiteratureList 承担。
  listFavorites: () => invokeGuard<FavoritesFileEntry[]>(IPC.FAVORITES_LIST),
  toggleFavorite: (fileId: string, info?: { title?: string; relPath?: string }) =>
    invokeGuard<{ favorited: boolean; fileId: string }>(IPC.FAVORITES_TOGGLE, fileId, info),

  onFavoritesChanged: (handler: () => void) => {
    const listener = () => handler();
    ipcRenderer.on(IPC.FAVORITES_CHANGED, listener);
    return () => ipcRenderer.removeListener(IPC.FAVORITES_CHANGED, listener);
  },

  // 通用 shell + 模块数据路径
  // 路径校验由主进程负责(白名单 + fs.access),渲染层不能传任意路径
  openPath: (p: string) => invokeGuard<{ opened: string }>(IPC.SHELL_OPEN_PATH, p),
  // fix drag-drop (2026-10-13):从拖入 / DnD 事件里的 File 派生 OS 绝对路径。
  //   背景:旧 LibraryList / NotesList 走 `f.path`(Electron 在 File 对象上的
  //   非标准扩展)。Electron 30 已 deprecate,Electron 32 彻底移除 —— 升级时
  //   拖入会静默变成 `paths.length===0`,UI 显示"拖入内容不含可识别路径"
  //   toast,用户无法判断是 bug 还是没选文件。
  //   webUtils.getPathForFile 是 Electron 30+ 官方推荐路径(沙箱兼容、renderer
  //   侧模块),接受 File 实例返回 OS 绝对路径,folder drop 也走同一接口
  //   (folder 的 File.size=0 但 entry.fullPath = folder 绝对路径)。
  //   兜底:不是所有 File 都有 OS 路径(blob: URL / 剪贴板虚拟文件 / webkitGetAsEntry
  //   路径),返回 null 让 renderer 走 f.path 旧路径 —— 渐进降级不破坏老 Electron。
  //   try/catch 防御 webUtils 内部抛(实测极少,但 File 是 `new DataTransfer()` 的
  //   虚拟条目时偶发)。
  getPathForFile: (file: File): string | null => {
    try {
      // webUtils 是 renderer-side 模块,只在 preload 注入,不走 wire 协议。
      return webUtils.getPathForFile(file);
    } catch {
      return null;
    }
  },
  // audit 2026-08-26 (round 16):cast 改成 IpcResult<WorkspacePaths> —— 之前
  // `as Promise<WorkspacePaths>` 是类型撒谎。
  getWorkspacePaths: () => invokeGuard<WorkspacePaths>(IPC.WORKSPACE_GET_PATHS),

  // Phase 5: 应用菜单点击桥
  // 主进程 send(IPC.MENU_INVOKE, { id }) → 这里转发到渲染层
  // App.tsx 订阅 → dispatcher.invoke(id) → 走统一调度入口
  // i18n (2026-09):renderer 切语言后调 rebuildMenu,主进程按当前 settings.language
  //   重建菜单 + 更新窗口 title(都不归 react-i18next 管)。
  rebuildMenu: () => invokeGuard<void>(IPC.MENU_REBUILD),
  onMenuInvoke: (handler: (data: { id: string }) => void) => {
    const listener = (_: unknown, data: unknown) => {
      // audit 2026-09-10:{id: string} 守卫 —— id 缺失 / 非 string 会让
      //   dispatcher.invoke 抛 "id is not a string" 同步错,菜单响应静默死掉。
      const ok = assertPayload(
        IPC.MENU_INVOKE,
        data,
        (p): p is { id: string } =>
          typeof p === 'object' && p !== null && typeof (p as { id?: unknown }).id === 'string',
      );
      if (ok !== null) handler(ok);
    };
    ipcRenderer.on(IPC.MENU_INVOKE, listener);
    return () => ipcRenderer.removeListener(IPC.MENU_INVOKE, listener);
  },

  // 启动期进度 — invoke 拉快照(兜底"主进程 push 已先于 renderer listener"竞态)
  // + 订阅增量事件。contextBridge 边界把 listener 参数擦除到 unknown,
  // 这里显式 cast / shape-guard 到 discriminated union 类型。
  getStartupState: () => invokeGuard<StartupProgressSnapshot>(IPC.STARTUP_GET_STATE),
  onStartupProgress: (handler: (event: StartupProgressEvent) => void) => {
    const listener = (_: unknown, event: unknown) => {
      // audit 2026-09-10:StartupProgressEvent discriminated union 守卫 ——
      //   这是 listener 里 shape 最复杂的(type + 多字段),漏 type 字段
      //   会让 useStartupStore.applyEvent 走到 default 分支直接吞事件,UI
      //   卡在"启动中" 永远不结束。守卫要满足"对象 + type 是字面量之一"。
      // audit round 15 (2026-09-15):CQ-002 — 之前守卫手抄 4 个字面量,与
      //   StartupProgressEvent union 漂移(union 实际有 phase-start /
      //   progress / phase-done / all-done 四个,守卫误写为 phase-start /
      //   phase-done / error / log —— 后两个早已不在 union 中,前两个
      //   progress + all-done 会被守卫拒掉)。改用 Set<StartupProgressEventType>
      //   派生自动同步 union 增减。
      // audit-r56:删 'progress' 事件 —— library phase 用它报扫描计数,library
      //   下线后没有 phase 需要 progress 增量事件。STARTUP_PROGRESS_EVENT_TYPES
      //   缩到 phase-start / phase-done / all-done。
      const ALLOWED_STARTUP_EVENT_TYPES = new Set<StartupProgressEventType>(
        STARTUP_PROGRESS_EVENT_TYPES,
      );
      const ok = assertPayload(
        IPC.STARTUP_PROGRESS,
        event,
        (p): p is StartupProgressEvent =>
          typeof p === 'object' &&
          p !== null &&
          typeof (p as { type?: unknown }).type === 'string' &&
          ALLOWED_STARTUP_EVENT_TYPES.has((p as { type: string }).type as StartupProgressEventType),
      );
      if (ok !== null) handler(ok);
    };
    ipcRenderer.on(IPC.STARTUP_PROGRESS, listener);
    return () => ipcRenderer.removeListener(IPC.STARTUP_PROGRESS, listener);
  },

  // 自定义无边框窗口控制 (2026-09):渲染层 TitleBar 调这些去操作原生窗口。
  // Mac 上 TitleBar 不渲染这三个按钮(系统红绿灯接管),但 API 仍可用(供菜单或
  // 快捷键调 minimize/close 等场景)。
  windowMinimize: () => invokeGuard<void>(IPC.WINDOW_MINIMIZE),
  windowMaximizeToggle: () => invokeGuard<void>(IPC.WINDOW_MAXIMIZE_TOGGLE),
  windowClose: () => invokeGuard<void>(IPC.WINDOW_CLOSE),
  windowIsMaximized: () => invokeGuard<boolean>(IPC.WINDOW_IS_MAXIMIZED),
  onWindowMaximizeChanged: (handler: (maximized: boolean) => void) => {
    const listener = (_: unknown, payload: unknown) => {
      // audit 2026-09-10:boolean 守卫 —— 与 SCAN_PROGRESS 同款,非 boolean
      //   时 TitleBar 最大化图标状态卡在"普通" 不再切换。
      const ok = assertPayload(
        IPC.WINDOW_MAXIMIZE_CHANGED,
        payload,
        (p): p is boolean => typeof p === 'boolean',
      );
      if (ok !== null) handler(ok);
    };
    ipcRenderer.on(IPC.WINDOW_MAXIMIZE_CHANGED, listener);
    return () => ipcRenderer.removeListener(IPC.WINDOW_MAXIMIZE_CHANGED, listener);
  },

  // ===== Pull-snapshot (r54 I4) =====
  //
  // 每个 GET_STATE 对应一个 push channel —— push 在 renderer 启动期 / 重新
  // mount 时容易错过(主进程 send 时 renderer listener 还没注册),GET_STATE
  // 让 renderer 主动拉一次当前状态作为 baseline,返回值与对应 push 同形。
  // audit-r56:删 libraryMigrationGetState / libraryScanProgressGetState ——
  //   library 通道下线,这两个 GET_STATE 也无消费方。
  // audit-r73:删 notesResyncProgressGetState(整对无发送点/无调用方)。
  // audit-r211:删 favoritesGetState / literatureGetState —— 两条都是**空壳**:
  //   renderer 全域零调用点,且各自与同域的 LIST 通道同源同形。竞态由
  //   「先订阅再 load」覆盖,不需要额外一次 pull。**退役通道不得复活** ——
  //   守卫:tests/unit/main/ipc/pull-snapshot-companion.test.ts
  //
  // 现存 pull-snapshot 配对只有一条(启动进度):
  //   STARTUP_PROGRESS → STARTUP_GET_STATE(见上方 getStartupState)
};

contextBridge.exposeInMainWorld('api', api);

// audit v2.0 Phase 0a:旧 `export type Api = typeof api` 删除 ——
//   Api type 现在从 ../shared/api-types import。`typeof api` 在 generic
//   invokeGuard<T> 上会被泛到 unknown,不精确。
