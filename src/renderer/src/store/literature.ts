// 文献列表状态(audit-r71)—— resources 单表 lit 行的 renderer 侧。
//
// 与 store/notes.ts 的形态差异(有意为之):
//   - 无 activeFull 两级缓存:lit 行本身就是完整记录(无 body),列表全量
//     ~200B/条,一次 IPC 拿完;正文由 Reader 组件按 absPath 自行拉流。
//   - 无 TTL 缓存(notes 那边 library 时代 TTL 吃过 HIGH 事故,这里干脆
//     只留 in-flight 去重):并发 load() 共享同一个 promise,但绝不复用
//     已完成的结果 —— 每次「新发起的 load」都真发 IPC。
// audit-r73 (2026-10-17):in-flight 去重加 force 出口 + 序号守卫(favorites
//   store 2026-10-01 同款):
//   - 竞态:import/delete 落盘后 `void load()` 可能并进一个**写入之前**就发出
//     的在飞请求(挂载 load / 上一轮 force load),拿回旧快照 → 新文献永远不
//     出现(本域无 push 通道,没有任何后续刷新会纠正它)。
//   - 修:写后重拉一律 `load({ force: true })`(不复用 in-flight);所有请求带
//     单调序号,返回时序号已被更新的请求应用过就直接丢弃 —— 旧快照不可能
//     覆盖新快照。
// audit-r136:加 push 订阅 + self-write 抑制窗口 —— 镜像 notes.ts:628-714。
//   触发动机:用户报「OS 拖入 / 外部修改文献目录,UI 不刷新」,根因 literature
//   域 v1 无 changed 通道。修法:主进程 LiteratureService 监听 <rootPath>/literature/
//   + 推 LITERATURE_CHANGED;renderer 端 onLiteratureChanged listener 在 200ms
//   self-write 窗口内(自写 IPC 落盘 + 自身 force load 的 echo)跳过 load(),
//   避免重复 roundtrip;窗口外的广播(chokidar 触发 / 其他窗口写入)走正常路径
//   load({ force: true }) 拉新列表。
//   「mount 时 listener 未注册」的竞态:由**先订阅再 load**覆盖 —— 订阅在模块
//   顶层 _ensureInit() 里(严格早于任何组件挂载),首次 load 在 LiteratureList
//   的 useEffect 里 ⇒ 订阅永远早于首次拉取,不存在漏事件窗口。
//   audit-r211:原设计的 literatureGetState pull 通道(与 listLiterature 同源
//   同形的空壳,renderer 从未调用)已整对下线。literature 无 activeNoteFull 缓存,
//   不需要 invalidate 逻辑 —— listener 简化为「自写跳过 + force load」。
import { create } from 'zustand';
import type { LiteratureResource, ResourceId } from '@shared/types';
import type { LiteratureImportResult, LiteratureRenameResult } from '@shared/api-types';
import { api, unwrap, IpcError } from '../lib/api';
import { createLogger } from '../lib/logger-client';
import { errMsg } from '../lib/error';
// audit-r143 (2026-10-19):侧栏自定义排序 —— displayOrderById 是 UI 偏好,
//   持久化到 localStorage(同 useResizablePanel workbench 宽度的位置)。
//   不污染 SQLite schema / IPC / 资源类型。
import { loadOrder, saveOrder, type DisplayOrderMap } from '../lib/order-persistence';
import { consumeMovedFromClipboard } from './_clipboard-consume';
import { shareUnchanged } from '../lib/struct-share';
import { remapSelectedId, remapSelectedIds } from '../lib/move-remap';

const log = createLogger('useLiteratureStore');

interface LiteratureState {
  /** 全量 lit 行(含 0005 迁移旧行;absPath 可能指向已移走的旧库文件)。 */
  items: LiteratureResource[];
  /** 当前选中文献行 id — WorkbenchContentPanel 据此驱动 Reader。 */
  selectedId: ResourceId | null;
  loading: boolean;
  /** load 失败信息 — 列表空态区分「没有文献」与「拉取失败(retry)」。 */
  lastError: string | null;
  // 多选 + 剪贴板(2026-10-18,与 store/notes.ts 同款 VS Code 语义):
  // selectedIds 是文件操作作用集,与驱动 Reader 的 selectedId 解耦。
  /** 多选集合 — 剪切/复制/删除的作用范围。 */
  selectedIds: Set<string>;
  /** Shift 范围选择锚点(Shift+击 不更新)。 */
  anchorId: string | null;
  /** 剪贴板(in-memory,重启即丢)。 */
  clipboard: { ids: string[]; mode: 'copy' | 'cut' } | null;
  // audit-r143:自定义排序 —— 资源 id → 视觉顺序(小者靠前)。未登记项落到
  //   +Infinity 之后(列表底部),保证旧库 / 漏登记都不挤前。
  displayOrderById: DisplayOrderMap;
  load: (opts?: { force?: boolean }) => Promise<void>;
  select: (id: ResourceId | null) => void;
  /** 单击:selectedIds={id},anchorId=id。 */
  selectOnly: (id: string) => void;
  /** Ctrl/Cmd+击:切换成员,anchorId=id。 */
  toggleSelect: (id: string) => void;
  /**
   * Shift+击:anchor→id 闭区间;无 anchor 退化为 selectOnly。
   *
   * @param visibleIds **当前可见**的行 id(按渲染顺序)。传了就以它为区间口径,
   *   不传则退回 store 数组顺序(全库 mtime 倒序)。
   *   audit-r243:必须传 —— 「仅收藏」视图 / 搜索过滤下,store 数组里夹着
   *   **屏幕上看不到**的行;拿 store 顺序切区间会选中它们,随后的 Delete
   *   会把用户从没见过、也没打算选的文件一并移进回收站。
   */
  selectRange: (id: string, visibleIds?: readonly string[]) => void;
  clearSelection: () => void;
  /** 整体替换选择(Ctrl+A 全选场景):selectedIds=ids,anchorId 不动。 */
  selectMany: (ids: string[]) => void;
  /** 剪切:ids 按列表顺序;空选择 no-op。 */
  cut: () => void;
  /** 复制:ids 按列表顺序;空选择 no-op。 */
  copy: () => void;
  /**
   * 粘贴到目标磁盘目录(r161+ disk-folder;undefined/null = kind 根)。
   * - cut:循环 api.litMove(id, targetRelPath) 逐条原子移动;全部成功
   *   才消费剪贴板并 force load;任一失败抛错且剪贴板保留可重试。
   *   错误形态与 useDiskFolderSidebar.moveItems 一致 —— 单条 reject 累计
   *   到 errors,首个 throw(同 notes paste 范式,r166 重写)。
   * - copy:从源 absPath 重新拷入(api.importLiteratureFromFile,撞名自动
   *   `name (1).ext`),targetRelPath 非空时再循环 api.litMove 把刚导入
   *   的副本批量移入目标;移动部分失败抛错,import 部分已落定的让用户
   *   在 UI 看到。可重复粘贴,剪贴板保留。
   * (r166 重写:旧实现 cut 分支只清剪贴板不调 IPC,Phase 2 stub;
   *   本轮 store paste 自走 IPC,与 useDiskFolderSidebar.moveItems 错误
   *   形态一致。行为锁 tests/unit/renderer/store/lit-cut-paste.test.ts
   *   (r167 建,audit-r229 核对指针:原先指向的 literature-store-clipboard.test.ts
   *   从未存在,真实守卫文件名是 lit-cut-paste.test.ts —— 指针过期,非守卫缺失)。)
   */
  paste: (targetRelPath?: string | null) => Promise<void>;
  /**
   * 把资源行批量搬到目标目录(r161+ disk-folder;与 paste(cut) 走同一 IPC)。
   * 走 api.litMove(id, target) 单条原子 + 累计 errors,首个 throw;剪贴板
   * 走 consumeMovedFromClipboard 统一处理(全命中清空 / 部分剩余 / copy
   * 不动)。r166 从 throw 占位改为真实实现,签名同步改为 Promise<void>。
   */
  moveToFolder: (
    ids: string[],
    targetRelPath: string | null,
  ) => Promise<Map<string, { id: string; absPath?: string }>>;
  /** 拷入式导入:成功后自动重拉列表,返回结果供 UI toast / select。
   *  r161+ disk-folder:目标目录由调用方(LiteratureList.importFiles)在
   *  拿到 result 后追加 api.litMove(result.id, currentRelPath) 接管,
   *  本签名不暴露 folderId。 */
  importFromFile: (sourceAbsPath: string) => Promise<LiteratureImportResult>;
  /**
   * r187:重命名单个文献文件(只改文件名,保留所在目录)。
   *   lit id = 'lit:'+posix absPath ⇒ 改名后 id 必变 ⇒ 选中态(单选 +
   *   多选)必须跟到新 id,否则右侧 reader 还指着已不存在的旧 id。
   *   与 notes 域 renameFile 同款流程:先落盘 → 重拉列表 → 跟选中态。
   */
  renameFile: (id: ResourceId, newFilename: string) => Promise<LiteratureRenameResult>;
  /** 删除:主进程删行 + 条件 unlink;选中项被删时清 selectedId。 */
  remove: (id: ResourceId) => Promise<void>;
  // audit-r143:reorder 拖拽落地 —— 父级(LiteratureList)按当前可视顺序拼出
  //   完整 id 序列,本 action 重写 0..N-1 连续整数并存 localStorage。
  reorderByIds: (orderedIds: string[]) => void;
  // r168:把一组 (oldId → newLit) 应用到 selectedId 上。
  //   用于 disk hook 的 handleTargetDrop 路径(drag 端不走 store action),
  //   走完 api.litMove 拿 idRemap 回调到本方法,把 store 侧 selectedId
  //   跳到新 id,避免 reader 重开时撞 NOT_FOUND。paste(cut) / moveToFolder
  //   路径内部已隐式调,helper 只是外暴露给 drag 路径。
  applyMoveRemap: (idRemap: Map<string, { id: string; absPath?: string; relPath?: string }>) => void;
}

/**
 * audit-r143:把 load() 拉回的 items 与旧 displayOrderById 对齐 —— 保留旧
 *   顺序(数值小 = 靠前),丢失的 id(已删 / 拉走)从 map 中剔除,新出现的
 *   id(导入 / 外部 push)暂不动(放到 +Infinity 之后,等 reorder 或重排
 *   触发后归位)。返回新 map,React 通过 Object.is / 引用比较触发重渲。
 */
function alignOrder(existing: DisplayOrderMap, items: LiteratureResource[]): DisplayOrderMap {
  const validIds = new Set<string>(items.map((r) => r.id));
  const next: DisplayOrderMap = {};
  for (const [id, order] of Object.entries(existing)) {
    if (validIds.has(id) && Number.isFinite(order)) {
      next[id] = order;
    }
  }
  return next;
}

// r167:literature 域 selectedId 重映射 —— literature 没有 activeLitFull 缓存
//   (PDF reader 按需开),只刷 selectedId 到 IPC 响应给的新 id。原理与 notes
//   applyMoveRemap 同源(文件系统层 fs.rename 后 id 重算),但 literature 域
//   副作用面更窄 —— 选中单 PDF 继续读时不会撞 NOT_FOUND。
function applyLitMoveRemapImpl(
  set: (partial: Partial<LiteratureState>) => void,
  get: () => LiteratureState,
  idRemap: Map<string, { id: string; absPath?: string; relPath?: string }>,
): void {
  if (idRemap.size === 0) return;
  const cur = get();
  // r175:复数选中集也要跟着搬 —— 与 notes 域 applyMoveRemapImpl 同款修复。
  //   旧实现只刷单数 selectedId,多选搬移后 selectedIds 里留着已不存在的旧
  //   id(cut / copy / delete 按 selectedIds 过滤 → 命中空集 → 静默无反应)。
  //   重映射逻辑抽到 lib/move-remap.ts(notes / literature 两域共用一份)。
  const nextSelectedIds = remapSelectedIds(cur.selectedIds, idRemap);
  const nextSelId = remapSelectedId(cur.selectedId, idRemap);
  if (!nextSelId) {
    // selectedId 为空 / 不在本次搬移集合内 —— 但复数选中集可能仍命中,单独刷。
    if (nextSelectedIds) set({ selectedIds: nextSelectedIds });
    return;
  }
  // 注:newId 在 ResourceId 类型上需要品牌化 —— IPC 返回的是 string,
  //   这里无成本 cast 走通 setter(consume 内部已用 string-keyed Map 跳过它)。
  set({
    selectedId: nextSelId as ResourceId,
    ...(nextSelectedIds ? { selectedIds: nextSelectedIds } : {}),
  });
}

// in-flight 去重:挂载 load 之间可共享一次 IPC;force(写后重拉)刻意不复用。
// 注意缓存的只是「进行中的 promise」,resolve 即清空 —— 下一次 load 永远真发。
let _inflight: Promise<void> | null = null;
// audit-r73 序号守卫:_issued 每请求 +1;_applied 记录已落地结果里最新的序号,
// 落后于它的响应直接丢弃(旧快照不得覆盖新快照)。
let _issued = 0;
let _applied = 0;

export const useLiteratureStore = create<LiteratureState>((set, get) => {
  const loadImpl = async (seq: number): Promise<void> => {
    set({ loading: true });
    try {
      const items = unwrap(await api.listLiterature());
      // audit-r73:迟到的旧请求(比如被 force 跳过复用的那次挂载 load)响应
      // 回来时更新的快照已落地 → 丢弃,不 set。
      if (seq < _applied) return;
      _applied = seq;
      // perf r258:结构共享(与 notes 域同款)—— IPC clone 回来的每条都是
      //   新对象 ⇒ store.items 每轮换引用 ⇒ 订阅它的 useShallow 浅比恒为
      //   「不等」⇒ 每次 LITERATURE_CHANGED 整个可见列表 + 每一行都重渲。
      //   把「字段全等」的条目换成上一轮那一份对象 ⇒ 引用不变 ⇒ 整表不
      //   重渲;变了的条目换新对象 ⇒ 只有那几行重渲。
      const mergedItems = shareUnchanged(get().items, items);
      set({
      items: mergedItems,
      lastError: null,
      loading: false,
      // audit-r143:同 set 内同时刷新 displayOrderById(atomic)—— alignOrder
      //   剔除已删的旧 id,保留旧顺序,新 id 不进 map(列表视图先落到
      //   +Infinity 之后),等下一次 reorder / 主动拖拽重排归位。
      displayOrderById: alignOrder(get().displayOrderById, mergedItems),
    });
    } catch (err: unknown) {
      if (seq < _applied) return;
      _applied = seq;
      log.warn('useLiteratureStore.load failed', errMsg(err));
      set({ lastError: errMsg(err), loading: false });
    }
  };
  return {
    items: [],
    selectedId: null,
    loading: false,
    lastError: null,
    selectedIds: new Set<string>(),
    anchorId: null,
    clipboard: null,
    // audit-r143:init 读一次 localStorage(任何 throw 都被 loadOrder 内部
    //   防御吞掉,返回 {} 兜底)。后续 load() set 块会调 alignOrder
    //   剔死 id;这里不做 align 是不想对空 items 跑一遍空操作。
    displayOrderById: loadOrder('literature'),
    load: (opts?: { force?: boolean }) => {
      if (!opts?.force && _inflight) return _inflight;
      const seq = ++_issued;
      const p = loadImpl(seq).finally(() => {
        // 只清自己那一次 —— force 请求不进 in-flight,不能把别人在飞的记录清掉
        // (favorites store 同款,见 store/favorites.ts audit 2026-10-01 注)。
        if (_inflight === p) _inflight = null;
      });
      if (!opts?.force) _inflight = p;
      return p;
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
      const { items, anchorId } = get();
      // audit-r243:区间口径 = **可见行顺序**(组件传 visibleItems 的 id 序);
      //   没传(理论上只有旧调用点)才退回 store 数组顺序。
      const order = visibleIds ?? items.map((r) => r.id);
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
      const { items, selectedIds } = get();
      const ids = items.filter((r) => selectedIds.has(r.id)).map((r) => r.id);
      if (ids.length > 0) set({ clipboard: { ids, mode: 'cut' } });
    },
    copy: () => {
      const { items, selectedIds } = get();
      const ids = items.filter((r) => selectedIds.has(r.id)).map((r) => r.id);
      if (ids.length > 0) set({ clipboard: { ids, mode: 'copy' } });
    },
    paste: async (targetRelPath) => {
      const clip = get().clipboard;
      if (!clip || clip.ids.length === 0) return;
      if (clip.mode === 'cut') {
        // r161+ disk-folder:r166 自走 IPC(api.litMove 单条原子),错误形态
        //   与 useDiskFolderSidebar.moveItems / notes paste(cut) 一致(逐条
        //   try/catch + errors 累计,首个 throw + 剪贴板保留可重试)。
        const target = targetRelPath ?? '';
        const errors: Array<{ id: string; code: string; message: string }> = [];
        // r167:同 notes paste(cut) —— 记录每次成功响应的 (oldId → newNote)
        //   用于下面对 selectedId 重映射。literature 域没有 activeLitFull
        //   缓存,只刷 selectedId。
        const idRemap = new Map<string, { id: string; absPath: string }>();
        for (const id of clip.ids) {
          try {
            const r = await api.litMove(id, target);
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
            `literature paste(cut) failed ${errors.length}/${clip.ids.length}: ${first.message}`,
          ) as Error & { code?: string; errors?: typeof errors };
          wrapped.code = first.code;
          wrapped.errors = errors;
          throw wrapped;
        }
        // 全部成功:消费剪贴板(全清)+ 自写抑制窗口 + force load
        consumeMovedFromClipboard(set, get, clip.ids);
        markSelfWrite();
        await get().load({ force: true });
        applyLitMoveRemapImpl(set, get, idRemap);
        // cut 模式保持原 id 选中(同 notes paste(cut))
        return;
      }
      // copy:从源文件重新拷入(import 自带撞名改名);absPath 失效的行跳过
      // Map key 用裸 string:clipboard.ids 是 string 域(ResourceId 品牌的
      // 超集),lookup 方向 brands 不兼容;ResourceId → string 天然可赋。
      const byId = new Map<string, LiteratureResource>(get().items.map((r) => [r.id, r]));
      const importedIds: string[] = [];
      // audit-r136 M2:部分失败容错 —— 旧实现在 for-loop 里裸调
      //   `unwrap(await api.importLiteratureFromFile(...))`,N 个文件中
      //   任一文件 IO 失败(EACCES / 锁文件 / 磁盘满) → 整个 await
      //   reject 抛出,后续文件全部不拷,已成功的部分不告知用户、剪贴
      //   板不更新、selectedIds 不刷新 —— 现象是「粘贴了 N 个结果只看到
      //   0 个」。修:try/catch 包每个 import,失败累计 errors,循环
      //   结束时给主进程推 toast 通知用户 N 成功 M 失败(失败不影响后
      //   续 + 不让 IPC reject 撞进 React unhandled rejection 链路)。
      //
      // audit-r170:失败不再由 store 内部推 toast —— 旧实现调的是
      //   `api.pushToast`,**preload 的 Api 接口里根本没有这个方法**
      //   (grep 零命中)→ 生产环境恒走 else 分支只 log.warn,用户完全
      //   看不到失败。改成与 notes paste(copy) 同款:累计 errors 后抛
      //   聚合错,由 LiteratureList.pasteTo 的 catch 统一 toast
      //   (literature.pasteFailedToast)。
      const errors: Array<{ id: string; code: string; message: string }> = [];
      for (const id of clip.ids) {
        const src = byId.get(id);
        if (!src) continue;
        try {
          const result = unwrap(await api.importLiteratureFromFile(src.absPath));
          importedIds.push(result.id);
        } catch (err: unknown) {
          errors.push({
            id,
            code: err instanceof IpcError ? err.code : 'INTERNAL',
            message: errMsg(err),
          });
        }
      }
      // r161+ disk-folder:目标目录非空时,刚导入的副本要批量移入目标目录。
      //
      // audit-r170 两处修正:
      //   1. **搬移后 id 会变** —— lit id = 'lit:'+toPosix(absPath),搬进子
      //      目录 absPath 变 → id 变。旧实现只判 `r.ok` 把 r.data.id 丢掉,
      //      末尾 `set({ selectedIds: new Set(newIds) })` 存的是**搬移前**的
      //      id → 选中的行在 UI 里根本不存在(点不开 / Reader 拿不到)。
      //      现在用搬后的 id(r.data.id)作为最终 id。
      //   2. 目标 = 根(null/undefined)时 import 本来就落根,无需搬移 ——
      //      旧实现的 `targetRelPath !== null` 判定恰好对,但语义没写清,
      //      现在统一成 `target = targetRelPath ?? ''`。
      // 搬移失败(同名 / IO)时副本仍留在 literature 根,id 未变 → 仍进
      // 选中集(用户能看到它),同时 errors 累计 → 末尾抛聚合错。
      const target = targetRelPath ?? '';
      const finalIds: string[] = [];
      if (target) {
        for (const importId of importedIds) {
          try {
            const r = await api.litMove(importId, target);
            if (r.ok) {
              finalIds.push(r.data.id);
            } else {
              errors.push({ id: importId, code: r.code, message: r.message });
              finalIds.push(importId); // 副本还在根,id 未变
            }
          } catch (err: unknown) {
            errors.push({ id: importId, code: 'INTERNAL', message: errMsg(err) });
            finalIds.push(importId); // 同上
          }
        }
      } else {
        finalIds.push(...importedIds);
      }
      // audit-r136:N 次 import 触发 chokidar N 次 'add' 广播;200ms 窗口
      //   内全部 echo skip,窗口外的才触发 force load。这是 paste 与其他
      //   writer 最大的不同 —— 高频连续写。
      markSelfWrite();
      await get().load({ force: true });
      set({ selectedIds: new Set(finalIds) });
      if (errors.length > 0) {
        const first = errors[0]!;
        const wrapped = new Error(
          `literature paste(copy) failed ${errors.length}/${clip.ids.length}: ${first.message}`,
        ) as Error & { code?: string; errors?: typeof errors };
        wrapped.code = first.code;
        wrapped.errors = errors;
        // copy 模式剪贴板保留可重试,已落定的副本已选中,用户在 UI 可见
        throw wrapped;
      }
    },
    // r161+ disk-folder:跨目录搬移 = 真实 fs.rename(走 api.litMove 单条
    //   原子)。与 paste(cut) 共享同一 IPC 路径 + 错误形态 + 剪贴板语义
    //   (r166 重写,原 throw 占位作废)。
    moveToFolder: async (ids: string[], targetRelPath: string | null) => {
      if (ids.length === 0) return new Map();
      const target = targetRelPath ?? '';
      const errors: Array<{ id: string; code: string; message: string }> = [];
      // r167:同 notes moveToFolder —— 记录 (oldId → newNote) 用于 selectedId 重映射。
      const idRemap = new Map<string, { id: string; absPath: string }>();
      for (const id of ids) {
        try {
          const r = await api.litMove(id, target);
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
          `literature moveToFolder failed ${errors.length}/${ids.length}: ${first.message}`,
        ) as Error & { code?: string; errors?: typeof errors; idRemap?: typeof idRemap };
        wrapped.code = first.code;
        wrapped.errors = errors;
        // r175:部分成功也要刷重映射(已搬走的 id 确实变了),并把映射挂到
        //   error 上,caller 在 catch 分支能取到已成功那部分的正确 id。
        wrapped.idRemap = idRemap;
        applyLitMoveRemapImpl(set, get, idRemap);
        throw wrapped;
      }
      consumeMovedFromClipboard(set, get, ids);
      applyLitMoveRemapImpl(set, get, idRemap);
      return idRemap;
    },
    importFromFile: async (sourceAbsPath) => {
      const result = unwrap(await api.importLiteratureFromFile(sourceAbsPath));
      // r161+ disk-folder:目标目录由 useDiskFolderSidebar 在导入时附加
      //   LITERATURE_MOVE 调用接管,本 store 不再直接调 moveResources。
      // audit-r136:自写标记 —— import 触发 chokidar 'add' 广播,200ms
      //   窗口合并掉(M3 收紧)。窗口外仍有 chokidar 'add' 残余广播触发的
      //   force load 是 no-op 兜底(force load 不复用 in-flight 但序号守卫
      //   拒旧快照)。
      markSelfWrite();
      // 写后重拉必须 force:并进的旧在飞请求拿到的是导入前快照(见头注 r73)。
      void get().load({ force: true });
      return result;
    },
    // r187:重命名 —— 与 moveToFolder 同款「先落盘,再跟 id」的流程。
    renameFile: async (id, newFilename) => {
      const result = unwrap(await api.litRenameFile(id, newFilename));
      // 自写标记:改名触发 chokidar 'unlink'+'add' 两次广播,200ms 窗口内
      //   合并掉(同 importFromFile / remove 的处理)。
      markSelfWrite();
      // 先重拉列表(items 里换成新 id),再把选中态跟过去 —— 顺序反了会出现
      //   「selectedId 已是新 id,但 items 里还是旧 id」的一帧空读。
      await get().load({ force: true });
      applyLitMoveRemapImpl(
        set,
        get,
        new Map([[id, { id: result.id, absPath: result.absPath }]]),
      );
      return result;
    },
    remove: async (id) => {
      unwrap(await api.deleteLiterature(id));
      if (get().selectedId === id) set({ selectedId: null });
      if (get().selectedIds.has(id)) {
        const next = new Set(get().selectedIds);
        next.delete(id);
        set({ selectedIds: next });
      }
      // audit-r136:自写标记 —— 后续 LITERATURE_CHANGED 广播在 200ms 窗口
      //   内被 listener 跳过(M3 收紧),避免与下方 force load 重复 roundtrip。
      markSelfWrite();
      void get().load({ force: true });
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
      saveOrder('literature', next);
    },
    // r168:把一组 (oldId → newLit) 应用到 selectedId 上 —— drag 路径专用。
    //   store 内部 paste(cut)/moveToFolder 已隐式调,本 action 仅作为
    //   useDiskFolderSidebar.handleTargetDrop 的回调目标,统一了 drag 和
    //   cut/paste 两条 pipeline 的 selectedId 重映射语义。
    applyMoveRemap: (idRemap) => {
      applyLitMoveRemapImpl(set, get, idRemap);
    },
  };
});

// audit-r136 M3:self-write 抑制窗口从 500ms 收到 200ms —— 500ms 覆盖
//   IPC roundtrip(~50ms)+ 几次 chokidar 事件(~30ms)+ 偶发 GC 抖动(~50ms),
//   余量过大;200ms 仍能完整覆盖一轮(130ms) + 缓冲(70ms),但窗口外的
//   真 LITERATURE_CHANGED(chokidar / 其它窗口 / OS 拖入)不会被无谓
//   吞掉延迟 500ms 才显示。**paper 域** 自写抑制窗口 200ms 是 r44 fix
//   收敛值;lit 域无 autosave 类高频路径,200ms 同样足够。
//   **notes 域是 500ms,不是漏改(r221 对账)**:notes save() 走乐观
//   patch、不自己 load,窗口必须盖过它的 watcher echo(awf 50ms + 去抖
//   100ms + scan ≈ 写后 150~400ms)且 autosave 高频;本域 writer 自己
//   force load,窗口只需盖同步 echo,自己的 watcher echo(awf 200ms +
//   去抖 100ms ≥ 300ms)盖不住、漏出来当 no-op 兜底(force load 不复用
//   in-flight + 序号守卫拒旧快照)。两域数值刻意不同,勿「统一」。
const SELF_WRITE_SUPPRESS_WINDOW_MS = 200;
let _lastSelfWriteTs = 0;

function markSelfWrite(): void {
  _lastSelfWriteTs = Date.now();
}

// 模块级自初始化:订阅 LITERATURE_CHANGED 推送,保证任何地方 useLiteratureStore()
// 拿到的都是最新数据。设计要点镜像 notes.ts:662-714:
//   - 仅订阅副作用(api.onLiteratureChanged 是回调注册,无网络/IO),
//     不在模块顶层调 load()
//   - 首次拉取由 App.tsx 在 useEffect 中显式触发
//   - 防御式:仅在 window.api 存在时订阅;测试环境 / SSR 安全
//   - 自写广播在 200ms 窗口内跳过(M3 收紧,详见 markSelfWrite 注释)
//   - literature 域无 activeNoteFull 缓存,不需要 invalidate 逻辑
// (测试在 .test.ts 显式调用模块底部那个清理函数)
let _unsubscribe: (() => void) | null = null;
let _initialized = false;

function _ensureInit(): void {
  if (_initialized) return;
  // 防御:测试环境或 preload 未挂载时不要硬订阅(避免抛错导致整个模块加载失败)
  if (
    typeof window === 'undefined' ||
    !window.api ||
    typeof window.api.onLiteratureChanged !== 'function'
  ) {
    return;
  }
  _initialized = true;
  _unsubscribe = window.api.onLiteratureChanged(() => {
    // 自写抑制窗口:writer 落盘后 ~200ms 内的 echo 跳过 load(),避免与
    // writer 末尾的 force load 重复 roundtrip。窗口外的广播走 force
    // load 拉新列表(chokidar / 其他窗口 / OS 拖入)。M3 收紧:旧 500ms
    // 对 IPC + chokidar 一轮 ~130ms 留太多余量,真 LITERATURE_CHANGED
    // 被无谓延迟显示。
    const isSelfEcho = Date.now() - _lastSelfWriteTs < SELF_WRITE_SUPPRESS_WINDOW_MS;
    if (isSelfEcho) return;
    // load({ force: true }) 不复用 in-flight,且带序号守卫(r73)防旧
    // 快照覆盖新快照。catch 与 notes 侧同款:IPC 边界 throw 走 log
    // warn 留 trace,不让 unhandled rejection 静默丢。
    useLiteratureStore
      .getState()
      .load({ force: true })
      .catch((err: unknown) =>
        log.warn('LITERATURE_CHANGED listener reload failed', err),
      );
  });
}

// 模块加载时即尝试订阅(浏览器渲染进程单例,不需要等 React mount)
// esbuild 会保留顶层副作用,避免被 tree-shake 掉
_ensureInit();

// audit-r136 M7:Vite HMR 自卸载 —— dev 模式 vite-plugin-react 改
//   任意 source file 都会触发 HMR 重渲本模块,模块顶层副作用
//   (`_unsubscribe = window.api.onLiteratureChanged(...)`)若不摘,
//   旧 listener 仍指向旧模块闭包 → leak + 多 listener 触发多次 force
//   load,全量重渲 N 次。`import.meta.hot?.dispose` 在 HMR 替换本模块前
//   跑(标准 Vite API),摘掉旧 listener 让新一轮 _ensureInit 重订一次。
//   生产 build import.meta.hot === undefined,自然不挂这条逻辑。
if (typeof import.meta.hot !== 'undefined') {
  import.meta.hot?.dispose(() => {
    if (_unsubscribe) {
      _unsubscribe();
      _unsubscribe = null;
    }
    _initialized = false;
  });
}
