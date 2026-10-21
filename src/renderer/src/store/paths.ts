// 模块数据路径状态 — 一次拉取,模块切换无 IPC
//
// 设计要点:
//   - 启动期 App.tsx mount 后触发一次 load(),后续 useSyncStores/settings 变化时
//     由 setupPathsSubscription() 兜底再 load 一次(用户在设置页改数据根路径时
//     路径会变;根路径即 WorkspacePaths.root,settings 侧叫法见 ADR-0003。
//     libraryPath 字段已随「库」概念退役,audit-r73 清掉本注释残留)
//   - 渲染层用 selector 读 paths.xxx,缺数据时回 null,UI 自行降级(disabled 按钮)
//   - load 失败保留旧 paths(用户不会因为瞬时 IPC 错误丢失已知路径)
import { create } from 'zustand';
import type { WorkspacePaths } from '@shared/types';
import { api } from '../lib/api';
import { errMsg } from '../lib/error';
import { createLogger } from '../lib/logger-client';

const log = createLogger('usePathsStore');

// 占位:在 load 成功前渲染层用这个避免 undefined;root 一定有值
// (主进程 setDataPath 后才有 shell IPC),其他依赖 settings/rootPath
// 实际运行中 root 由 mount 后的 load() 覆写成真值(audit-r77:删「50ms 内」承诺
// ——耗时取决于 IPC 往返,没有契约给毫秒数,旧措辞会让 UI 同学误以为可以等定值);
// UI 不能假设 root 永远非空——但根模块路径按钮会按 null 走降级(disabled)。
// audit-r56:library 字段整体删除 —— 文献管理回归「打开 PDF 来读」,没有库路径。
const EMPTY_PATHS: WorkspacePaths = {
  root: '',
  notes: '',
  favorites: '',
};

interface PathsState {
  paths: WorkspacePaths;
  loaded: boolean;
  loading: boolean;
  /** audit 2026-09-10:上次 load 的错误 —— 旧实现失败仅 log.warn,UI 永远不知道
   *  paths 拉取失败,StatusBar 路径按钮继续展示旧路径但不告诉用户 stale。
   *  存 lastError 让调试入口可读,上层 toast 在 settings 改路径后弹错误用。 */
  lastError: string | null;
  /**
   * 启动期 / settings 变化时拉一次。
   * audit-r74:favorites / literature store 的 force + 序号守卫同款移植。
   * 旧实现「后续调用取消前面的」这句注释与实际不符(实际是复用 in-flight),
   * 且复用带来真竞态:settings rootPath 已变(如 migrate-data 成功写回),但
   * 一个 rootPath 变化**之前**就发出的在飞 load 还没回 —— 此时新 load 复用
   * 它拿回旧路径快照;paths 域没有 push 通道,旧快照一旦落地就是永久 stale,
   * StatusBar 路径按钮 / drop 校验全跟着错,直到下一次 settings 变化。
   * 修:
   *   - settings 变化触发的重拉走 `load({ force: true })`(见 subscribePathsReload),
   *     不复用写入前发出的在飞请求;
   *   - 所有请求带单调序号,晚到的旧响应(无论成败)直接丢弃 —— 旧快照
   *     不得覆盖新快照。
   */
  load: (opts?: { force?: boolean }) => Promise<void>;
}

// in-flight 去重:并发普通 load 共享一次 IPC;force 刻意不复用。
// 注意缓存的只是「进行中的 promise」,resolve 即清空 —— 下一次 load 永远真发。
// (store/literature.ts audit-r73 同注释,形态完全对齐)
let _inflight: Promise<void> | null = null;
// 序号守卫:_issued 每请求 +1;_applied 记录已落地结果里最新的序号,
// 落后于它的响应直接丢弃。
let _issued = 0;
let _applied = 0;

export const usePathsStore = create<PathsState>((set) => {
  const loadImpl = async (seq: number): Promise<void> => {
    set({ loading: true });
    try {
      const r = await api.getWorkspacePaths();
      if (seq < _applied) return; // 迟到的旧请求,新快照(或新失败)已落地
      if (r.ok) {
        _applied = seq;
        set({ paths: r.data, loaded: true, loading: false, lastError: null });
      } else {
        _applied = seq;
        log.warn('getWorkspacePaths failed', r.code, r.message);
        // audit 2026-09-10:lastError 留痕 —— UI 读 lastError 决定是否 toast。
        set({ loading: false, lastError: r.message });
      }
    } catch (err) {
      if (seq < _applied) return;
      _applied = seq;
      log.warn('getWorkspacePaths threw', err);
      set({ loading: false, lastError: errMsg(err) });
    }
  };
  return {
    paths: EMPTY_PATHS,
    loaded: false,
    loading: false,
    lastError: null,
    load: (opts?: { force?: boolean }) => {
      if (!opts?.force && _inflight) return _inflight;
      const seq = ++_issued;
      const p = loadImpl(seq).finally(() => {
        // 只清自己那一次 —— force 请求不进 in-flight,不能把别人在飞的记录清掉
        if (_inflight === p) _inflight = null;
      });
      // force 请求不登记 in-flight(否则后来的普通 load 会复用「写入前」快照)
      if (!opts?.force) _inflight = p;
      return p;
    },
  };
});

/**
 * 计算"路径相关字段"的合并哨兵 — 只有真正影响路径计算的字段变化时才 reload。
 * audit C3R31 (2026-08-22):不能用 `version`(`version` 是 app 版本,不是 settings
 * 变更计数),也不能用 settings 对象引用(`update` 每次都新建对象,会触发 theme/
 * language 等无关变更的 reload)。
 *
 * audit r44 (2026-10-15):改用 `rootPath` 而非 deprecated `dataPath`。post-ADR-0003
 *   `rootPath` 是 canonical 字段,`dataPath` 是镜像 @deprecated 字段。
 *   旧实现用 `dataPath`,用户经 settings 页改 `rootPath`(不改 dataPath)时
 *   `pathsKeyOf` 不变 → `usePathsStore.load()` 不触发 → StatusBar 路径按钮
 *   仍显示旧 rootPath,直到下次手动重启。改成 `rootPath` 后,任何影响路径计算
 *   的字段变化都走 reload。
 */
// audit-r56:key 由 `libraryPath|rootPath` 收缩为只 `rootPath` —— libraryPath
//   已随库整体退役从 AppSettings 删除。
export function pathsKeyOf(s: { rootPath?: string } | null | undefined): string {
  return s?.rootPath ?? '';
}

/**
 * 订阅 settings 变化,变化时重新拉路径。
 * App.tsx mount 后调用一次即可(setup hook);返回 unsubscribe。
 *
 * settings store 没有"对外广播"的 API,所以这里轮询 settings.settings 引用。
 * settings 整体 push 频率极低(只在用户改设置时),不会引入频繁 re-render。
 *
 * audit C3R31 (2026-08-22):用 `version` 当变更哨兵是错的 —— `version` 是 app 版本
 * (`app.getVersion()` 在 main/settings/store.ts 初始化时写入,后续 updateSettings
 * 不变),用户改路径设置时 `version` 不动,订阅触发但不重 load,
 * UI 继续用旧路径直到下次启动。改用 rootPath 拼接 key,只有真正
 * 影响路径计算的字段变化时才 load。
 *
 * audit r44 (2026-10-15):key 由 `libraryPath|dataPath` → `libraryPath|rootPath`,
 *   同步对齐 pathsKeyOf 字段修正。
 * audit-r56:libraryPath 退役,key 只剩 `rootPath`(见 pathsKeyOf 注释)。
 */
export function subscribePathsReload(): () => void {
  // 动态 import 避免循环依赖(paths → settings → paths)
  // 注意:订阅要等 import resolve 后才建立,而 cleanup 可能先于它跑
  //(StrictMode 的 mount→unmount→mount、HMR、或 App 在 import 完成前卸载)。
  // 所以除了持有 unsub,还需要一个 cancelled 标记 —— 否则 cleanup 时 unsub
  // 还是 null,等 import 落地后订阅照样建立,且再没有引用能解绑 → 泄漏。
  // audit 2026-09-14:补 .catch —— 动态 import 拒绝(模块加载失败 / chunk 404)
  //   时,then 不会跑、unsub 留 null,subscription 永远没建立。补 catch
  //   + log.warn 让排查能看到入口信号;settings 变化时 paths 不刷新
  //   至少有一条 trace 提示"订阅未建立"。
  let unsub: (() => void) | null = null;
  let cancelled = false;
  void import('./settings')
    .then(({ useSettingsStore }) => {
      if (cancelled) return;
      let lastKey = pathsKeyOf(useSettingsStore.getState().settings);
      unsub = useSettingsStore.subscribe((s) => {
        const cur = pathsKeyOf(s.settings);
        if (cur !== lastKey) {
          lastKey = cur;
          // audit-r74:rootPath 变化后的重拉必须 force —— 此刻若有「变化前」的
          // 在飞 load,复用它拿回的就是旧路径(且无 push 通道纠正)。竞态
          // 详情见 PathsState.load 注释。
          void usePathsStore.getState().load({ force: true });
        }
      });
    })
    .catch((err: unknown) => log.warn('subscribePathsReload: dynamic import failed', err));
  return () => {
    cancelled = true;
    unsub?.();
    unsub = null;
  };
}
