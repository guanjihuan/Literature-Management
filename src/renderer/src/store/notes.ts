// 独立笔记状态 - 订阅主进程 NOTES_CHANGED 推送
//
// perf (2026-09-06):列表走精简版 StandaloneNoteSummary ——
//   body 通过 NOTES_READ 按 id 懒加载并缓存在 activeNoteFull。
//   这样:
//   - 5000 笔记 × ~5KB body 的全表 clone 缩减到 ~200B/条 × 5000 ≈ 1MB
//     (原来 ~25MB),autosave 路径上 listNotes IPC 带宽 -95%
//   - StatusBar 字数统计独立读 activeNoteFull.body,NotesList autosave 推送
//     不再让 StatusBar 重渲(因为 summary.mtime 不变 / body 没在 summary)
//   - NotesView / StandaloneNoteEditorCore 需要 body,均由 activeNoteFull 提供
//
// 数据流:
//   useNotesStore.notes (StandaloneNoteSummary[])  ←─ listNotes / NOTES_CHANGED
//   useNotesStore.activeNoteFull (StandaloneNote | null) ←─ readNote(id) on demand
//   useNotesStore.selectedId (string | null)  ←─ user clicks row
import { create } from 'zustand';
import i18next from 'i18next';
// audit-r56:ImportFilesResult(library 时代)→ NotesImportResult —— 结构同源,
//   语义专门为 notes 导入,定义在 api-types.ts。
import type { StandaloneNote, StandaloneNoteSummary } from '@shared/types';
import type { NotesImportResult } from '@shared/api-types';
import { toNoteSummary } from '@shared/types';
import { stripExt } from '@shared/path-utils';
// 0007:resources 表 id = 'note:'+uuid,本 store 的 note id 是裸 uuid ——
//   moveResources 调用点必须统一加前缀(漏前缀 = moved=0 静默落空)。
// r161+ disk-folder:moveResources / noteResourceId 调用点整体下线
//   (虚拟文件夹已下线),此处 import 删
// import { noteResourceId } from '@shared/resource-id';
import { api, unwrap, IpcError } from '../lib/api';
import { createLogger } from '../lib/logger-client';
import { useToast } from '../lib/toast';
import { errMsg } from '../lib/error';
import { useWorkspaceStore } from './workspace';
// audit 2026-10-08 (MEDIUM):delete / rename 清理 failedDrafts —— 旧实现
//   不通知 StandaloneNoteEditorCore 模块,id 变化 / id 消失时旧草稿成死条目
//   (典型:用户重命名 100 次,旧 id 草稿 100 条全留内存)。失败草稿由
//   store/failed-drafts.ts 持有(2026-10-08 r35 抽出,避免与组件循环依赖),
//   clearFailedDraft(id) 单点清理。详见 failed-drafts.ts 头注。
import { clearFailedDraft } from './failed-drafts';
// audit-r143 (2026-10-19):侧栏自定义排序 —— displayOrderById 是 UI 偏好,
//   持久化到 localStorage(同 useResizablePanel workbench 宽度的位置)。
//   不污染 SQLite schema / IPC / 资源类型。
import { loadOrder, saveOrder, type DisplayOrderMap } from '../lib/order-persistence';
// audit-r170:副本文件名生成器(圆括号合法 + 只取源文件名不带目录前缀)。
import { nextNoteCopyFilename } from '../utils/note-copy-name';
// audit-r170:目标目录归属判据(dirname(relPath) === currentRelPath)——
//   撞名避让只扫目标目录内的文件,不扫全库。
import { dirnameOfRelPath } from '../lib/folder-view';
import { consumeMovedFromClipboard } from './_clipboard-consume';
import { shareUnchanged } from '../lib/struct-share';
import { remapSelectedIds } from '../lib/move-remap';
import { registerIdRemap } from '../lib/note-id-remap';

const log = createLogger('useNotesStore');

// loadFullNote 的 in-flight token —— 每次进入 +1,resolve 时若 token 已变
// 说明"用户在这期间又选了别的笔记",丢弃这个 stale 结果,避免旧 note body
// 覆盖新的 activeNoteFull。autosave 期间点选很快的场景会被这个守卫救下。
let _loadFullNoteToken = 0;

// audit 2026-10-09 (MEDIUM):每条笔记「最近一次成功写入的 mtime」。save() 写
// 成功后写入;loadFullNote() 落盘读回时,若读到的 mtime 比这里记录的更旧,
// 说明这次 readNote 在写之前开始、写完成后才返回(stale read),丢弃它的结果,
// 保留 save 的乐观新值,避免把旧 body 覆盖回去诱发下次 autosave 的伪 CONFLICT。
const _writtenMtimeById = new Map<string, number>();
// audit-r76 (2026-10-17):上面那句「mtime 更旧 ⇒ stale read」只在**读发出于写
// 落地之前**时成立。若读是在写落地之后才发出的(如 CONFLICT 后的权威重拉),
// 读到更旧 mtime 意味着磁盘被外部真实回滚(网盘保留原始 mtime 的降级同步、
// 备份还原、Windows 以前的版本),不是 stale read。旧守卫不分这两种情形一律
// 丢弃 →  invalidated 永远清不掉 → 每次选中重拉又重丢 → 编辑器永远停在内存
// 旧版,且之后每次 autosave 的 expectedMtime 与磁盘不符 → 永久 CONFLICT 循环
// (实证复现:r76 repro,visit N 次全部 discard)。所以还需要「写落地的墙钟
// 时刻」来区分:读发出时刻 ≤ 写落地时刻 → 真 stale(或同毫秒歧义,保守),丢;
// 否则磁盘权威,收。同毫秒 tie 必须按 stale 丢 —— Date.now() 毫秒精度下
// 「读发出、写落地」落在同一 ms 是常态(r56 race 实证),tie 按权威收会让
// 旧 body 覆盖 save 的乐观新值,保护失效;外部回滚的重拉距上次成功写必然
// 跨毫秒,不受 tie 影响(即便极端同毫秒也只是多丢一轮,invalidated 未清,
// 下次选中再拉即自愈)。
const _writtenAtById = new Map<string, number>();

// audit 2026-10-21 (P0):「mtime 基线失效」的 id 集合 —— 被**搬移/改名**过
//   的笔记。
//
//   主进程在搬移/改名时会把 frontmatter id 重钉(standalone.ts repinNoteId)
//   ⇒ **重写文件** ⇒ 磁盘 mtime 必然变。而 renderer 手里的
//   activeNoteFull.mtime 还是搬移**前**的快照 ⇒ 拿它当 expectedMtime 去
//   比对 ⇒ 必报 CONFLICT。**这是假冲突**:文件是我们自己动的,不是外部改的。
//
//   标记在「该 id 的下一次 loadFullNote 成功」时清掉 —— 那时 activeNoteFull
//   拿到的是磁盘权威 mtime,基线重新可信。
//
//   为什么不用时间窗(同项目里被实证批过的那类「窗口内外部改动被吞掉」):
//   mtime 是否失效是**状态**问题不是时间问题 —— 下一次成功读盘就恢复,
//   不必等固定秒数;也不存在「窗口内的外部改动被误判」的风险。
const _mtimeStaleIds = new Set<string>();

interface NotesState {
  /** 列表摘要(无 body)。5000 条 × ~200B ≈ 1MB,代替原来 25MB 全表 body。 */
  notes: StandaloneNoteSummary[];
  /** 当前选中笔记 id — NotesView 切到新 id 时触发 loadFullNote。 */
  selectedId: string | null;
  /** 当前选中笔记的全量(含 body)。仅 selectedId 变化时拉一次,后续 save 后由乐观更新覆盖。 */
  activeNoteFull: StandaloneNote | null;
  /** true 表示当前正在 fetch activeNoteFull;UI 用来显示加载态/避免闪烁。 */
  loadingFull: boolean;
  // audit round 12 (2026-09-15):SILENT-006 — 与 favorites.ts / library.ts
  //   / paths.ts 对齐,暴露 lastError 让 NotesList 空态能区分"还没创建"
  //   与"load 失败"(后者会显示 retry 而不是 + 新建 CTA)。load() catch
  //   设置,下次 load 成功自动清 null。
  lastError: string | null;
  // 多选 + 剪贴板(VS Code 文件管理器语义):selectedIds 是文件操作作用集,
  // 与驱动编辑器的 selectedId 解耦。
  /** 多选集合 — 剪切/复制/删除的作用范围。 */
  selectedIds: Set<string>;
  /** Shift 范围选择锚点(Shift+击 不更新)。 */
  anchorId: string | null;
  /** 剪贴板(in-memory,重启即丢)。 */
  clipboard: { ids: string[]; mode: 'copy' | 'cut' } | null;
  // audit-r143:自定义排序 —— 资源 id → 视觉顺序(小者靠前)。未登记项落到
  //   +Infinity 之后(列表底部),保证旧库 / 漏登记都不挤前。
  displayOrderById: DisplayOrderMap;
  load: () => Promise<void>;
  select: (id: string | null) => void;
  /** 单击:selectedIds={id},anchorId=id。 */
  selectOnly: (id: string) => void;
  /** Ctrl/Cmd+击:切换成员,anchorId=id。 */
  toggleSelect: (id: string) => void;
  /**
   * Shift+击:anchor→id 闭区间;无 anchor 退化为 selectOnly。
   *
   * @param visibleIds **当前可见**的行 id(按渲染顺序)。传了就以它为区间口径,
   *   不传则退回 store 数组顺序(全库 mtime 倒序)。
   *   audit-r243:必须传 —— 列表是**树状 + 过滤 + 自定义排序**的,store 数组
   *   顺序与屏幕上的行顺序不是一回事;拿 store 顺序切区间会选到
   *   **用户看不见的行**(搜索过滤 / 收藏过滤下的非命中项、折叠夹里的笔记),
   *   随后的 Delete / Ctrl+X 会把那些行一起删掉。
   */
  selectRange: (id: string, visibleIds?: readonly string[]) => void;
  clearSelection: () => void;
  /** 整体替换选择(Ctrl+A 全选场景):selectedIds=ids,anchorId 不动。 */
  selectMany: (ids: string[]) => void;
  /** 剪切:ids 按列表可视顺序;空选择 no-op。 */
  cut: () => void;
  /** 复制:ids 按列表可视顺序;空选择 no-op。 */
  copy: () => void;
  /**
   * 粘贴到目标磁盘目录(r161+ disk-folder;undefined/null = kind 根)。
   * - cut:循环 api.notesMove(id, targetRelPath) 逐条原子移动;全部成功
   *   才清剪贴板(consumeMovedFromClipboard)并 load() 拉新列表;任一失败
   *   抛错且剪贴板保留可重试。moveToFolder 与 paste(cut) 共享同一 IPC
   *   路径,语义对齐(r166)。
   * - copy:先副本(readNote→createNote→writeNote,撞名递增 'X (copy N).md'),
   *   再循环 api.notesMove(newId, targetRelPath) 把副本移入目标;任一
   *   移动失败抛错,成功的部分留盘上不动(用户能看见已落定的副本)。
   *   可重复粘贴,剪贴板保留。
   * (r166 重写:旧实现 cut 分支只清剪贴板不调 IPC,Phase 2 由
   *   useDiskFolderSidebar + NOTES_MOVE 接管;本轮 store paste 自走 IPC,
   *   与 useDiskFolderSidebar.moveItems 错误形态一致 —— 单条 throw + 累计
   *   errors。行为锁 tests/unit/renderer/store/notes-cut-paste.test.ts
   *   (r166 建,audit-r229 核对指针:原先指向的 notes-store-clipboard.test.ts
   *   从未存在,真实守卫文件名是 notes-cut-paste.test.ts —— 指针过期,非守卫缺失)。)
   */
  paste: (targetRelPath?: string | null) => Promise<void>;
  /**
   * 把资源行批量搬到目标目录(r161+ disk-folder;与 paste(cut) 走同一 IPC)。
   * 走 api.notesMove(id, target) 单条原子 + 累计 errors,首个 throw;剪贴板
   * 走 consumeMovedFromClipboard 统一处理(全命中清空 / 部分剩余 / copy
   * 不动)。r166 从 throw 占位改为真实实现。
   *
   * r175:返回 **idRemap 映射表**(oldId → { id, relPath })。fs.rename 之后
   *   资源 id 随 relPath 重算 —— caller 若还拿着搬移前的 id 去 select /
   *   requestFocusNote,拿到的是已不存在的死 id(NotesList importFiles
   *   曾因此「导入后右侧打不开」)。全成功时返回完整映射;部分失败时
   *   映射里只含**成功**条目,并挂在抛出的 error.idRemap 上(caller 在
   *   catch 分支也能取到已落地那部分的正确 id)。
   */
  moveToFolder: (
    ids: string[],
    targetRelPath: string | null,
  ) => Promise<Map<string, { id: string; relPath?: string }>>;
  /** 拉取全量笔记(按 id),结果存 activeNoteFull。selectedId 变化时调用。 */
  loadFullNote: (id: string) => Promise<void>;
  create: (filename: string, folderId?: string | null) => Promise<StandaloneNote>;
  // 2026-10-16 file-manager ops:remove → trash —— 删除走系统回收站
  //   (shell.trashItem),可从系统回收站恢复。
  trash: (id: string) => Promise<void>;
  save: (id: string, body: string, title?: string) => Promise<StandaloneNote>;
  renameFile: (id: string, newFilename: string) => Promise<StandaloneNote>;
  /**
   * 在文件管理器中显示该笔记的文件(Win/Mac 选中文件,Linux 打开父目录)。
   * 失败由 IPC 透传 LibraryError → renderer 端 unwrap → IpcError,store
   * 不做兜底:文件被外部删除属于"用户磁盘被改"错误,应该 toast 给用户看。
   */
  showInFolder: (id: string) => Promise<void>;
  /** 拖入导入(2026-09-14):从 OS 拖入的 .md 文件 → 主进程解析 frontmatter + body
   *   → createNote + writeNote 创建新笔记。NOTES_CHANGED 推送会自动触发 load()。
   *   返回 NotesImportResult 用于 UI toast;非 .md 文件主进程会抛 IO_ERROR,
   *   这里把 unwrap 抛错让 caller 走 try/catch。 */
  importFromFile: (path: string) => Promise<NotesImportResult>;
  /**
   * 局部更新 notes 数组中对应 id 的 summary。
   * 取代 setState({ notes }) 直写 —— 走 store action 让未来 middleware / 校验
   * 扩展时(immer / devtools / persist)不会被旁路。
   * NotesView.AI 流式更新场景用 —— AI 流式 push 出来 StandaloneNote → 落库为 summary。
   */
  updateSummary: (note: StandaloneNote) => void;
  // audit-r143:reorder 拖拽落地 —— 父级(NotesList)按当前可视顺序拼出
  //   完整 id 序列,本 action 重写 0..N-1 连续整数并存 localStorage。
  reorderByIds: (orderedIds: string[]) => void;
  // r168:把一组 (oldId → newNote) 应用到 selectedId + activeNoteFull 上。
  //   用于 disk hook 的 handleTargetDrop 路径 —— drag 端不走 store action,
  //   走完 api.notesMove 拿 idRemap 回调到本方法,把 store 侧 selectedId
  //   / activeNoteFull 拉到新 id,避免编辑器卡在已不存在 id 上。
  //   paste(cut) / moveToFolder 路径内部已隐式调,这里只外暴露给 drag 路径。
  applyMoveRemap: (idRemap: Map<string, { id: string; relPath?: string; absPath?: string }>) => void;
}

/**
 * audit-r143:把 load() 拉回的 notes 与旧 displayOrderById 对齐 —— 保留旧
 *   顺序(数值小 = 靠前),丢失的 id(已删 / 拉走)从 map 中剔除,新出现的
 *   id(导入 / 外部 push)暂不动(放到 +Infinity 之后,等 reorder 或重排
 *   触发后归位)。返回新 map,React 通过 Object.is / 引用比较触发重渲。
 */
function alignOrder(existing: DisplayOrderMap, items: StandaloneNoteSummary[]): DisplayOrderMap {
  const validIds = new Set<string>(items.map((n) => n.id));
  const next: DisplayOrderMap = {};
  for (const [id, order] of Object.entries(existing)) {
    if (validIds.has(id) && Number.isFinite(order)) {
      next[id] = order;
    }
  }
  return next;
}

// audit 2026-10-01 / r193:**明确不缓存** —— load() 每次都真发 IPC。
//   这是刻意的,不是遗漏:load() 的主驱动源是 NOTES_CHANGED 推送,而
//   library 那边已经因为套上 1s TTL 踩过一次 HIGH 事故 —— watcher 的
//   debounce 200ms + stabilityThreshold 500ms 会让一次批量同步连发多个
//   相隔 500~700ms 的 batch,后一个命中前一个的缓存窗口,拿到陈旧数组,
//   连 IPC 都不发,那批新笔记永远不出现。
//   **别为了「和 library 统一」给这里补缓存。**
//
// r193 补记:上面那段注释原先写「notesCache 故意不带 ts ⇒ TTL 分支对
//   notes 静默失效」——**这条在旧实现里是假的**:loadOnce 自己在成功时
//   写 `cache.ts = Date.now()`,第一次 load 之后 notesCache 运行时**多出**
//   一个 ts 属性 ⇒ TTL 从第二次 load 起就生效 ⇒ 笔记列表被实打实缓存了
//   1 秒(NOTES_CHANGED 推送被吞、新列表拿不到、r193 的「剔死 id」逻辑
//   根本看不到新列表)。r193 的修法(给 loadOnce 加「ttlMs 默认 0 + 只在
//   ttlMs>0 时写 ts」)只是**约定层**的双保险;r218 把 loadOnce 整体下线
//   (它唯一的生产消费方就是本 store),「不缓存」从字段约定升级为
//   结构事实 —— 每次 load 直发新 IPC,根本没有缓存对象可写。
//
// audit-r218:load() 不再走 loadOnce 单飞 join —— join 与「不缓存」矛盾,
//   且它是真的 bug:一次**变更前**发出的慢 listNotes 在途时,变更完成 +
//   NOTES_CHANGED 推送触发的 load 会**并到这个在途 promise 上**(不再发
//   新 IPC),变更前的旧快照落地后**没有任何后续 fetch** ⇒ 列表永远停在
//   旧状态(刚删的笔记还在列表里),要等下一次外部事件才自愈。
//   修法 = 镜像 literature store 的 r73 序号守卫:_loadIssued 每请求 +1,
//   _loadApplied 记录已落地结果里最新的序号,迟到的旧快照直接丢弃
//   (`seq < _loadApplied` 不 set)。notes 侧比 literature 更激进:**每次
//   load 都发新 IPC、不做 in-flight join**(listNotes 在主进程是内存 map
//   直读,并发几发没有成本;r193 的「不缓存」意图本来就该这样落地,
//   join 是缓存设计的残留)。原来散布在各 mutation 后的
//   `notesCache.value = undefined` 失效行随缓存一并删除(无缓存可失效)。
//   行为锁:tests/unit/renderer/store/notes-load-seq-guard.test.ts
let _loadIssued = 0;
let _loadApplied = 0;

// IpcError.code === 'DUPLICATE_NAME' 即视为撞名(主进程 IPC.NOTES_CREATE
// handler 在 audit-r22 改造后保留 LibraryError.code 不再翻译成 VALIDATION,
// 让 renderer 端 retry loop 能精准区分「撞名可重试」与「其它校验错」)。
// 其它 ValidationError(EMPTY / INVALID_CHARS / RESERVED_NAME / TOO_LONG)
// 仍走 code === 'VALIDATION',不应被吞进 retry。IpcError 是 unwrap() 失败
// 时唯一会抛的类型(见 lib/api.ts),用 instanceof 比 unsafe cast 更安全。
function isDuplicateNameError(err: unknown): boolean {
  return err instanceof IpcError && err.code === 'DUPLICATE_NAME';
}

// r167:跨目录搬移后重映射编辑器选中态 —— fs.rename 触发 frontmatter id
//   重算(id = computeFileId(newRelPath)),若编辑器当前选中笔记正在被搬走,
//   selectedId 仍指向旧 id 会让下一次 save() 撞 NOT_FOUND(toast 注入),
//   activeNoteFull 也仍是旧 relPath,与磁盘事实漂移。本 helper 把这两者
//   同步到 IPC 响应里给出的新 id/relPath。body 不变(rename 不改内容),只
//   刷 id/relPath/filename 三字段。
//
// 应用场景:
//   - paste(cut) 全部成功路径
//   - moveToFolder 全部成功路径(disk hook 的 drop 端 r168 由 onItemsMoved
//     回调转 store.applyMoveRemap,共用本 helper 实现)
//   - r168 disk hook drag 路径(走 store action 接口注入)
//
// 注意:setState 不能影响 chokidar 后续 push(load() 仍会把 notes[] 列表刷到
//   含新 id 的形态)—— 我们这里只抢在 listener 之前把编辑器侧状态对齐磁盘
//   当前状态,后续 listener 走标准 invalidate/load 流程。NotesView 的
//   loadFullNote effect 对新 selectedId 会因 invalidate 而强制 re-fetch,与
//   期待语义一致。

// audit r28 (2026-09-21):djb2 字符串哈希 —— 派生 retry 名后缀,
//   同 filename 同窗口内多次 retry 共享同一 hash(便于日志追踪),
//   不同 create 调用大概率不同(避免并发 ⌘N 撞同一序列)。
//   djb2 比 cyrb53 实现更简单且足够分散,32-bit 范围内碰撞概率 ~ 2^-32。
function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) {
    h = (h * 33 + s.charCodeAt(i)) | 0;
  }
  return h;
}

// r175:目标目录 relPath 归一 —— null / undefined / '' = 根(空串)。
//   首尾 '/' 与空段丢掉;'.' / '..' 段(越界 / 无意义)一律拒收成根,
//   因为主进程 createNote 走 resolveInsideRootPath —— '..' 会被安全层
//   拒(UNSAFE_WRITE),但那时用户已经点了「新建」却什么都没发生,
//   比直接落在根更让人困惑。sidebar 给的 currentId 永远是合法 relPath,
//   这条只是防御性兜底。
function normalizeTargetDir(folderId: string | null | undefined): string {
  if (!folderId) return '';
  const segs = folderId.split('/').filter((s) => s.length > 0);
  if (segs.some((s) => s === '.' || s === '..')) return '';
  return segs.join('/');
}

export const useNotesStore = create<NotesState>((set, get) => ({
  notes: [],
  selectedId: null,
  activeNoteFull: null,
  loadingFull: false,
  lastError: null,
  selectedIds: new Set<string>(),
  anchorId: null,
  clipboard: null,
  // audit-r143:init 读一次 localStorage(任何 throw 都被 loadOrder 内部
  //   防御吞掉,返回 {} 兜底)。后续 load() set 块会调 alignOrder
  //   剔死 id;这里不做 align 是不想对空 items 跑一遍空操作。
  displayOrderById: loadOrder('note'),
  load: async () => {
    // r218:每次都发新 IPC(不做 in-flight join),序号守卫保证只有最新
    //   快照能落地(镜像 literature r73;迟到的旧响应 `seq < _loadApplied`
    //   直接丢弃,不 set、不清 lastError)。
    const seq = ++_loadIssued;
    try {
      const notes = unwrap(await api.listNotes());
      if (seq < _loadApplied) return;
      _loadApplied = seq;
      // r193:reload **不再清空**多选 —— 只**剔掉已经不存在的** id。
      //
      //   旧实现无条件 `selectedIds: new Set()` / `anchorId: null`,而
      //   load() 的调用点有一大把:create / trash / rename / paste(copy) /
      //   NOTES_CHANGED 广播(任何外部改动:另一个窗口写盘、chokidar 事件、
      //   网盘同步落盘……)。后果:
      //     1. 用户 Ctrl 多选 3 篇 → 任意一次**无关**的刷新把多选清空 →
      //        紧接着按 Delete / Ctrl+X **静默无反应**(作用集为空,
      //        菜单项还在、点了没动静);
      //     2. 与 literature 域**不对称** —— literature 的 load() 从不清
      //        多选(见 store/literature.ts loadImpl)⇒ 同一个「多选 → 删」
      //        动作在文献侧好用、在笔记侧不好用(用户诉求:两侧操作要对齐);
      //     3. 仓库自己在 paste(cut) 分支绕开 load() 正是因为这条
      //        (store/notes.ts:388 注释:「主动 load 会清掉 selectedIds,
      //        破坏 VS Code / Finder『cut 选中保持』语义」)—— 绕法只覆盖
      //        了 cut 一条路径,其余路径照旧丢。
      //   「防 stale id」的意图由**剔除**实现即可:不在新列表里的 id 一定
      //   是死 id,留着才是 stale。
      const alive = new Set(notes.map((n) => n.id));
      const cur = get();
      // perf r258:结构共享 —— IPC clone 回来的每条都是**新对象**(内容一样
      //   也一样),于是 store.notes 每轮换引用 ⇒ 订阅它的 useShallow 浅比
      //   恒为「不等」⇒ useShallow 一直是假绿 ⇒ 每次 NOTES_CHANGED(自动
      //   保存 / 外部改盘 / 网盘同步)整个可见列表 + 每一行都重渲。把
      //   「字段全等」的条目换成上一轮那一份对象 ⇒ 引用不变 ⇒ 浅比真的
      //   相等 ⇒ 整表不重渲;变了的条目换新对象 ⇒ 只有那几行重渲。
      const mergedNotes = shareUnchanged(cur.notes, notes);
      const kept = new Set([...cur.selectedIds].filter((id) => alive.has(id)));
      // 成员没变就**沿用旧 Set 引用** —— 避免每次 reload 都让选中态组件
      // 拿到新引用而重渲(react-virtuoso 的行 memo 会整片失效)。
      const sameMembers =
        kept.size === cur.selectedIds.size && [...kept].every((id) => cur.selectedIds.has(id));
      const nextSelectedIds = sameMembers ? cur.selectedIds : kept;
      const nextAnchorId = cur.anchorId && alive.has(cur.anchorId) ? cur.anchorId : null;
      // audit-r143:同 set 内同时刷新 displayOrderById(atomic)—— alignOrder
      //   剔除已删的旧 id,保留旧顺序,新 id 不进 map(列表视图先落到
      //   +Infinity 之后),等下一次 reorder / 主动拖拽重排归位。
      set({
        notes: mergedNotes,
        lastError: null,
        selectedIds: nextSelectedIds,
        anchorId: nextAnchorId,
        displayOrderById: alignOrder(cur.displayOrderById, mergedNotes),
      });
    } catch (err: unknown) {
      // r218:失败路径同样过序号闸(镜像 literature r73)—— 迟到的**旧**
      //   失败不得在更新的快照已落地后把 lastError 重新置上(那会把这个
      //   已经是新数据的列表标成「load 失败」)。
      if (seq < _loadApplied) return;
      _loadApplied = seq;
      // audit round 12 (2026-09-15):SILENT-006 — 与 favorites.ts 同款,
      //   catch 时设 lastError,让 NotesList 空态能区分"无笔记"与"load 失败"。
      //   错误推到主进程 log 后这里只记 renderer 端 errMsg(reason),避免
      //   IPC 链路静默。
      log.warn('useNotesStore.load failed', errMsg(err));
      set({ lastError: errMsg(err) });
    }
  },
  select: (id) => set({ selectedId: id }),
  selectOnly: (id) => set({ selectedIds: new Set([id]), anchorId: id }),
  toggleSelect: (id) => {
    const next = new Set(get().selectedIds);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    set({ selectedIds: next, anchorId: id });
  },
  selectRange: (id, visibleIds) => {
    const { notes, anchorId } = get();
    // audit-r243:区间口径 = **可见行顺序**(组件传 visibleItems 的 id 序);
    //   没传(理论上只有旧调用点)才退回 store 数组顺序。
    const order = visibleIds ?? notes.map((n) => n.id);
    const anchorIdx = anchorId ? order.indexOf(anchorId) : -1;
    const targetIdx = order.indexOf(id);
    if (anchorIdx < 0 || targetIdx < 0) {
      get().selectOnly(id);
      return;
    }
    const lo = Math.min(anchorIdx, targetIdx);
    const hi = Math.max(anchorIdx, targetIdx);
    set({ selectedIds: new Set(order.slice(lo, hi + 1)) });
  },
  clearSelection: () => set({ selectedIds: new Set(), anchorId: null }),
  selectMany: (ids) => set({ selectedIds: new Set(ids) }),
  cut: () => {
    const { notes, selectedIds } = get();
    const ids = notes.filter((n) => selectedIds.has(n.id)).map((n) => n.id);
    if (ids.length > 0) set({ clipboard: { ids, mode: 'cut' } });
  },
  copy: () => {
    const { notes, selectedIds } = get();
    const ids = notes.filter((n) => selectedIds.has(n.id)).map((n) => n.id);
    if (ids.length > 0) set({ clipboard: { ids, mode: 'copy' } });
  },
  paste: async (targetRelPath) => {
    const clip = get().clipboard;
    if (!clip || clip.ids.length === 0) return;
    if (clip.mode === 'cut') {
      // r161+ disk-folder:r166 自走 IPC(api.notesMove 单条原子),
      //   错误形态与 useDiskFolderSidebar.moveItems 一致(逐条 try/catch +
      //   errors 累计,首个 throw + 剪贴板保留可重试)。
      const target = targetRelPath ?? '';
      const errors: Array<{ id: string; code: string; message: string }> = [];
      // r167:记每次成功响应的 (oldId → newNote) 用于下面 selectedId/activeNoteFull 重映射。
      // fs.rename 后 frontmatter id = computeFileId(newRelPath) 与旧不同,
      //   IPC 返回的 data.id 是新 id。编辑中的笔记被搬移后,selectedId 必须同步跳到新 id,
      //   否则后续 save() 撞 NOT_FOUND。
      const idRemap = new Map<string, { id: string; relPath: string }>();
      for (const id of clip.ids) {
        try {
          const r = await api.notesMove(id, target);
          if (r.ok) {
            idRemap.set(id, r.data);
          } else {
            errors.push({ id, code: r.code, message: r.message });
          }
        } catch (err: unknown) {
          // unwrap 之外的非 IpcError(unexpected throw)也按失败累计,语义不漏
          errors.push({ id, code: 'INTERNAL', message: errMsg(err) });
        }
      }
      if (errors.length > 0) {
        const first = errors[0]!;
        const wrapped = new Error(
          `notes paste(cut) failed ${errors.length}/${clip.ids.length}: ${first.message}`,
        ) as Error & { code?: string; errors?: typeof errors };
        wrapped.code = first.code;
        wrapped.errors = errors;
        // 剪贴板保留,用户可重试(对账 useDiskFolderSidebar.moveItems 失败分支)
        throw wrapped;
      }
      // 全部成功:消费剪贴板(全清)。r218 起无缓存,「下一次 list 重拉」恒成立。
      //   不主动 load():chokidar 'change' → NOTES_CHANGED 推送 → 监听器
      //   走 load() 拿最新;cut 的「选中保持」语义由 consumeMovedFromClipboard
      //   + applyMoveRemapImpl 负责(测试锁契约)。
      //   r193 补注:原先这里写「主动 load 会清掉 selectedIds」—— 那时 load()
      //   确实会无条件清空;r193 起 load() 改成「只剔死 id」,所以这句理由
      //   已过时,但「cut 路径不主动 load」的**行为**保留(搬移后 id 会变,
      //   由 remap 精确跟随比让 load 事后剔更可控)。
      consumeMovedFromClipboard(set, get, clip.ids);
      applyMoveRemapImpl(set, get, idRemap);
      return;
    }
    // copy:副本**直接建在目标目录**(一次 createNote,不再 create→move 两段)。
    //
    // audit-r170 重写(旧实现三处硬伤,逐条对应用户报的「粘贴功能有问题」):
    //   1. 副本名带圆括号('X (copy).md')—— 旧名被 filename-validator 拒
    //      (regex 不收 '(' ')',r170 已放开)→ 旧实现**每一次**复制粘贴都抛
    //      ValidationError,副本一个都建不出来。
    //   2. 副本名带源目录前缀 —— 旧实现 base = stripExt(src.relPath),stripExt
    //      保留目录前缀,子目录里的笔记 base='sub/foo' → createNote('sub/foo
    //      (copy).md') 在**源目录**下又建一层嵌套,副本根本没进目标夹。
    //   3. 目标目录 = 根时副本留在源目录 —— 旧实现 targetRelPath 为空/null
    //      时整段 notesMove 被跳过,副本停在源目录;现在直接建在目标,根也正确。
    //   附带收益:**不再搬移 ⇒ frontmatter id 不重算** ⇒ selectedIds 拿到的
    //      就是最终 id(旧实现 move 之后 id 变,newIds 变 stale,选中指向死 id)。
    //
    // 错误形态对齐 paste(cut):逐条 try/catch + errors 累计,成功的副本照常
    // 落地并选中,最后抛聚合错(NotesList catch → toast)。copy 模式剪贴板
    // 不消费(可重复粘贴)。
    const target = targetRelPath ?? '';
    // 撞名避让只扫**目标目录**内的既有文件(旧实现拿全库 relPath 跟裸文件名
    // 比,格式对不上 → 永远不判撞名)。
    const taken = new Set<string>();
    for (const n of get().notes) {
      // dirnameOfRelPath 收的是**行对象**(取它的 relPath 字段),不是裸字符串
      if (dirnameOfRelPath(n) === target) taken.add(n.filename);
    }
    const newIds: string[] = [];
    const errors: Array<{ id: string; code: string; message: string }> = [];
    for (const id of clip.ids) {
      try {
        const src = unwrap(await api.readNote(id));
        // 候选名循环:本地 taken 乐观避让 + 主进程 DUPLICATE_NAME 权威兜底
        // (notes[] 是 load 时的快照,期间主进程新建的同名文件本地看不见)。
        let created: { id: string } | null = null;
        for (let attempt = 0; attempt < 5 && created === null; attempt += 1) {
          const name = nextNoteCopyFilename(taken, src.relPath);
          taken.add(name);
          try {
            created = unwrap(await api.createNote(target ? `${target}/${name}` : name));
          } catch (err: unknown) {
            // 主进程说撞名 → 换下一个候选名重试;其它错误直接冒泡到外层累计
            if (!isDuplicateNameError(err) || attempt === 4) throw err;
          }
        }
        if (created === null) {
          throw new Error('notes paste(copy): no free filename candidate');
        }
        unwrap(await api.writeNote(created.id, src.body, src.title ?? undefined));
        newIds.push(created.id);
      } catch (err: unknown) {
        errors.push({
          id,
          code: err instanceof IpcError ? err.code : 'INTERNAL',
          message: errMsg(err),
        });
      }
    }
    await get().load();
    // copy 模式选中新副本;cut 模式选中保持原 id(consumeMovedFromClipboard 阶段已剔)
    set({ selectedIds: new Set(newIds) });
    if (errors.length > 0) {
      const first = errors[0]!;
      const wrapped = new Error(
        `notes paste(copy) failed ${errors.length}/${clip.ids.length}: ${first.message}`,
      ) as Error & { code?: string; errors?: typeof errors };
      wrapped.code = first.code;
      wrapped.errors = errors;
      // copy 模式下剪贴板保留(可重复粘贴),已落定的副本已选中,用户在 UI 可见
      throw wrapped;
    }
  },
  /**
   * 跨目录搬移(r161+ disk-folder Phase 2:真实 fs.rename)。
   * - targetRelPath = null → 根(同 paste(cut) target = '' 语义)
   * - 逐条 api.notesMove 原子调,单条 reject / throw 累计到 errors,首个 throw
   *   整体失败,剪贴板保留可重试(对账 paste(cut) 失败分支)。
   * - 成功:consumeMovedFromClipboard(set, get, ids) —— 与 paste(cut) 「cut 模式
   *   成功后清空/剔剩余」语义统一,不动 setState 选中(autosave 期间切笔记保护)。
   * - 不主动 load():chokidar 'change' 触发 NOTES_CHANGED 推 → listener 走
   *   load() 拿最新(同 paste(cut) 成功路径保持一致)。
   * - 类型签名 Promise<void>:无 caller 拿返回,Phase 1 throw 占位 `Promise<number>`
   *   一并改掉。
   */
  moveToFolder: async (ids: string[], targetRelPath: string | null) => {
    if (ids.length === 0) return new Map();
    const target = targetRelPath ?? '';
    const errors: Array<{ id: string; code: string; message: string }> = [];
    // r167:记每次成功响应的 (oldId → newNote) 用于下面 selectedId/activeNoteFull 重映射。
    // drag-into-folder 路径(走 disk.handleTargetDrop)同样会撞这个边界,
    //   但 disk hook 直接 await api.notesMove 不经过 store,见 useDiskFolderSidebar
    //   头注:drop 端是 note-row 视角而非 editor 视角,同一编辑器 selectedId 漂移问题
    //   仍存在 — 但目前 disk hook 不操作 selectedId,影响经 editor 用户发起 cut/paste
    //   这条路径才到。本 store action 已在此处覆盖;disk hook 的边角验证留作 r168+ 复查。
    const idRemap = new Map<string, { id: string; relPath: string }>();
    for (const id of ids) {
      try {
        const r = await api.notesMove(id, target);
        if (r.ok) {
          idRemap.set(id, r.data);
        } else {
          errors.push({ id, code: r.code, message: r.message });
        }
      } catch (err: unknown) {
        errors.push({ id, code: 'INTERNAL', message: errMsg(err) });
      }
    }
    if (errors.length > 0) {
      const first = errors[0]!;
      const wrapped = new Error(
        `notes moveToFolder failed ${errors.length}/${ids.length}: ${first.message}`,
      ) as Error & { code?: string; errors?: typeof errors; idRemap?: typeof idRemap };
      wrapped.code = first.code;
      wrapped.errors = errors;
      // r175:部分成功也要把重映射应用到 store —— 已经搬走的那些资源 id
      //   确实变了,selectedId / selectedIds 留在旧 id 上就是死引用。
      //   同时把映射挂到 error 上,caller(catch 分支)能取到已成功那部分
      //   的正确 id,不会因为一条失败就丢掉整批的落点。
      wrapped.idRemap = idRemap;
      applyMoveRemapImpl(set, get, idRemap);
      throw wrapped;
    }
    consumeMovedFromClipboard(set, get, ids);
    applyMoveRemapImpl(set, get, idRemap);
    return idRemap;
  },
  loadFullNote: async (id) => {
    // 防御:已加载且 id 匹配、且没有被外部改动通知过 → 不重复拉
    // (避免切回原笔记时白白 roundtrip)。
    // audit 2026-09-10:加 invalid 守卫 —— 仅"自我未感知外部修改"才跳过,
    //   否则保持旧 early-return 行为:外部编辑(其他窗口 / 文件系统 watch)
    //   后用户切到 B 再切回 A,activeNoteFull 还是旧 body,用户下一句
    //   autosave 直接覆盖外部改动。NOTES_CHANGED 监听器会调 invalidate(id)
    //   把对应 id 标 dirty,这里检查后强制 re-fetch。
    const cur = get().activeNoteFull;
    if (cur && cur.id === id && !isInvalidated(id)) return;
    const myToken = ++_loadFullNoteToken;
    // audit-r76:读发出的墙钟时刻 —— stale read 判定的另一半(见
    // _writtenAtById 注释)。只有「读发出 < 写落地」的读才可能是 stale。
    const issuedAt = Date.now();
    set({ loadingFull: true });
    try {
      const full = unwrap(await api.readNote(id));
      // 用户在这期间又调了一次 loadFullNote(选了别的笔记) → 自己的 token
      // 已经落后,自己读到的 full 是 stale,直接丢弃。否则会把旧笔记 body
      // 覆盖到当前 selectedId 对应的 activeNoteFull 上,UI 闪烁。
      if (myToken !== _loadFullNoteToken) return;
      // audit 2026-10-09:HIGH —— 「autosave 期间切笔记 + save 落 CONFLICT」
      //   这条窄 race 之前靠 token 守不住。典型顺序:
      //     1. 用户编辑 A,autosave 飞,selectedId=A
      //     2. 用户切到 B,NotesView effect 调 loadFullNote(B),token=2
      //     3. A 的 save 返回 CONFLICT,catch 调 loadFullNote(A),token=3
      //     4. B 的 readNote 先到:token(2) !== _loadFullNoteToken(3) → 丢
      //     5. A 的 readNote 后到:token(3) === 3 → set activeNoteFull = A
      //   结果:用户切到 B,编辑器却显示 A 的 body(且与 A 的 in-memory body
      //   不同,是磁盘上外部修改过的版本),selectedId=B 但内容是 A。修:
      //   token 检查之后再校验 selectedId 没变,跨笔记的 late return 一并
      //   丢,不再误把 A 的 body 写到 B 的 activeNoteFull 上。clearInvalidated
      //   也不调 —— 现在 selectedId 不是 id,失效标记留着无害(下次回 A 时
      //   loadFullNote 看到 isInvalidated 仍会强制 re-fetch)。
      // audit-r76:token 仍是当前值 ⇒ 没有更新的 loadFullNote 在飞,loadingFull
      //   只有自己在持有,early-return 前必须清掉 —— 否则「选中 A → A 在飞 →
      //   删除 A(selectedId=null,不触发新 load)」这条路径会把 loadingFull
      //   永久卡在 true。catch 分支的同款 return 同理。
      if (get().selectedId !== id) {
        set({ loadingFull: false });
        return;
      }
      // audit 2026-10-09 (MEDIUM):stale read 守卫 —— 若本次读到的 mtime 比
      //   已知的「最近一次成功写入」更旧,说明这个 readNote 在写之前开始、写
      //   完成后才返回,结果是写入前的旧 body。此时若直接 set 会覆盖掉 save()
      //   刚落好的乐观新值,诱发下次 autosave 的伪 CONFLICT(用户刚敲的字被当成
      //   可丢弃态)。丢弃,保留 save 的新值。外部真改(磁盘 mtime 更新)读到的
      //   mtime 必然 ≥ 这里记录的值,不会被误丢。
      // audit-r76 (2026-10-17) HIGH:加「读发出 ≤ 写落地」前提 —— 旧守卫把
      //   写落地之后发出的读也一律丢弃,外部真实回滚磁盘(网盘降级同步/备份
      //   还原)时进入永久 discard 循环:invalidated 清不掉、loadingFull 卡
      //   true、之后每次 autosave 都 CONFLICT(实证见 r76 repro 与
      //   notes-stale-read-recovery.test.ts)。现在:
      //   - issuedAt ≤ writtenAt:真 stale read(读发出于写落地前;同毫秒
      //     tie 保守按 stale,理由见 _writtenAtById 声明处)→ 丢弃;
      //     loadingFull 自己持有(token/selectedId 都已确认),清掉再走。
      //   - 否则:磁盘被外部回滚,这次读是权威 → 收下,并把 writtenMtime
      //     重定基到磁盘值,后续 save 的 expectedMtime 用新基线,CONFLICT
      //     循环就此解开(CONFLICT toast 已在 save 的 catch 里告知用户)。
      const writtenMtime = _writtenMtimeById.get(id) ?? -Infinity;
      if (full.mtime < writtenMtime && issuedAt <= (_writtenAtById.get(id) ?? -Infinity)) {
        set({ loadingFull: false });
        return;
      }
      if (full.mtime < writtenMtime) {
        _writtenMtimeById.set(id, full.mtime);
      }
      // audit 2026-09-21 audit-r24:readNote 现在抛 NOT_FOUND(不再返 null),
      //   走下方 catch 路径 —— 用户看到 toast + NotesList/NotesView 渲染
      //   既有 activeNoteFull 或空态。这里只 set 成功结果。
      set({ activeNoteFull: full, loadingFull: false });
      clearInvalidated(id);
      // audit 2026-10-21:本次读拿到的是磁盘权威 mtime ⇒ 基线重新可信 ⇒
      //   清掉「mtime 基线失效」标记(搬移/改名留下的)。见 _mtimeStaleIds 声明。
      _mtimeStaleIds.delete(id);
    } catch (err) {
      // 失败也不阻塞 UI:清掉 loadingFull,让 NotesView 显示既有 activeNoteFull
      // 或空态。错误已由 wrap.ts 包络记录到 main log(IPC 失败路径)。
      // audit 2026-09-14 r7:renderer 端也 toast —— 用户面对空 editor + silent
      //   完全无法区分"还没加载完"与"加载失败",最差场景下还可能编辑 stale
      //   activeNoteFull → autosave 覆盖错的笔记。toast 让用户明确知道读失败。
      // 同样:catch 也要看 token —— 别的 loadFullNote 已经跑在前头,
      // 自己清 loadingFull 反而会让"新选中的笔记"短暂失去 loading 标记。
      if (myToken !== _loadFullNoteToken) return;
      // 跟上文 success 分支同款 selectedId 守:用户已经切到别的笔记,旧
      //   id 的 readNote 失败不应让 toast 弹"加载失败 A"打扰用户。这条
      //   guard 让 stale 的 catch 一起静默丢。
      // audit-r76:旧注释担心「清 loadingFull 会把新笔记的 loading 标记去掉」
      //   不成立 —— 能走到这 token 仍是当前值,说明新笔记的 loadFullNote 还没
      //   开始(否则 token 已前进,上面就 return 了),loadingFull 只有自己
      //   持有。「A 在飞 → 删除 A」路径不清会永久卡 true(同 success 分支)。
      if (get().selectedId !== id) {
        set({ loadingFull: false });
        return;
      }
      log.error('loadFullNote failed', err);
      // audit r32 (2026-09-23):HIGH — 旧实现无条件 consume pendingFocusNote,
      //   会把无关的 pendingFocusNote 也吃掉:
      //     1. 用户新建笔记 A → pendingFocusNote.payload=A → 触发 loadFullNote(A)
      //     2. 用户在 A 加载完前切到 B → 触发 loadFullNote(B)
      //     3. loadFullNote(B) 抛错 → catch 里 consumeFocusNoteRequest 无差别
      //        吃掉 pendingFocusNote.payload=A
      //     4. A 加载成功后 NotesView 永远收不到 focus,用户打字进错笔记
      //   修法:consume 之前校验 pendingFocusNote.payload 是否等于这次失败的 id
      //   —— 只 consume 这次失败的 load 对应的 focus flag,其它 keep。
      const ws = useWorkspaceStore.getState();
      const pendingPayload = ws.pendingFocusNote.payload;
      if (ws.pendingFocusNote.hasPending && pendingPayload === id) {
        ws.consumeFocusNoteRequest();
      }
      useToast.getState().show({
        type: 'error',
        message: i18next.t('notes.loadFullFailed'),
      });
      set({ loadingFull: false });
    }
  },
  // service 写操作后会触发 NOTES_CHANGED 推送,store 通过订阅自动 reload
  // 不需要本地清缓存再 load —— IPC 走通后下一次 list 自然拿最新。
  // 但响应里返回的对象是新的(note),有时需要立刻在 UI 上拿到,所以仍然返回 service 的结果。
  //
  // audit 2026-09-16 audit-r22 — 加 DUPLICATE_NAME retry loop:
  //   客户端 nextDefaultNewFilename(NotesList 预检)消除 90% 撞名,但
  //   仍有 ~5-30ms race window:连按 ⌘N 两次 IPC 都通过客户端预检都拿
  //   同一 base,IPC 2 进入主进程时 IPC 1 的 NOTES_CHANGED 推送 ~10-50ms
  //   还没回来 → IPC 2 也用同一 filename → fs.open('wx') 撞 EEXIST。
  //   主进程 IPC.NOTES_CREATE 在 audit-r22 改造后保留 code='DUPLICATE_NAME'
  //   不再翻译成 VALIDATION,renderer 端这里精准识别并自动换名重试。
  //   3 次窗口几乎必捕获(连按间隔 100ms+ >> 推送延迟)。
  //   其它错误(INTERNAL / IO_ERROR / VALIDATION EMPTY 等)直接抛,不吞。
  // audit r28 (2026-09-21):retry 名加 4-char 随机后缀 —— 三连按 ⌘N 都
  //   想 retry 用「Untitled 1.md」:第一个 create 占「Untitled 1」,
  //   第二/三个 IPC 都尝试「Untitled 1」,主进程 fs.open('wx') 一胜一败,
  //   败者第二次又都试「Untitled 2」... 同 deterministic 序列让并发的
  //   多个 create 持续撞名直到耗尽 3 次。修法:retry 名除了 attempt
  //   counter,再叠 4-char base36 后缀(自父级 filename hash 派生,与
  //   创建窗口绑定),并发实例的 hash 大概率不同,3 次窗口内一定
  //   唯一。base 用 filename 而非 `base`(stripExt 后),让连按 ⌘N 的
  //   同一窗口共享 hash ——「同窗口串行」走 deterministic counter,
  //   「跨窗口并发」走不同 hash。
  create: async (filename, folderId) => {
    // audit-r175 (2026-10-19) —— 目标目录必须真的用上。
    //
    // 旧实现 `void folderId;` 把目标目录**整个丢弃**,笔记永远建在 notes 根。
    // 后果链:
    //   1. 在子文件夹里按「+ 新建」→ 文件落在 notes 根;
    //   2. sidebar 的 visibleItemRows 按 dirname(relPath) === currentRelPath
    //      过滤,当前文件夹视图里根本看不到这条笔记(用户视角 =「新建坏了」);
    //   3. 文件落点与 UI 展示的文件夹不一致 —— 直接违反用户诉求
    //      「左侧列表要和对应文件夹完全一致」。
    //
    // folderId 语义 = 目标目录 relPath(null / undefined / '' = 根),
    // 与 moveItems / paste 的 targetRelPath 同一口径。
    const targetDir = normalizeTargetDir(folderId);
    const MAX_RETRIES = 3;
    const base = stripExt(filename); // retry 时复用同一 base,不再 stripExt(cur)
    // 短随机后缀从 filename 字符串派生 —— 同一 create 调用内每次 retry
    // 共享同一 hash(便于日志追踪),不同 create 调用大概率不同。
    const hash = Math.floor(Math.abs(hashString(filename) % 0x100000000))
      .toString(36)
      .slice(0, 4);
    let cur = filename;
    for (let i = 0; i < MAX_RETRIES; i += 1) {
      try {
        // r175:createNote 收的是**含目录的 relPath** —— 主进程 createNote
        //   接受 'sub/a.md' 形态(filename-validator 允许 '/',且 createNote
        //   会 mkdir -p 父目录),落点 = <root>/notes/<targetDir>/<name>。
        //   retry 名 cur 只是 basename,所以每次都要重新拼目录前缀。
        const relPath = targetDir ? `${targetDir}/${cur}` : cur;
        const note = unwrap(await api.createNote(relPath));
        await get().load();
        // 新建后立刻让上层 select(id) → loadFullNote 把 body 拉回来;
        // 返回 full 让调用方可以不用二次 IPC 拿 body(详见 NotesView.openRename 等路径)。
        return note;
      } catch (err: unknown) {
        if (!isDuplicateNameError(err) || i >= MAX_RETRIES - 1) throw err;
        // audit 2026-09-17 audit-r23 H1:retry 名由本地 attempt counter 派生,
        //   不再调 nextDefaultNewFilename(get().notes, base):
        //   - notes[] 在 retry 时 stale(load() 还没从主进程拉回本次 create 的
        //     推送,base 仍不在 taken → 又返回 `${base}.md` → 死循环)
        //   - 主进程是唯一权威,撞名继续 reject;3 次窗口必捕获(连按 ⌘N
        //     间隔 100ms+ >> NOTES_CHANGED 推送延迟 10-50ms)
        //   - i=0 → 「base 1-hash」,i=1 → 「base 2-hash」,i=2 → 兜底抛错
        // audit r28:retry 名加 hash 后缀,避免并发 ⌘N 撞同一序列。
        cur = `${base} ${i + 1}-${hash}.md`;
        continue;
      }
    }
    // 不可达:循环要么 return 要么 throw。TS 兜底。
    throw new Error('create note: unreachable retry exhaustion');
  },
  trash: async (id) => {
    unwrap(await api.trashNote(id));
    // audit 2026-09-10:清理 invalidate 标记 —— 旧实现删/重命名后,该 id
    //   仍留在 _invalidatedNoteIds 集合里,要等下次 loadFullNote 成功才
    //   清掉。大量 rename/delete 时 set 单调增长(虽然不会无限大,因为
    //   后续 load 总会读一次),但语义上"已不存在的 id 在 invalidate 集合里"
    //   是错的。主动清掉,后续 loadFullNote 不会再被旧 id 干扰。
    clearInvalidated(id);
    // audit-r76:写入基线同步清 —— note id 由 relPath 派生(computeFileId),
    //   同名文件删后重建会复用 id;留着旧基线会让新文件的首次 loadFullNote
    //   被 stale 守卫误判(虽然 issuedAt 前提能兜住,语义上基线属于已删文件)。
    _writtenMtimeById.delete(id);
    _writtenAtById.delete(id);
    // audit 2026-10-08 (MEDIUM):失败草稿同步清理 —— id 已删,旧草稿无意义。
    clearFailedDraft(id);
    if (get().selectedId === id) {
      // 同时清掉 selectedId 与 activeNoteFull,避免 UI 仍渲染已删笔记。
      // 实际删除后下次 NOTES_CHANGED → load() 会让 notes 数组里也没了这条,
      // selectedId 指向空 id 时 NotesView effect 会进 !note 分支。
      set({ selectedId: null, activeNoteFull: null });
    }
    await get().load();
  },
  save: async (id, body, title) => {
    // audit 2026-10-08 (HIGH):expectedMtime 透传 —— 防外部修改被静默覆盖。
    //   loadFullNote 时 activeNoteFull.mtime 是当时磁盘 mtime;save 时回传给
    //   主进程比对当前磁盘 mtime,不一致抛 CONFLICT。这里 mtime 来自 in-memory
    //   activeNoteFull.mtime(loadFullNote 读到的快照),与 StandaloneNote.mtime
    //   同一来源(底层都是 cachedReadParse 的 stat mtimeMs)。
    //   activeNoteFull 为 null(load 还没回来)/ id 不匹配 → 不传 expectedMtime,
    //   走 last-writer-wins 兜底(老 caller 行为,向后兼容)。
    const cur = get().activeNoteFull;
    // audit 2026-10-21 (P0):被搬移/改名过的 id 不带 expectedMtime ——
    //   主进程 repin 重写了文件,磁盘 mtime 必然变,而 renderer 手里的是搬移
    //   前的旧值 ⇒ 拿它比对必报**假 CONFLICT**(「文件被外部修改」,其实是我
    //   们自己搬的)。这类写入走 last-writer-wins:搬移是我们自己发起的,
    //   不存在「覆盖外部改动」的风险。见 _mtimeStaleIds 声明。
    const expectedMtime = cur && cur.id === id && !_mtimeStaleIds.has(id) ? cur.mtime : undefined;
    let note;
    try {
      note = unwrap(await api.writeNote(id, body, title, expectedMtime));
    } catch (err: unknown) {
      // audit 2026-10-08 (HIGH):CONFLICT 走冲突提示路径 —— 主进程抛的 code
      //   经 unwrap 抛 IpcError。toast 让用户明确知道保存被拒,而不是 silent fail。
      //   invalidate(id) 把 id 标 dirty,下次 loadFullNote 看到强制 re-fetch
      //   (activeNoteFull 旧 body 不再被信任)。loadFullNote 成功时拿到磁盘
      //   权威版本,用户对照查看外部修改。
      if (err instanceof IpcError && err.code === 'CONFLICT') {
        invalidate(id);
        useToast.getState().show({
          type: 'error',
          message: i18next.t('notes.saveConflictToast'),
        });
        // 触发一次 readNote 拿最新版本(失败也无所谓,toast 已经告知)。
        // 不用 await —— save() 应该把冲突快速抛回 caller,re-fetch 是 best-effort。
        get()
          .loadFullNote(id)
          .catch((e: unknown) => log.warn('post-conflict reload failed', errMsg(e)));
        throw err;
      }
      // audit 2026-10-08 (LOW):其它写错误 IO_ERROR / IPC_REJECTED 等 —— 把
      //   body / title 暂存到 failedDrafts,user 重启或重新打开笔记时可恢复。
      //   failedDrafts 由 StandaloneNoteEditorCore 模块持有,这里通过 save()
      //   抛错让上层(Editor)自己处理 stash 动作 —— Editor 的 doSave catch
      //   块已经会读 err.code,这里只 re-throw 把控制权交回。
      throw err;
    }
    // 记录「最近一次成功写入的 mtime」—— loadFullNote 用它判断 stale read,
    // 防止落盘读回的旧 body 覆盖本次写入的乐观新值(见 _writtenMtimeById 注释)。
    _writtenMtimeById.set(note.id, note.mtime);
    // audit-r76:写落地的墙钟时刻 —— stale read 判定需要「读发出 < 写落地」
    // 前提(见 _writtenAtById 声明处注释)。取响应落地此刻而非请求发出时刻:
    // 读与写并发的重叠期才算 stale 窗口。
    _writtenAtById.set(note.id, Date.now());
    // r192:id 漂移 —— 主进程保存时可能返回**与请求不同的 id**。
    //   触发条件:笔记文件里的 frontmatter id 与「当前 relPath 的哈希」不一致。
    //   extractNoteId(note-id.ts)优先取磁盘上的 fm.id(兼容旧文件),而
    //   writeNote(standalone.ts)保存时会把 fm.id **重钉**为
    //   computeFileId(relPath)(r124 规则)⇒ 保存后 id 变了。现实来源:
    //     - 用户在资源管理器里改了文件名 / 移动了文件(fm.id 还是旧路径哈希);
    //     - 从别的机器 / 别的工具拷进来的 .md(自带别的路径的 fm.id);
    //     - 手改过 frontmatter。
    //   不跟的后果(用户明确禁止的「造成数据丢失」):
    //     主进程已删掉旧 byId 键 + 旧 DB 行,renderer 还拿着旧 id ⇒
    //     **下一次自动保存必撞 NOT_FOUND** ⇒ 正文只进 failedDrafts(纯内存)
    //     ⇒ 重启即丢;用户看到的只是「保存失败」红 badge。
    if (note.id !== id) {
      applyIdDriftRemap(set, get, id, note);
    }
    // perf (2026-09-04):本地乐观更新 — 用返回的 note 直接 patch 当前数组,
    // 不再走 listNotes IPC roundtrip。NOTES_CHANGED 推送稍后会触发 broadcast
    // listener 的 load() 拿权威版本做最终一致;少了 1 次 IPC roundtrip 是
    // 体感明显的优化(每条笔记保存 ~10–50ms 节省)。
    // perf (2026-09-06):patch 改成 summary —— listNotes 返回 summary,
    //   notes 数组里的旧对象也是 summary,直接用 toNoteSummary(note) 替换。
    const notes = get().notes;
    const idx = notes.findIndex((n) => n.id === note.id);
    if (idx >= 0) {
      const next = [...notes];
      next[idx] = toNoteSummary(note);
      set({ notes: next });
    }
    // activeNoteFull 也同步:body / title 走最新值,免得编辑器本地态与服务
    // 端权威值不同步。
    // audit-r124:判定必须用 **apply 时刻** 的 activeNoteFull,而不是 await
    //   之前捕获的 cur —— IPC 往返(~5-50ms)期间用户可能已切到另一篇笔记,
    //   cur 仍指向旧笔记,按 cur 判定会把「当前正在编辑的另一篇」的 active
    //   full 覆写成刚保存完的旧笔记(编辑器串内容)。cur 只在上方
    //   expectedMtime 处用(那里语义就是「请求发出时的快照」,正确)。
    //   原注宣称「null / 其它 id 都不动」与两代实现均不符(旧 cur 判定在
    //   null 窗口照样播种,notes-store-save-loadfull-race 测试锁定的正是该
    //   乐观播种):此处保留 null(重载在飞)→ 播种的旧语义,仅修「现值为
    //   另一篇非空 full」这一真实串内容形态;null 窗口指向哪篇无法区分,
    //   由 loadFullNote 的 mtime 守卫在 read 到达时收敛到磁盘权威值。
    const nowFull = get().activeNoteFull;
    if (!nowFull || nowFull.id === note.id) {
      set({ activeNoteFull: note });
    }
    // r218:无缓存可失效 —— 下一次 list 恒走新 IPC(序号守卫)。
    // perf(2026-09-04):标记最近一次自写时间戳 —— 主进程广播 NOTES_CHANGED 后,
    // 监听器看到在窗口期内就跳过 load(),避免 1 次保存 = 2 次 IPC + 2 次
    // 全列表 setState。autosave(默认 1s 防抖)在用户持续敲键盘时几乎每秒
    // 触发一次,这部分 IPC + 100+ 行 notes 重渲是体感明显的卡顿来源。
    markSelfWrite();
    return note;
  },
  renameFile: async (id, newFilename) => {
    const note = unwrap(await api.renameNoteFile(id, newFilename));
    // audit 2026-10-21(P0 数据丢失):改名同样会换 id(主进程把 frontmatter id
    //   重钉为新 relPath 的哈希,standalone.ts renameNote)⇒ 旧 id 成了死键。
    //   登记映射,让编辑器把未落盘内容按**新 id**写(旧 id 写必然 NOT_FOUND
    //   ⇒ 内容进不了可取回的草稿 ⇒ 永久丢字)。见 lib/note-id-remap.ts。
    registerIdRemap(id, note.id);
    // 改名同样重写了文件(repin)⇒ 磁盘 mtime 变了 ⇒ 新 id 的 mtime 基线失效
    //   ⇒ 在下一次 loadFullNote 刷新之前,保存不带 expectedMtime(避免假
    //   CONFLICT)。见 _mtimeStaleIds 声明。
    _mtimeStaleIds.add(note.id);
    // audit 2026-09-10:清掉旧 id 的 invalidate —— id 已变,旧 id 在 set 里
    //   残留不再有意义(后续 loadFullNote 用的是新 id)。
    clearInvalidated(id);
    // audit-r76:写入基线同属旧 id,一并清(同 trash 处注释;且旧 relPath 名
    //   日后被重建复用 id 时不会继承已失效的写入基线)。
    _writtenMtimeById.delete(id);
    _writtenAtById.delete(id);
    // audit 2026-10-08 (MEDIUM):失败草稿同步清理 —— 旧 id 已变,旧草稿
    //   留着会让用户切回 note 看不到磁盘真实内容(草稿优先于磁盘)而新
    //   id 没草稿(若用户已编辑过新版会重新落盘)。这里清旧 id 即可。
    clearFailedDraft(id);
    // r193:**先**记下旧 id 当时在不在选择里 / 是不是锚点,再 reload。
    //   顺序很关键:reload 会按「只留活着的 id」把旧 id 剔掉(改名后旧 id
    //   已经死了),所以**必须**在 load 之前取快照,否则 load 之后再问
    //   「selectedIds 里还有没有旧 id」永远是 false ⇒ 多选里的那一篇
    //   改名后**静默掉出选择**(用户以为还选着,实际作用集少一条)。
    //   与 literature 域的 applyLitMoveRemapImpl 同款语义。
    const wasSelected = get().selectedIds.has(id);
    const wasAnchor = get().anchorId === id;
    const wasActive = get().selectedId === id;
    // audit round 20 (2026-08-22):先 reload 再更新 selectedId。
    // 旧顺序(selectedId 先变 → load 后跑)会让中间存在一帧
    // selectedId=新 id 但 notes 数组还只有旧 id,UI 上 editor 暂时空。
    // 把 load 提前 → selectedId 变化时 notes 数组已含新条目。
    await get().load();
    // r193:多选 / 锚点跟着换 id(快照在上面 load 之前取的)。
    if (wasSelected) {
      const nextSel = new Set(get().selectedIds);
      nextSel.delete(id);
      nextSel.add(note.id);
      set({ selectedIds: nextSel });
    }
    if (wasAnchor) {
      set({ anchorId: note.id });
    }
    // 重命名后 id 变化,之前选中的 id 如果就是这个 note,切到新 id
    if (wasActive) {
      // id 已变(activeNoteFull 是旧 id 的,直接清掉),等 NotesView effect 触发
      // loadFullNote(newId) 把新 body 拉回来。
      set({ selectedId: note.id, activeNoteFull: null });
    }
    return note;
  },
  showInFolder: async (id) => {
    // 失败抛 IpcError,调用方(右键菜单 handler)catch 后 toast。
    // 不动 selectedId / activeNoteFull —— 只是打开 OS 文件管理器,与当前
    // 选中状态无关。
    unwrap(await api.showNoteInFolder(id));
  },
  importFromFile: async (filePath) => {
    const result = unwrap(await api.importNoteFromFile(filePath));
    // 不主动 load():createNote 内部 emit('changed') → NOTES_CHANGED 监听器
    //   触发 useNotesStore.load() 拿最新列表(监听器对 _lastSelfWriteTs
    //   < SELF_WRITE_SUPPRESS_WINDOW_MS 的"自写"才跳过 —— createNote
    //   没有走 markSelfWrite,所以这里正常走 load,与现有 save() 的优化
    //   路径不冲突)。
    return result;
  },
  // 流式更新场景:AI 推回 StandaloneNote 时同步 summary 到 notes 数组。
  // 不动 cache.value —— 后面 NOTES_CHANGED 广播会触发 listNotes 自然走通。
  updateSummary: (note) => {
    const notes = get().notes;
    const idx = notes.findIndex((n) => n.id === note.id);
    if (idx < 0) return;
    const next = [...notes];
    next[idx] = toNoteSummary(note);
    set({ notes: next });
  },
  // audit-r143:reorder 落地 —— orderedIds 是父级按当前可视顺序拼出的
  //   完整序列(已剔除被拖项,已在目标位置 splice 进去)。重写 0..N-1
  //   连续整数(任一 id 漏都给 +∞ 后续 drop 时落底);写一次
  //   localStorage,失败吞(quota / disabled)。与 set 同一个 micro-task
  //   落库,避免 store 内存已更新但 localStorage 漏写 → 重启顺序回退。
  reorderByIds: (orderedIds) => {
    const next: DisplayOrderMap = {};
    for (let i = 0; i < orderedIds.length; i++) {
      const id = orderedIds[i];
      if (typeof id === 'string' && id.length > 0) {
        next[id] = i;
      }
    }
    set({ displayOrderById: next });
    saveOrder('note', next);
  },
  // r168:公开 applyMoveRemap —— drag-into-folder 路径(走 disk hook 的
  //   handleTargetDrop,不走本 store action)成功后回调到这里,把
  //   selectedId / activeNoteFull 跳到新 id(同 paste(cut) / moveToFolder
  //   内部隐式调用的 helper)。disk 路径编辑器漂移问题一并解决,user 编辑
  //   中的笔记被 drag 移走后编辑器不会卡在旧 id 上报 NOT_FOUND toast。
  applyMoveRemap: (idRemap) => {
    applyMoveRemapImpl(set, get, idRemap);
  },
}));

// r168:helper 实现 —— r167 私有 applyMoveRemap 升级成 applyMoveRemapImpl
//   函数,store action applyMoveRemap 包外暴露给 drag 路径,同时
//   paste(cut) / moveToFolder 内部 helper 也指向同一函数(消除重复)。
function applyMoveRemapImpl(
  set: (partial: Partial<NotesState>) => void,
  get: () => NotesState,
  idRemap: Map<string, { id: string; relPath?: string; absPath?: string }>,
): void {
  if (idRemap.size === 0) return;
  const cur = get();
  // audit 2026-10-21(P0 数据丢失):登记旧→新 id 的映射。编辑器正在编辑的那篇
  //   若被搬走,它的未落盘内容必须按**新 id**落盘 —— 旧 id 在主进程已经是死键
  //   (byId.delete(oldId),service.ts applyNoteIdSwap),按旧 id 写必撞
  //   NOT_FOUND ⇒ 内容只进 failedDrafts(旧 id 键)⇒ 而笔记现在的新 id 取不到
  //   那份草稿 ⇒ 这段字永久消失。登记表见 lib/note-id-remap.ts。
  for (const [oldId, v] of idRemap) {
    registerIdRemap(oldId, v.id);
    // 搬移同样重写了文件(repin)⇒ 新 id 的 mtime 基线失效 ⇒ 在下一次
    //   loadFullNote 刷新之前,保存不带 expectedMtime(避免假 CONFLICT)。
    //   见 _mtimeStaleIds 声明。
    _mtimeStaleIds.add(v.id);
  }
  // audit 2026-10-21(P0):notes[] 列表本身也必须跟着换 id。旧实现只刷
  //   selectedId / selectedIds / activeNoteFull,数组里仍留着**死 id** ⇒
  //     1) NotesView 的 summary = notes.find(n => n.id === selectedId) 找不到
  //        ⇒ 渲染「笔记已不可用」空态(文案与事实相反:用户刚自己归档的笔记),
  //        而且编辑器整条链被卸载 ⇒ 未落盘内容走卸载 flush ⇒ 落进旧 id;
  //     2) 侧栏那一行的 id 是死的 ⇒ 点它必然 NOT_FOUND。
  const nextNotes = remapNoteSummaries(cur.notes, idRemap);
  // r175:复数选中集也要跟着搬 —— 旧实现只刷单数 selectedId,多选搬移后
  //   selectedIds 里留着已不存在的旧 id。窗口期内(NOTES_CHANGED 推送触发
  //   load() 清空 selectedIds 之前,约 50~500ms)用户按 Delete / Ctrl+X:
  //     - cut/copy:ids = notes.filter(n => selectedIds.has(n.id)) → 空 → 剪贴板不落
  //     - trash:按 selectedIds 过滤 → 一条都删不掉(静默无反应)
  //   重映射逻辑抽到 lib/move-remap.ts(notes / literature 两域共用一份)。
  const nextSelectedIds = remapSelectedIds(cur.selectedIds, idRemap);
  const nextSel = cur.selectedId ? idRemap.get(cur.selectedId) : undefined;
  if (!nextSel) {
    // selectedId 不在本次搬移集合内 —— 但复数选中集可能仍然命中,单独刷。
    set({
      notes: nextNotes,
      ...(nextSelectedIds ? { selectedIds: nextSelectedIds } : {}),
    });
    return;
  }
  // notes 域 invariant:notesMove IPC 响应必含 relPath,relPath 为空仅可能在
  //   miswired caller(此时 selectedId 已跳到新 id 但 activeNoteFull/relPath
  //   无法同步),保守静默 return 不刷 activeFull(避免脏数据)。
  if (!nextSel.relPath) {
    set({
      notes: nextNotes,
      selectedId: nextSel.id,
      ...(nextSelectedIds ? { selectedIds: nextSelectedIds } : {}),
    });
    return;
  }
  const newBase = nextSel.relPath.split('/').pop() ?? nextSel.relPath;
  const nextFull =
    cur.activeNoteFull && cur.activeNoteFull.id === cur.selectedId
      ? {
          ...cur.activeNoteFull,
          id: nextSel.id,
          relPath: nextSel.relPath,
          filename: newBase,
        }
      : cur.activeNoteFull;
  set({
    notes: nextNotes,
    selectedId: nextSel.id,
    activeNoteFull: nextFull,
    ...(nextSelectedIds ? { selectedIds: nextSelectedIds } : {}),
  });
}

/**
 * 把 notes[] 摘要里的旧 id 换成新 id(搬移 / 改名后)。
 *
 * 摘要本身(标题 / mtime / tags)属于**同一个文件**,搬移不改变它们 ⇒ 只换
 * id / relPath / filename 三个「定位字段」。
 *
 * @returns 命中任何一条时返回**新数组**(引用变了,React 才认得出变化);
 *          一条都没命中时原样返回(不制造无谓的重渲)。
 */
function remapNoteSummaries(
  notes: StandaloneNoteSummary[],
  idRemap: Map<string, { id: string; relPath?: string; absPath?: string }>,
): StandaloneNoteSummary[] {
  if (idRemap.size === 0) return notes;
  let changed = false;
  const next = notes.map((n) => {
    const r = idRemap.get(n.id);
    if (!r) return n;
    changed = true;
    const relPath = r.relPath ?? n.relPath;
    const filename = relPath.split('/').pop() ?? relPath;
    return { ...n, id: r.id, relPath, filename };
  });
  return changed ? next : notes;
}
// r192:id 漂移重映射 —— 主进程保存时把 frontmatter id 重钉为「当前 relPath
//   的哈希」(standalone.ts 的副本重映射规则),返回的 note.id 可能与请求的
//   id 不同。详见 save() 里的说明:不跟 ⇒ 下一次自动保存必撞 NOT_FOUND ⇒
//   正文只进内存草稿 ⇒ 重启即丢。
//
//   与 applyMoveRemapImpl(搬移 / 改名的 id 重映射)是**同一类**问题:
//   「主进程给了一个新 id,renderer 的所有以 id 为键的状态都得跟上」。
//   差别只在触发时机与规模:搬移一次改一批,id 漂移一次只改一个(但它发生在
//   **保存**路径上 ⇒ 后果是丢字,比搬移更严重)。
function applyIdDriftRemap(
  set: (partial: Partial<NotesState>) => void,
  get: () => NotesState,
  oldId: string,
  next: StandaloneNote,
): void {
  const newId = next.id;
  const cur = get();
  // 1) 列表行:旧 id 那一行换成新 id 的 summary。
  //   注意:不能只依赖 save() 后面的乐观 patch —— 那里按 **新 id** 查找,
//   数组里此刻还是旧 id ⇒ 找不到 ⇒ 行不更新(行留在旧 id 上 ⇒ 侧栏点开
  //   拿死 id ⇒ NOT_FOUND)。
  const idx = cur.notes.findIndex((n) => n.id === oldId);
  const notes =
    idx >= 0
      ? [...cur.notes.slice(0, idx), toNoteSummary(next), ...cur.notes.slice(idx + 1)]
      : cur.notes;
  // 2) 单选 / 锚点 / 多选 —— 三处都以 id 为键
  const selectedId = cur.selectedId === oldId ? newId : cur.selectedId;
  const anchorId = cur.anchorId === oldId ? newId : cur.anchorId;
  let selectedIds = cur.selectedIds;
  if (selectedIds.has(oldId)) {
    const s = new Set(selectedIds);
    s.delete(oldId);
    s.add(newId);
    selectedIds = s;
  }
  // 3) 正在编辑的那篇:换成主进程返回的这份(body 即刚落盘的内容)。
  //   同时让下一次 save 的 expectedMtime 对得上(它要求
  //   activeNoteFull.id === 请求 id,否则退化成 last-writer-wins)。
  const activeNoteFull =
    cur.activeNoteFull && cur.activeNoteFull.id === oldId ? next : cur.activeNoteFull;
  set({ notes, selectedId, anchorId, selectedIds, activeNoteFull });
  // 4) 以 id 为键的模块级状态:旧 id 全部作废
  //    - invalidate 标记:旧 id 已死,留着会让后续 loadFullNote(旧 id)永远
  //      走强制重拉路径;
  //    - 写入基线(mtime / 落盘时刻):基线属于「那一次写入」,旧 id 的基线
  //      留着会污染日后同名文件复用该 id 时的 stale 判定;
  //    - 失败草稿:内容已落盘,草稿是更旧的版本 ⇒ 清掉(否则下次选中这篇
  //      会用草稿覆盖磁盘上更新的内容)。
  clearInvalidated(oldId);
  _writtenMtimeById.delete(oldId);
  _writtenAtById.delete(oldId);
  clearFailedDraft(oldId);
}
// 防御:loadFullNote 内部 catch 时调用 —— 不向用户层冒泡(选笔记失败属内部错误,
// 但仍要记到 console 便于排查 IPC / main 进程错误)。
// perf(2026-09-04):自写标记 —— NOTES_CHANGED 监听器在 save() 触发的窗口期内
// 跳过 load()。autosave 高频(每 ~1s)时省下 1 次 listNotes IPC + 整数组
// JSON.parse + setState(引起 NotesList 全列表 re-render)。
//   - **500ms 与 literature 的 200ms 刻意不同,勿「统一」(r221 对账)**:
//     save() 走乐观 patch、**不自己 load**,窗口必须盖过 **watcher echo**
//     (主进程 chokidar awaitWriteFinish 50ms + reload 去抖 100ms + scan/广播
//     ≈ 写后 150~400ms);收到 200ms 会让 watcher echo 漏出窗口 ⇒ 每秒
//     autosave 都多一次全量拉 + 全列表重渲(本优化失效)。literature 的
//     writer 自己 force load,窗口只需盖同步 echo,它的 watcher echo
//     (awf 200ms + 去抖 100ms ≥ 300ms)本来就盖不住、漏出来当 no-op 兜底
//     —— 见 literature.ts 的 SELF_WRITE_SUPPRESS_WINDOW_MS 注释。
//   - 代价侧:窗口内的**外部**变更(其他窗口 / 外部编辑器)会被当成自写
//     echo 吞掉(跳过 load + invalidate),窗口越宽外部变更可见越迟 ——
//     500ms 是「autosave 高频省 IPC」与「外部变更可见延迟」的折中。
//   - create / remove / renameFile 走自己的 await get().load(),不依赖
//     监听器,不受此逻辑影响 —— 用户主动操作的低频路径不被吞。
//   - 窗口外的 NOTES_CHANGED(其他窗口写入 / chokidar / 外部编辑)仍会
//     触发 load() + invalidate(selectedId),不被吞。
const SELF_WRITE_SUPPRESS_WINDOW_MS = 500;
let _lastSelfWriteTs = 0;

function markSelfWrite(): void {
  _lastSelfWriteTs = Date.now();
}

// audit 2026-09-10:外部 NOTES_CHANGED 引起的"selectedId body 失效"标记。
//   Set 持有被外部改动但 activeNoteFull 还没刷新的笔记 id;loadFullNote
//   看到 isInvalidated(id) 就跳过 early-return,强制 readNote 拿最新。
//   re-fetch 成功后 clearInvalidated(id) 清掉,恢复正常 early-return。
const _invalidatedNoteIds = new Set<string>();

function invalidate(id: string): void {
  _invalidatedNoteIds.add(id);
}

function clearInvalidated(id: string): void {
  _invalidatedNoteIds.delete(id);
}

function isInvalidated(id: string): boolean {
  return _invalidatedNoteIds.has(id);
}

// 模块级自初始化:订阅 NOTES_CHANGED 推送,保证任何地方 useNotesStore() 拿到的都是最新数据
// 设计要点:
//   - 仅订阅副作用(api.onNotesChanged 是回调注册,无网络/IO),不在模块顶层调 load()
//   - 首次拉取由 App.tsx 在 useEffect 中显式触发,避免 jsdom 测试环境里
//     `vi.mock` 还没装好就触发 IPC 的时序问题
//   - 防御式:仅在 window.api 存在时订阅;测试环境/SSR 安全
//   - perf(2026-09-04):监听器跳过自写广播(详见 markSelfWrite 注释)。
//   摘监听只发生在 Vite HMR dispose(见文件底部),生产路径不摘。
let _unsubscribe: (() => void) | null = null;
let _initialized = false;

function _ensureInit(): void {
  if (_initialized) return;
  // 防御:测试环境或 preload 未挂载时不要硬订阅(避免抛错导致整个模块加载失败)
  if (
    typeof window === 'undefined' ||
    !window.api ||
    typeof window.api.onNotesChanged !== 'function'
  ) {
    return;
  }
  _initialized = true;
  _unsubscribe = window.api.onNotesChanged(() => {
    // 自写抑制窗口:save() 之后 ~500ms 内的广播(主进程 echo)跳过 load(),
    // 避免 autosave 高频路径上重复 IPC + 全列表重渲。窗口外的广播走正常路径,
    // 仍然 load() 拿到外部变更(其他窗口 / 文件系统 watch 等)。
    const isSelfEcho = Date.now() - _lastSelfWriteTs < SELF_WRITE_SUPPRESS_WINDOW_MS;
    if (isSelfEcho) {
      // 自写 echo 也跳过 invalidate —— 自己刚写的 body 不需要强制 re-fetch,
      // save() 末尾已经把 activeNoteFull patch 成最新值。
      return;
    }
    // audit 2026-09-10:外部 NOTES_CHANGED → 标记当前选中笔记 dirty,
    //   让 loadFullNote 下次被调到时强制 re-fetch。否则用户切到 B 再切回 A,
    //   early-return 直接用 stale body,下一句 autosave 覆盖外部编辑。
    const sel = useNotesStore.getState().selectedId;
    if (sel) invalidate(sel);
    // audit 2026-09-14:补 .catch —— 外部 NOTES_CHANGED 触发的 reload 与
    //   NotesList 初始 load 同源(listNotes IPC),失败路径前一致 —— 之前
    //   `void load()` 让 IPC 边界 throw 静默变 unhandled rejection,
    //   主进程 log 有 wrap.ts 一条,renderer 这边完全无 trace。补一条
    //   log.warn 让排查能看到"NOTES_CHANGED listener 入口"信号。
    useNotesStore
      .getState()
      .load()
      .catch((err: unknown) => log.warn('NOTES_CHANGED listener reload failed', err));
  });
}

// 模块加载时即尝试订阅(浏览器渲染进程单例,不需要等 React mount)
// esbuild 会保留顶层副作用,避免被 tree-shake 掉
_ensureInit();

// audit-r213:Vite HMR 自卸载 —— 镜像 store/literature.ts 的 r136 M7 同款修法
//   (dev 模式 vite-plugin-react 改任意 source file 都会触发 HMR 重渲本模块,
//   模块顶层副作用 `_unsubscribe = window.api.onNotesChanged(...)` 若不摘,
//   旧 listener 仍指向旧模块闭包 → leak + N 次热更后一次 NOTES_CHANGED 广播
//   触发 N 次并发 listNotes IPC 与 N 轮全列表重渲,监听器集合单调增长无法
//   回收 —— 生产路径从不摘监听)。`import.meta.hot
//   ?.dispose` 在 HMR 替换本模块前跑(标准 Vite API),摘掉旧 listener 让新一轮
//   _ensureInit 重订一次。生产 build import.meta.hot === undefined,自然不挂。
if (typeof import.meta.hot !== 'undefined') {
  import.meta.hot?.dispose(() => {
    if (_unsubscribe) {
      _unsubscribe();
      _unsubscribe = null;
    }
    _initialized = false;
  });
}
