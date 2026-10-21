// 设置状态
import { create } from 'zustand';
import type { AppSettings } from '@shared/types';
import { api, unwrap, IpcError, asIpcError } from '../lib/api';
import { errMsg } from '../lib/error';
import { createLogger } from '../lib/logger-client';
// audit 2026-10-06:常量已挪到零 import 的叶子模块 store/constants.ts。
//   改动前它住在 workspace.ts,而 workspace.ts 又 import 本文件的
//   useSettingsStore —— 两个 store 互相 import,构成 docs/architecture.md
//   声称为「0 环」却实际存在的那个环。详见 constants.ts 头注。
import { PENDING_LAYOUT_LS_KEY } from './constants';

const log = createLogger('useSettingsStore');

// audit-r56:pickLibrary / pickImportRoot / restoreDefaultLibrary 删除 ——
//   库概念下线,AppSettings 无 libraryPath / extraImportRoots 字段,
//   对应 IPC 通道(pick-library-path / pick-import-root /
//   restore-default-library-path)已退役。文献根目录管理由
//   useLiteratureStore 接管(resource-model 重构)。
interface SettingsState {
  settings: AppSettings | null;
  load: () => Promise<void>;
  update: (patch: Partial<AppSettings>) => Promise<void>;
  pickData: () => Promise<string | null>;
  migrate: (newPath: string) => Promise<AppSettings>;
  // 恢复默认数据路径:内部走 switchDataPath
  // (copy 数据 + write settings.json + write location.json + restart watcher +
  // rescan),unwrap 把 {ok:false} 翻译成 IpcError throw。
  restoreDefaultData: () => Promise<AppSettings>;
}

/**
 * audit 2026-09-07:从 localStorage 拉 pagehide 那一刻未来得及持久化的
 *   workspaceLayout fallback。workspace.ts:flushPendingWorkspaceLayout
 *   在 beforeunload 同步发起 settings.update IPC,但 IPC 不等返回就 unload
 *   可能丢最后 toggle。Renderer-local localStorage 跨启动存活,这里合并
 *   有值的话同步推回主进程(吞掉一次性 update 后清 key)。
 */
function applyPendingLayoutFallback(settings: AppSettings): AppSettings {
  if (typeof localStorage === 'undefined') return settings;
  const raw = localStorage.getItem(PENDING_LAYOUT_LS_KEY);
  if (!raw) return settings;
  let pending: Partial<AppSettings['workspaceLayout']> | null = null;
  try {
    pending = JSON.parse(raw);
  } catch {
    localStorage.removeItem(PENDING_LAYOUT_LS_KEY);
    return settings;
  }
  if (!pending || typeof pending !== 'object') {
    localStorage.removeItem(PENDING_LAYOUT_LS_KEY);
    return settings;
  }
  // 透传到 store 后异步推主进程,清 key 防重复。
  // audit 2026-09-10:失败也清 —— 原实现 r.ok=false 时保留 localStorage
  //   条目,导致后续每次 settings.update() 都重新把 stale merge 结果写回
  //   主进程,持续覆盖服务端最新值。失败一次即视为"放弃这个 fallback",
  //   与注释原意("失败也清,避免 fallback 持续拦截")对齐。
  // audit-r161 race 防御:同步清 key 在 IPC 之前(原 .then 内清 → 飞行 IPC 期
  // 用户 toggle 又读 stale pending 触发第二次 IPC 把 stale merge 写回主进程)。
  // 走 `Promise.resolve(api?.updateSettings(...))` 替代 `api.updateSettings(...).catch()`:
  //   桥缺失(baseline bridge-missing)时 api === undefined,`api.updateSettings` 在挂
  //   .catch 之前抛 TypeError,链式裸调让哨兵(api-bridge-call-parity)红;Promise.resolve
  //   把 undefined 桥包成 fulfilled undefined,后续 .catch 仅接 IPC 真 reject。
  const mergedLayout = { ...settings.workspaceLayout, ...pending };
  localStorage.removeItem(PENDING_LAYOUT_LS_KEY);
  Promise.resolve(api?.updateSettings({ workspaceLayout: mergedLayout })).catch(
    (err: unknown) => {
      log.warn('updateSettings IPC failed, clearing pending layout fallback', errMsg(err));
    },
  );
  return { ...settings, workspaceLayout: mergedLayout };
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: null,
  load: async () => {
    // audit 2026-09-14:try/catch + log —— 与 library/paths/favorites store 对齐。
    //   旧实现 unwrap 直接 throw,被 void 调用时会变成 unhandled rejection;
    //   显式 catch 让 settings 拉取失败至少留 trace,store 保持 null 让
    //   上层用 settings===null 走降级(主区 disabled / StatusBar stale 提示)。
    // audit-r161:throw 之前调 asIpcError 把 preload 透传的 wrapped Error
    //   重建为 IpcError 实例 —— 让上层 `instanceof IpcError` 判 + 读
    //   .code/.field/.size 走差异化提示。
    try {
      const raw = unwrap(await api.getSettings());
      set({ settings: applyPendingLayoutFallback(raw) });
    } catch (err: unknown) {
      log.warn('useSettingsStore.load failed', errMsg(err));
      throw asIpcError(err) ?? err;
    }
  },
  update: async (patch) => {
    try {
      const raw = unwrap(await api.updateSettings(patch));
      set({ settings: applyPendingLayoutFallback(raw) });
    } catch (err: unknown) {
      log.warn('useSettingsStore.update failed', errMsg(err));
      throw asIpcError(err) ?? err;
    }
  },
  pickData: async () => {
    // audit 2026-09-11:区分 cancel vs IPC error —— 旧实现 `r.ok ? r.data : null`
    //   把两类都映射成 null,SettingsPage 的 `if (!p) return;` 把"用户取消"和
    //   "IPC 失败"混为一谈,后者本应弹 error toast。修:走 unwrap 抛 IpcError,
    //   SettingsPage 已有 try/catch 接住走 error path;null 仅留给真正的取消。
    const r = await api.pickDataPath();
    if (!r.ok) throw new IpcError(r);
    return r.data;
  },
  migrate: async (newPath) => {
    // 主进程迁移成功后返回最新的 settings,我们把它推回 store 避免再发一次 load
    // audit-r124:同 r80 对 bootstrap/load/update 的收口 —— 直写会漏消费
    //   pendingLayout.v1(stale key 晚一步在下次 update() 才合并,把用户
    //   迁移后刚做的布局 toggle 回滚)。走 fallback 入口对齐三处语义。
    // audit-r161:同 load/update —— IPC reject 走 asIpcError 重建。
    try {
      const settings = unwrap(await api.migrateData(newPath));
      set({ settings: applyPendingLayoutFallback(settings) });
      return settings;
    } catch (err: unknown) {
      log.warn('useSettingsStore.migrate failed', errMsg(err));
      throw asIpcError(err) ?? err;
    }
  },
  // 主进程 restoreDefaultDataPath 内部走 switchDataPath 全流程
  // (copy 数据 → 写 settings.json → 写 location.json → initDB → restart watcher →
  // rescan),IPC 直接返回最新 settings,这里直接用。
  restoreDefaultData: async () => {
    // audit-r124:r124 同 migrate —— 直写绕开 pendingLayout 消费点,统一走
    //   applyPendingLayoutFallback(本文件唯一「落地即同步」入口)
    // audit-r161:同 load/update —— IPC reject 走 asIpcError 重建。
    try {
      const settings = unwrap(await api.restoreDefaultDataPath());
      set({ settings: applyPendingLayoutFallback(settings) });
      return settings;
    } catch (err: unknown) {
      log.warn('useSettingsStore.restoreDefaultData failed', errMsg(err));
      throw asIpcError(err) ?? err;
    }
  },
}));

/**
 * bootstrap 成功路径的 settings 落地入口(main.tsx / App.tsx 共用)。
 * audit-r80 (2026-10-17) MEDIUM:此前两处都用 `useSettingsStore.setState({
 * settings })` 直写,绕过 applyPendingLayoutFallback —— 而它是
 * workspace.pendingLayout.v1(pagehide 时 flushPendingWorkspaceLayout 写的
 * 关窗前最后一次布局 toggle 兜底)的唯一消费点。后果链:
 *   1. 会话 A 关窗,IPC 没落主进程,pending key 留在 localStorage;
 *   2. 会话 B bootstrap 成功直写 → stale key 无人消费;
 *   3. 会话 B 第一次 settings.update() 时 fallback 把会话 A 的旧布局合并
 *      进新鲜 settings 并回写主进程 —— 用户刚做的 toggle 被静默回滚。
 * 统一走这里后,bootstrap 与 load()/update() 行为对齐:每次 settings 落地
 * 都先消费 pending fallback。
 */
export function applyBootstrapSettings(settings: AppSettings): void {
  useSettingsStore.setState({ settings: applyPendingLayoutFallback(settings) });
}
