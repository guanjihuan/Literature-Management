// 集中处理"主进程 → 渲染层"事件推送的副作用
//
// 之前 App.tsx 里有 5+ 个 useEffect 各自订阅 IPC.on*Changed,然后调用 store.load(),
// 散布难维护。新增 IPC 推送时需要改 App.tsx + 写一遍相同的模式。
//
// 抽出本 hook 后:
//   - App.tsx 只需要 useSyncStores() 一行
//   - 拆掉各 useEffect 的依赖,降低重渲染几率
//   - 减少 scattered 的 .catch(() => {}) 噪声
//
// 当前订阅的三块(audit-r74 更正头注释 —— 原「行为对等」清单列的
//   onLibraryChanged / onLibraryScanProgress 通道已随 r56 library 退役删除,
//   onNotesChanged 由 notes store 模块顶层自订阅(_ensureInit),均不在本 hook):
//   - onFavoritesChanged: load favorites(先订阅再 load,见下方注释)
//     (原 collections 订阅块已在 2026-08-28 删除,分组并入 favorites)
//   - onStartupProgress: applyEvent + getStartupState snapshot
//   - onToastPush: 主进程 → renderer 错误提示 → useToast.show()
//
// 重构 (2026-09):删 onWorkspaceChanged / onTrashChanged 订阅 —— recent / trash
//   services 已下线(core-scope refactor),对应的 store + IPC 通道全部删除。
import { useEffect } from 'react';
import i18next from 'i18next';
import { api, hasApi } from '../lib/api';
import { useFavoritesStore } from '../store/favorites';
import { useStartupStore } from '../store/startup';
import { useToast, type ToastType } from '../lib/toast';

// audit-r90:type guard 第三份内联枚举(4 条件 ||)改 Record 穷举 ——
// 与 toast.tsx r8 的 DEFAULT_DURATION/PALETTE `Record<ToastType, …>` 同款
// 强制模式:ToastType 加新成员时本表缺 key → **TS 编译错误**,而不是像
// 旧内联条件那样静默漏(实证:tsc --strict 对联合非穷举 === 比较零警告)。
// audit-r92:上游单源已建 —— tuple 落 @shared/types,ToastType/api-types
// 签名/preload 边界白名单/main 发送点全部派生或 satisfies 挂型,本表是
// renderer 消费端的穷举兜底(缺 key → TS 红),链路两端如今同源于 tuple。
export const TOAST_TYPES: Record<ToastType, true> = {
  info: true,
  error: true,
  success: true,
  warning: true,
};
import { errMsg } from '../lib/error';
import { createLogger } from '../lib/logger-client';

const log = createLogger('useSyncStores');

/** 防御性 catch:防止单个 store 失败影响其他 */
function safeLoad(label: string, p: Promise<unknown>): void {
  // audit round 8 (2026-09-14):load 失败让用户看到 —— 之前仅 log.warn,
  //   主进程 / IPC 推送链路异常时 renderer 完全静默,用户看到"文献列表是空
  //   的"但其实是 reload 没成功。同款问题在 r7 主进程 IPC.TOAST_PUSH 已落地,
  //   这里把 renderer 侧的失败也走 toast。
  // 安全兜底:toast 调用本身不会抛(getState / show 是同步 fn),即便
  //   useToast 尚未初始化也不影响 log 兜底。
  p.catch((err) => {
    log.warn(`${label} reload failed`, err);
    try {
      useToast.getState().show({
        type: 'error',
        message: i18next.t('toast.syncLoadFailed', {
          source: label,
          msg: errMsg(err),
        }),
        duration: 6000,
      });
    } catch (toastErr: unknown) {
      log.error('toast.show itself failed during syncLoadFailed', toastErr);
    }
  });
}

export function useSyncStores(): void {
  // Notes — 不需要在这里订阅,notes store 在模块顶层自初始化(_ensureInit)
  // useSyncStores 集中订阅的初衷是避免散布在 App.tsx 的 5+ 个 useEffect;
  // notes 已经集中处理就不重复挂载。

  // Favorites 独立收藏 — 推送时 reload
  // audit 2026-09-10:先订阅再 load —— 旧顺序(load → 订阅)在 IPC 推送
  //   早于 listener 注册时丢事件(典型:用户启动应用 + 后台 scanner 立刻
  //   emit favorites:changed,主进程在 IPC 往返窗口内就广播,renderer 这边
  //   load() 还没完成、listener 还没挂,事件飘走)。倒过来后,首条事件一定
  //   命中 listener(load 完成后 listener 推一次,保证"以磁盘为准"快照最终
  //   覆盖)。与下方 onStartupProgress 同款 race → 同款修法。
  //   audit-r211:原设计里配对的 favoritesGetState pull 通道已整对下线
  //   (空壳:与 listFavorites 同源同形且 renderer 零调用)—— 本处的
  //   「先订阅再 load」顺序就是那条 race 的真实修法。
  useEffect(() => {
    if (!hasApi('onFavoritesChanged')) return;
    const off = api.onFavoritesChanged(() => {
      // audit-r76 (2026-10-17):必须 force —— 广播在磁盘变更**之后**发出,但
      //   裸 load() 的 inflight 去重会复用任何在飞请求,而那个请求可能是在
      //   本次变更落盘**之前**就发出的 → 拿到变更前快照,把刚广播的新状态
      //   覆盖回去,且之后无人纠正(stale 持续到下一次 broadcast)。
      //   paths.ts r74 subscribePathsReload 同款竞态同款修法。
      safeLoad('favorites', useFavoritesStore.getState().load({ force: true }));
    });
    void useFavoritesStore.getState().load();
    return off;
  }, []);

  // Startup progress — 启动期扫描阶段进度
  // audit 2026-09-10:顺序倒过来 —— 先订阅 onStartupProgress,再拉 snapshot。
  //   原顺序(先 invoke snapshot,再订阅 listener)在主进程 phase-done 广播
  //   速度高于 listener 注册时丢事件(channel A 在 IPC 往返中,channel B 的
  //   事件没接)。现在 listener 先挂上后,snapshot 到达时已应用的所有事件
  //   都会保留,hydroFromSnapshot 走"phase 已 done 不回退" 合并语义,
  //   不让 snapshot 把 listener 已推进的状态拉回。
  useEffect(() => {
    if (!hasApi('onStartupProgress')) return;
    const off = api.onStartupProgress((ev) => {
      useStartupStore.getState().applyEvent(ev);
    });
    if (hasApi('getStartupState')) {
      api
        .getStartupState()
        .then((r) => {
          if (r.ok) useStartupStore.getState().hydrateFromSnapshot(r.data);
          // audit-r89:ok:false 是 wrap.ts 包络下的**常规** IPC 失败形态
          // (handler 内 AppError → {ok:false, code, message}),旧实现静默
          // 吞掉 —— .catch 只覆盖 promise reject(传输层)形态,两种形态
          // 的可观测性不对等:启动进度卡死时日志无线索。与 .catch 同款 warn。
          else log.warn('getStartupState rejected', r.message);
        })
        .catch((err: unknown) => log.warn('getStartupState failed', err));
    }
    return off;
  }, []);

  // audit 2026-09-14 r7:主进程 → renderer 推 toast 通道 —— 迁移失败 / watcher 启动失败
  //   / reload 失败等场景。IPC.TOAST_PUSH → useToast.show()。payload 形态见
  //   src/main/startup.ts IPC.TOAST_PUSH 发送点。
  useEffect(() => {
    if (!hasApi('onToastPush')) return;
    const off = api.onToastPush((payload) => {
      if (
        payload &&
        typeof payload.type === 'string' &&
        Object.prototype.hasOwnProperty.call(TOAST_TYPES, payload.type) &&
        typeof payload.message === 'string'
      ) {
        useToast.getState().show({
          // audit-r76 (2026-10-17):直接透传 —— 旧实现把 warning 降级映射成
          //   error(红底),但 toast.tsx r21 已完整支持 warning 类型(琥珀
          //   底 + AlertTriangle + 5000ms)。主进程发 warning 的语义是
          //   「操作成功但有副作用问题」(软失败),映射成 error 会让用户
          //   误以为操作失败。
          type: payload.type,
          message: payload.message,
          duration: payload.duration,
        });
      }
    });
    return off;
  }, []);
}
