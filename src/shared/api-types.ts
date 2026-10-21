// src/shared/api-types.ts
//
// audit v2.0 Phase 0a (2026-09-17):Api interface 单一真相源。
//
// 之前 src/renderer/src/lib/api.ts:62-152 手抄的 ~90 行 interface 是 drift 源
// (preload 加方法 renderer 不会同步)。preload 用 `typeof api` 推导的 type 在
// generic invokeGuard<T> 上会泛到 unknown,所以不能直接 import preload 的 type。
//
// 本文件:手写 contract。preload 用 `const api: Api = {...}` 强制实现,加声明处
//   字段时编译期会因 assignability 失败报红。renderer / tests / 任何 IPC 调用方
//   都从这里 import。
//
// 设计选择:为什么 hand-written 而不是 codegen?
//   - ~30 个 method,手工维护成本可接受(每改一个 method 都要双改)
//   - codegen 要么依赖 build step(ts-json-schema-generator 要跑 prebuild),
//     要么用 cli 写 post-check 脚本 — 增加构建复杂度
//   - 本项目 API 表面稳定,新增频率低(几个月一次),hand-written + contract
//     enforce 比 codegen 简单且更直白
//
// @shared/types 不依赖本文件(单向依赖,shared/types 是叶子)。
// audit-r56:删 LibraryFile / LibraryMigrationStatus / LibraryMigrationProgress /
//   ScanSummary / ImportFilesResult 类型引用 + 对应 listLibrary / rescanLibrary /
//   changeLibraryPath / restoreDefaultLibraryPath / openFile / importFiles /
//   importPaths / libraryMigrationMove / Keep / onLibraryMigrationProgress /
//   libraryMigrationGetState / pickLibraryPath / pickImportRoot /
//   onLibraryChanged / onLibraryScanProgress / onLibraryScanDone /
//   libraryScanProgressGetState method。剩下 1 个 library 通道 readFileForReader,
//   但入参类型从 string(id) 改成 string(absPath) —— 文献管理回归「按 path 读
//   bytes」。
import type {
  AppSettings,
  BootstrapPayload,
  DiskFolderNode,
  FolderMoveResult,
  FavoritesFileEntry,
  IpcResult,
  LiteratureResource,
  ReadFileForReaderResult,
  ResourceId,
  ResourceKind,
  SearchHit,
  StandaloneNote,
  StandaloneNoteSummary,
  StartupProgressEvent,
  StartupProgressSnapshot,
  ToastPushPayload,
  WorkspacePaths,
} from './types';

export interface Api {
  version: string;
  platform: string;

  // perf(2026-08-22):启动期一次性拉取 settings + workspace paths
  bootstrap(): Promise<IpcResult<BootstrapPayload>>;
  getSettings(): Promise<IpcResult<AppSettings>>;
  updateSettings(patch: Partial<AppSettings>): Promise<IpcResult<AppSettings>>;
  // audit-r56:删 pickLibraryPath / pickImportRoot —— 库路径与受信任导入根
  //   都不再存在。剩下的 pickDataPath 是 notes 选数据根目录用,保留。
  pickDataPath(): Promise<IpcResult<string | null>>;
  migrateData(newPath: string): Promise<IpcResult<AppSettings>>;
  // 恢复默认数据路径 —— 走 location.defaultDataPath()。返回最新 settings。
  restoreDefaultDataPath(): Promise<IpcResult<AppSettings>>;
  // audit-r56:删 libraryMigrationMove / Keep / onLibraryMigrationProgress /
  //   libraryMigrationGetState —— 库归位整套通道下线。

  // audit-r56:删 listLibrary / rescanLibrary / changeLibraryPath /
  //   restoreDefaultLibraryPath / openFile / importFiles / importPaths。
  // 唯一保留的文献管理 surface 是 readFileForReader —— 入参从 string(id) 改成
  // string(absPath),语义从「按 id 在 LibraryService 里查 absPath → 读 bytes」
  // 变成「按绝对路径直接读 bytes」。Id 概念随扫描整体退役。
  readFileForReader(absPath: string): Promise<IpcResult<ReadFileForReaderResult>>;

  // audit-r71:文献功能重建 —— resources 单表上的操作面(domain `literature:`,
  // 与退役的 library:* 区隔)。list 返回全量 lit 行(含 0005 迁移的旧行,其
  // absPath 可能指向已被移走的旧库文件 —— 打开时由 Reader 的 NOT_FOUND 态兜)。
  // import 拷贝文件进 <rootPath>/literature/ 并 upsert lit 行;delete 删行,
  // 仅当文件位于 literature 目录内才物理 unlink。
  // audit-r136:加 push 通道 LITERATURE_CHANGED(主进程 → renderer 推)——
  //   LiteratureService 启动 chokidar
  //   监听 <rootPath>/literature/,reload 内 disk↔DB diff(upsert disk-only
  //   + 删 ghost 行),emit('changed') 由主进程 IPC 桥广播到 renderer。
  //   renderer useLiteratureStore._ensureInit 订阅 + 200ms self-write 抑制
  //   窗口(同 notes NOTES_CHANGED 模式),自动 load({ force: true }) 拉新
  //   列表。
  // audit-r211:配对的 pull 通道 LITERATURE_GET_STATE 整对下线(空壳:与
  //   listLiterature 同源同形且 renderer 零调用)⇒ 「push 先于 listener 注册」
  //   的竞态由「先订阅再 load」覆盖。契约由 tests/unit/main/ipc/
  //   pull-snapshot-companion.test.ts 锁住。
  listLiterature(): Promise<IpcResult<LiteratureResource[]>>;
  importLiteratureFromFile(
    sourceAbsPath: string,
  ): Promise<IpcResult<LiteratureImportResult>>;
  deleteLiterature(id: string): Promise<IpcResult<null>>;
  /** Push 订阅:主进程 chokidar / 写操作触发 reload 后 emit changed → 这里广播 */
  onLiteratureChanged(handler: () => void): () => void;
  // audit-r211:配对的 pull 通道 literatureGetState 整对下线 —— 它与
  //   listLiterature 同源同形(都是 svc.list()),而 renderer 从来没调用过它
  //   (src/renderer/ 全域零调用点)。「push 先于 listener 注册」的竞态由
  //   「先订阅再 load」覆盖(store 模块顶层 _ensureInit 订阅 → 组件
  //   useEffect 里首次 load),不需要额外一次 pull。

  listNotes(): Promise<IpcResult<StandaloneNoteSummary[]>>;
  // audit 2026-09-21 audit-r24 — 找不到 id 时主进程抛 NOT_FOUND(与 getFile /
  //   trashNote / showNoteInFolder 同款契约),成功 data 永远是 StandaloneNote。
  //   移除 `| null` 收紧类型:调用方不再需要防御性检查 null,异常路径统一走
  //   unwrap() 抛 IpcError → catch(toast + log)。
  readNote(id: string): Promise<IpcResult<StandaloneNote>>;
  // audit 2026-10-08 (HIGH):writeNote 接受可选 expectedMtime —— 防止外部修改
  //   (OneDrive/iCloud sync、Vim 等)被静默覆盖。renderer 在 loadFullNote
  //   时记下 activeNoteFull.mtime,save 时回传,主进程比对当前文件 mtime
  //   与 expectedMtime,不一致抛 CONFLICT 让 renderer 走冲突处理路径
  //   (toast + 拒绝保存)。无 expectedMtime 时保持 last-writer-wins(向后兼容)。
  writeNote(
    id: string,
    body: string,
    title?: string,
    expectedMtime?: number,
  ): Promise<IpcResult<StandaloneNote>>;
  createNote(filename: string): Promise<IpcResult<StandaloneNote>>;
  // 2026-10-16 file-manager ops:deleteNote → trashNote —— 删除走系统回收站
  //   (shell.trashItem),可从系统回收站恢复;失败语义不变(IO_ERROR 透传)。
  trashNote(id: string): Promise<IpcResult<void>>;
  renameNoteFile(id: string, newFilename: string): Promise<IpcResult<StandaloneNote>>;
  showNoteInFolder(id: string): Promise<IpcResult<void>>;
  // 拖入导入(2026-09-14):从 OS 拖入的 .md 文件 → 主进程解析 frontmatter + body
  // → 走 createNote + writeNote 创建新笔记。NOTES_CHANGED 推送自动触发 reload。
  // audit-r56:importNoteFromFile 返回类型 —— LibraryImportResult 是 LibraryFile[]
  // 形态的扩展,library 退役后改用 notes 专属的 NotesImportResult(结构与原
  // ImportFilesResult 相同,但语义上只服务笔记导入,不需要兼容 library)。
  // 详见 main/notes/service.ts 与 preload。
  importNoteFromFile(path: string): Promise<IpcResult<NotesImportResult>>;

  // r161+ disk-folder:侧栏 VS Code 式文件管理走真实磁盘目录,2 域 × 4 操作 = 8
  //   wrapper;「移入文件夹」= 真实 fs.rename 跨目录,不是 DB 列更新
  notesListDirs(
    kind: ResourceKind,
    parentRelPath: string | null,
  ): Promise<IpcResult<DiskFolderNode[]>>;
  notesMkdir(relPath: string): Promise<IpcResult<{ relPath: string }>>;
  // audit-r175:重命名文件夹返回 FolderMoveResult(与 moveDir 同形态)——
  //   目录改名后子树里每个资源的 id 都变(notes id 随 relPath、
  //   lit id 随 absPath),renderer 必须拿 idRemap 把选中态跟到新 id。
  //   旧契约只返 { relPath },id 变化对 renderer 完全不可见 ⇒ 选中态
  //   永远钉在死 id 上,后续任何操作 NOT_FOUND。
  notesRenameDir(
    oldRelPath: string,
    newName: string,
  ): Promise<IpcResult<FolderMoveResult>>;
  notesTrashDir(relPath: string): Promise<IpcResult<null>>;
  litListDirs(
    kind: ResourceKind,
    parentRelPath: string | null,
  ): Promise<IpcResult<DiskFolderNode[]>>;
  litMkdir(relPath: string): Promise<IpcResult<{ relPath: string }>>;
  litRenameDir(
    oldRelPath: string,
    newName: string,
  ): Promise<IpcResult<FolderMoveResult>>;
  litTrashDir(relPath: string): Promise<IpcResult<null>>;

  // r161+ disk-folder Phase 2c:跨文件夹移动资源(走真实 fs.rename + DB tx,
  //   lit id 因 absPath 变而变,notes id 因 relPath 变而变)。targetRelPath
  //   null = 根(对应 '' 段);notes 返 { relPath, id },literature 返
  //   { absPath, id }(lit 域没 relPath 概念,IPC 返 absPath 让 renderer
  //   重新索引)。
  // audit-r170:literature 侧返回的 id 收紧成 ResourceId —— 主进程
  //   svc.moveFile 返的就是 LiteratureResource.id(brand 类型),旧契约写
  //   `id: string` 让 renderer 侧必须靠 cast 才能把它喂给
  //   store.select(id: ResourceId)(LiteratureList 导入后搬移路径就撞这个)。
  //   brand 类型在 assignability 上是单向的(string 不能赋给 ResourceId),
  //   所以三层(preload / shared 契约 / 主进程 handler)必须同时改,否则
  //   `const api: Api = {...}` 会报红。
  //   notes 侧保持 `id: string` —— notes 的 id 来自 frontmatter
  //   (StandaloneNote.id 就是裸 string,没有 brand),不硬套。
  notesMove(
    id: string,
    targetRelPath: string | null,
  ): Promise<IpcResult<{ relPath: string; id: string }>>;
  litMove(
    id: string,
    targetRelPath: string | null,
  ): Promise<IpcResult<{ absPath: string; id: ResourceId }>>;

  // r187:文献单文件重命名(与 notesRenameFile 对称)—— 只改文件名,保留
  //   所在目录。newFilename 是**完整文件名**(含扩展名;缺扩展名时主进程
  //   按原扩展名补齐)。返回新 id / 新旧 absPath(lit id 随路径变)。
  litRenameFile(
    id: string,
    newFilename: string,
  ): Promise<IpcResult<LiteratureRenameResult>>;

  // audit-r173:目录(子树)跨父目录搬移 —— 剪切文件夹 → 粘贴到另一个目录 /
  //   把文件夹拖到另一个目录 / 「移到根目录」。
  //   oldRelPath = 被搬目录(相对 kind 根);newParentRelPath = 目标父目录
  //   (null = 根)。返回 { relPath(新目录), idRemap(目录内每个资源的
  //   oldId → newId) } —— 搬目录 = 搬里面每一个资源,id 全变,renderer
  //   必须拿 remap 把选中态跟过去。
  notesMoveDir(
    oldRelPath: string,
    newParentRelPath: string | null,
  ): Promise<IpcResult<FolderMoveResult>>;
  litMoveDir(
    oldRelPath: string,
    newParentRelPath: string | null,
  ): Promise<IpcResult<FolderMoveResult>>;

  // audit-r73:删 notesResyncProgressGetState() —— NOTES_RESCYNC_PROGRESS
  //   (push)全项目无 send 点、GET_STATE 无 renderer 调用方,整对下线。
  //   ghost 行清理自 audit-r124 起由 NotesService.resyncIfNeeded 就地完成。
  //   audit-r156:settings.notesResyncPending 字段同链路一并删除。

  search(query: string): Promise<IpcResult<SearchHit[]>>;

  // 重构 (2026-09 V1.4):collections 模块已删除 —— listFavorites 返回的
  // FavoritesFileEntry[] —— audit r54 (2026-10-16) I6 收紧到 file-only。
  // group 是 read-only 显示用 metadata,无 IPC consumer。renderer 端
  // favoritedFileIds Set 直接由 entries (file kind) 推导。
  // 重构 (2026-09 V1.4):group CRUD 5 个方法(createFavoriteGroup / delete / addItem
  //   / removeItem / setGroupDescription)全部删除 —— favorites 分组现为只读,
  //   ★ toggle 与 chip 过滤由 LibraryList 提供。
  // audit-r56:LibraryList 退役 —— favorites toggle 仍可用(IPC 通道在),但 chip
  //   过滤从 LibraryList 改到 NotesList。Api 表面 favorites 这块不动。
  listFavorites(): Promise<IpcResult<FavoritesFileEntry[]>>;
  // audit r54 (2026-10-16) I4:Pull-snapshot —— FAVORITES_CHANGED push 在 renderer
  //   mount 时若 listener 还没注册就错过,原设计由 GET_STATE 主动 invoke 拉一份
  //   当前 FavoritesFileEntry[] 填补 race。
  // audit-r211:该 GET_STATE 整对下线 —— 实测 renderer 全域**零调用点**,且它
  //   与 listFavorites 同源同形(纯重复)。race 的真实修法是 useSyncStores 的
  //   「先订阅 onFavoritesChanged,再 load()」(2026-09-10)—— 订阅严格早于
  //   首次拉取,不存在漏事件窗口。
  toggleFavorite(
    fileId: string,
    info?: { title?: string; relPath?: string },
  ): Promise<IpcResult<{ favorited: boolean; fileId: string }>>;

  // 通用 shell + 模块数据路径
  openPath(p: string): Promise<IpcResult<{ opened: string }>>;
  getWorkspacePaths(): Promise<IpcResult<WorkspacePaths>>;
  // fix drag-drop (2026-10-13):从拖入 / DnD 事件里的 File 派生 OS 绝对路径。
  //   - Electron 30+ 通过 preload 注入 `webUtils.getPathForFile(file)`,沙箱兼容
  //   - 老 Electron(<28) 没 webUtils:preload 走 try/catch 返回 null,renderer
  //     fallback 到 `File.path`(Electron < 32 自带的非标准扩展)。
  //   - 不是所有 File 都有 OS 路径(blob: URL / 剪贴板虚拟文件 / 内部 drag),
  //   返回 null 表示「取不到」让 renderer 跳过此 file。
  getPathForFile(file: File): string | null;

  // audit-r56:删 onLibraryChanged / onLibraryScanProgress / onLibraryScanDone /
  //   libraryScanProgressGetState —— library 推送通道整体下线。
  onNotesChanged(handler: () => void): () => void;
  onFavoritesChanged(handler: () => void): () => void;
  // audit 2026-09-14 r7:主进程 → renderer 推 toast 通道(迁移警告 / watcher 失败 /
  //   reload 失败等场景)。
  // audit-r92:payload 收敛到 @shared/types ToastPushPayload(单源 tuple 派生),
  //   原内联 4 元组是 5 处手抄之一,与 preload 运行时白名单之间无质料联动。
  onToastPush(handler: (payload: ToastPushPayload) => void): () => void;
  /** Phase 5: 主进程菜单项点击 → renderer 端 CommandDispatcher 单点调度 */
  onMenuInvoke(handler: (data: { id: string }) => void): () => void;
  /**
   * i18n (2026-09):renderer 切语言后调一次,主进程按当前 settings.language
   * 重建应用菜单 + 更新 BrowserWindow title(都不归 react-i18next 管)。
   * 主进程内部从 settings 取 lang,无需参数。
   */
  rebuildMenu(): Promise<IpcResult<void>>;
  /** 启动期进度:invoke 拉快照(兜底"主进程 push 已先于 renderer listener"竞态) */
  getStartupState(): Promise<IpcResult<StartupProgressSnapshot>>;
  /** 启动期进度:订阅增量 phase-start / progress / phase-done / all-done 事件。
   * audit-r56:progress 事件类型删除 —— 唯一 phase (library) 用它,library 下线
   * 后没有 phase 需要 progress 增量事件。handler 收到的事件类型
   * StartupProgressEvent 收紧到 phase-start / phase-done / all-done 三型。*/
  onStartupProgress(handler: (event: StartupProgressEvent) => void): () => void;
  /** 自定义无边框窗口控制 (2026-09):最小化 / 最大化切换 / 关闭 */
  windowMinimize(): Promise<IpcResult<void>>;
  windowMaximizeToggle(): Promise<IpcResult<void>>;
  windowClose(): Promise<IpcResult<void>>;
  /** 启动时拉初始 maximized 状态,避免"主进程 push 先于 renderer listener"竞态 */
  windowIsMaximized(): Promise<IpcResult<boolean>>;
  /** 订阅系统级 maximize / unmaximize 事件,TitleBar 据此切换"最大化 / 还原"图标 */
  onWindowMaximizeChanged(handler: (maximized: boolean) => void): () => void;
}

/**
 * 笔记单文件导入结果 —— audit-r56 把 library 退役后,`ImportFilesResult`
 * 这个名字其实指的是 notes 导入专用形态(原本设计是「library 复制 + notes
 * 导入共用」)。为避免与「library 导入」混淆,这里只给 notes 用,类型细节
 * 与原 ImportFilesResult 保持一致:
 *   - copied:   成功导入/创建数
 *   - skipped:  源不是合法 .md 文件被静默跳过的条数
 *   - errors:   解析/写入抛错的具体条目(source = 原路径,reason = errMsg)
 *   - warnings: frontmatter 解析失败等软警告
 *   - createdIds: 成功创建的笔记 id 列表(供 renderer select / focus / scroll)
 */
export interface NotesImportResult {
  copied: number;
  skipped: number;
  errors: { source: string; reason: string }[];
  warnings?: string[];
  createdIds?: string[];
  // audit-r175:导入笔记的 relPath(notes 根下,导入不带目录语义)。
  //   与 createdIds 一一对应 —— 主进程用它把导入的笔记登记进 byId +
  //   resources 表(旧实现导入完全绕开 NotesService,导入的笔记在本次
  //   会话内永远不进 byId,renderer 紧接着的「移入当前文件夹」必 NOT_FOUND,
  //   且没有 resources 行 → 全局搜索永远搜不到)。
  createdRelPaths?: string[];
}

/**
 * 文献导入结果(audit-r71)—— 拷贝进 <rootPath>/literature/ 后的 lit 行定位信息。
 *   - id:      brand ResourceId('lit:'+absPath 的 POSIX 化形态),直接可用于 select
 *   - absPath: 拷贝落点的 OS 绝对路径(原样分隔符;fs 调用只认它,不认 id)
 *   - filename: 落点文件名(撞名自动改名后可能与源不同)
 *   - size/mtime: 落点文件的 stat 值(与写入 lit 行的值同源)
 *   - renamed:  是否发生了撞名改名(renderer toast 可提示实际入库文件名)
 */
export interface LiteratureImportResult {
  id: ResourceId;
  absPath: string;
  filename: string;
  size: number;
  mtime: number;
  renamed: boolean;
}

/**
 * r187:文献重命名结果 —— fs.rename 落定后的定位信息。
 *   - absPath:   新绝对路径(改完名的新文件)
 *   - oldAbsPath:改名前的绝对路径(收藏条目按路径登记,需要它做 id 重映射)
 *   - id:        新 id('lit:'+posix 新 absPath);旧 id 已失效
 */
export interface LiteratureRenameResult {
  id: ResourceId;
  absPath: string;
  oldAbsPath: string;
}
