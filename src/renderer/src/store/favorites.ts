// 独立收藏 store — LiteratureList(audit-r72 起;原 LibraryList r71 已删)直接
// 订阅 favoritedFileIds 做 ★ 状态过滤,不需要 selectedId/group 选中态。
// 推送: api.onFavoritesChanged → 重新 load
import { create } from 'zustand';
import type { FavoritesFileEntry } from '@shared/types';
import { api, unwrap } from '../lib/api';
// audit C3R48 (2026-08-22):errMsg 替代 verbose 错误格式化
import { errMsg } from '../lib/error';

interface FavoritesState {
  entries: FavoritesFileEntry[];
  favoritedFileIds: Set<string>;
  loading: boolean;
  lastError: string | null;
  load: (opts?: { force?: boolean }) => Promise<void>;
  toggle: (fileId: string, info?: { title?: string; relPath?: string }) => Promise<boolean>;
}

export const useFavoritesStore = create<FavoritesState>((set, get) => {
  // audit C3R10 (2026-08-22):并发去重 — 多个 toggle 同时跑(load() 也会重叠)会
  // 让响应回来的顺序不保证,后落地的可能是更早的 IPC 调用的 snapshot,旧数据
  // 覆盖新数据。inflight 去重模式:notes.ts / library.ts 等 store 同款。
  let inflight: Promise<void> | null = null;

  // audit-r76 (2026-10-17):序号守卫(paths.ts r74 / literature.ts r73 同款
  //   移植)—— force 出口存在之后,inflight 去重只保证「同时刻最多一次普通
  //   IPC」,但 force 会与在飞普通请求并存:晚到的旧响应(成功或失败)会把
  //   force 拿到的新快照覆盖回去。_issued 每请求 +1,_applied 记录已落地
  //   结果里最新的序号;迟到的旧响应两分支都直接丢弃。
  let _issued = 0;
  let _applied = 0;

  const doLoad = async (seq: number): Promise<void> => {
    set({ loading: true, lastError: null });
    try {
      const list = unwrap(await api.listFavorites());
      // 迟到的旧成功:新快照(或新失败)已落地,旧数据不得覆盖
      if (seq < _applied) return;
      _applied = seq;
      const entries = list ?? [];
      // 重构 (2026-08-28):FavoritesEntry 是 union(file | group);
      // favoritedFileIds 只数 file kind —— group 不直接对应文献 id,
      // 把它误当 fileId 加进集合会让 statusBar 的"已收藏"判断误中。
      const favoritedFileIds = new Set<string>();
      for (const e of entries) {
        if (e.kind === 'file') favoritedFileIds.add(e.fileId);
      }
      set({ entries, favoritedFileIds, loading: false });
    } catch (err: unknown) {
      // 迟到的旧失败同理:不得把新成功数据的 lastError 污染回来
      if (seq < _applied) return;
      _applied = seq;
      set({ loading: false, lastError: errMsg(err) });
    }
  };

  const load = (opts?: { force?: boolean }): Promise<void> => {
    // inflight 去重(notes.ts / library.ts 同款):并发 toggle 共享同一次 IPC。
    // C3R10 回归测试锁的就是这个契约 —— 两次并发 load 若各自发 IPC,响应顺序
    // 错乱时旧快照会把 store 覆盖回「只有 A 没有 B」。
    //
    // audit 2026-10-01:新增 force —— 「刚写完,需要确认读到的是写入之后的
    //   状态」的场景。复用一个**写入之前**就发出的飞行中请求会拿到旧快照
    //   (那次请求可能由 onFavoritesChanged 广播在本次落盘前发起)。
    //   这里不复用、强制发一次新的;不复用 inflight 是刻意的,避免让普通
    //   load() 也被迫多打一次 IPC。
    if (!opts?.force && inflight) return inflight;
    const seq = ++_issued;
    const p = doLoad(seq).finally(() => {
      // 只清自己那一次 —— force 发起的请求不进 inflight,不能让它把别人
      // 正在飞行的记录清掉(否则后续 load 会重复发 IPC)。
      if (inflight === p) inflight = null;
    });
    if (!opts?.force) inflight = p;
    return p;
  };

  return {
    entries: [],
    favoritedFileIds: new Set<string>(),
    loading: false,
    lastError: null,

    load,

    toggle: async (fileId, info) => {
      // audit 2026-09-10:乐观更新 —— 之前先 await IPC 再 load(),★ UI 在
      //   IPC roundtrip 期间(典型 30-100ms)保持旧态,用户视觉上感觉"按了
      //   没反应"。先 flip 本地 Set → IPC → load() 校验兜底。load()
      //   走 inflight 去重,与 onFavoritesChanged listener 的 load 不会冲突。
      const wasFavorited = get().favoritedFileIds.has(fileId);
      const optimisticFavorited = !wasFavorited;
      const optimisticSet = new Set(get().favoritedFileIds);
      if (optimisticFavorited) optimisticSet.add(fileId);
      else optimisticSet.delete(fileId);
      set({ favoritedFileIds: optimisticSet });

      try {
        const result = unwrap(
          await api.toggleFavorite(
            fileId,
            info ? { title: info.title, relPath: info.relPath } : undefined,
          ),
        );
        // 主进程是单一真相源;load() 拿到权威状态后会自动纠正乐观值
        // (比如 info 校验失败抛错时主进程根本没改 disk,load() 把 Set 翻回来)。
        await load();
        // audit 2026-10-01:MEDIUM — 校验这次 load 读到的是不是**本次写入之后**
        //   的状态。load() 的 inflight 去重会复用任何在飞的请求,而那个请求可能
        //   是 onFavoritesChanged 在本次写入落盘**之前**发起的 → 返回写入前的
        //   旧快照 → 把刚做的乐观 ★ 直接翻回去(用户连点两个不同文件的星标时
        //   第二个 toggle 落在第一个 load 的飞行窗口内最容易命中)。
        //
        //   不用「强制多打一次 IPC」来解决:那会破坏 C3R10 锁定的并发去重契约
        //   (两次并发 load 各自响应,顺序错乱时旧快照会覆盖新的)。改成比对
        //   权威返回值与 store 现状 —— 不一致才补一次强制刷新,且只补一次,
        //   不会打转(主进程若真的没改盘,result.favorited 就等于现状,不会触发)。
        if (get().favoritedFileIds.has(fileId) !== result.favorited) {
          await load({ force: true });
        }
        // audit 2026-09-10:成功路径也清 lastError —— 旧实现只在 catch 写、
        //   load() 走 inflight 去重若早已成功(load 看到权威状态正确)也不会
        //   清 lastError,导致上一次失败的红字 / dev console 残留到下次成功
        //   之后。状态字段语义:"最近一次失败的原因",恢复成功就重置。
        const cur = get();
        if (cur.lastError !== null) set({ lastError: null });
        return result.favorited;
      } catch (err) {
        // IPC 失败:回滚乐观值 + 让调用方 toast
        const rollbackSet = new Set(get().favoritedFileIds);
        if (wasFavorited) rollbackSet.add(fileId);
        else rollbackSet.delete(fileId);
        set({ favoritedFileIds: rollbackSet, lastError: errMsg(err) });
        throw err;
      }
    },
  };
});
