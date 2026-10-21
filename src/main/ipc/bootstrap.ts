// app:bootstrap IPC handler
//
// perf(2026-08-22):把启动期两次串行 IPC(SETTINGS_GET + WORKSPACE_GET_PATHS)
// 合并为单次 APP_BOOTSTRAP,返回 { settings, paths }。
//
// 为什么这样合并(audit-r124 时态校正:中间两条描述的是合并前的旧路径,
//   非现状 —— 触发链早已换代,勿当活机制读):
//   - settings 与 paths 都派生自 settings,语义高度耦合
//   - 旧路径(2026-08-22 前):渲染层订阅 LIBRARY_CHANGED(r56 已随库域
//     退役删除,useSyncStores 现订 favorites/startup/toast 等)→ useEffect
//     先后触发 useSettingsStore.load + usePathsStore.load,两次 IPC 间存在
//     "settings 已知但 paths 未知"的中间渲染态(主区按钮 disabled)
//   - 合并后两者原子到达,UI 没有中间降级态
//   - 单 roundtrip 省 ~2-5ms Windows IPC overhead
//
// 不会替代以下独立 IPC:
//   - SETTINGS_GET — 后续 settings 变化时仍用 getSettings 单读
//   - WORKSPACE_GET_PATHS — 单独测试覆盖此路径(workspace-get-paths.test.ts)
//   - settings 改后 subscribePathsReload() 仍用 getWorkspacePaths
//
// audit r50 (2026-10-15):走 handleZod<Req, Res>(...) 边界 Zod 校验 ——
//   入参是 z.void()(APP_BOOTSTRAP 不收参数),返回 { settings, paths }
//   走 ZodAppSettings + ZodWorkspacePaths,renderer 加新字段会立刻
//   「response schema mismatch」挡掉,主进程悄悄改返回结构影响不到
//   renderer。**这是 r50 第一个**走新签名的 channel,作为「works」的
//   end-to-end 证据;原注「后续 r52/r53 通道迁移会照此模板」是计划态,
//   **并未兑现**(audit-r124 实测:全仓 handleZod 调用点至今**仅 1 个** ——
//   本 channel;其余 28 个 handle 站点仍走旧 shim;「r52/r53」实际落在
//   limits 收敛等别的面),同口径见 schemas/ipc.ts 头注。
//   audit-r229 更正:r124 当时记的是「2 个」(本 channel + workspace 收藏
//   getState),后者的通道 FAVORITES_GET_STATE 已在 r211 整对下线 ⇒ 现在
//   **仅剩 1 个**。
import { IPC } from '../../shared/types';
import { handleZod } from './wrap';
import { ZodBootstrapReq, ZodBootstrapRes } from '../../shared/schemas/ipc';
import { getSettings } from '../settings/store';
import { buildWorkspacePaths } from './paths';

export function registerBootstrapIPC(): void {
  handleZod(IPC.APP_BOOTSTRAP, ZodBootstrapReq, ZodBootstrapRes, async () => ({
    settings: getSettings(),
    paths: buildWorkspacePaths(),
  }));
}
