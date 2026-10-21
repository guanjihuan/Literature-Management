// Settings IPC handlers
// audit-r56:删 SETTINGS_PICK_LIBRARY_PATH / SETTINGS_PICK_IMPORT_ROOT /
//   LIBRARY_MIGRATION_MOVE / LIBRARY_MIGRATION_KEEP / LIBRARY_MIGRATION_GET_STATE
//   handler —— library 整体下线,库路径选择、额外导入根、库归位这三条通道
//   都没有意义了。SETTINGS_PICK_DATA_PATH 保留(选 notes / workspace 工作目录根用)。
//   settings 内部 SETTINGS_UPDATE 的 libraryPath / extraImportRoots 路由
//   (changeLibraryPath / stopWatching / refreshLibraryMigrationFlag)也一并删,
//   因为 settings.store 不再含这些字段。
import { dialog, BrowserWindow, OpenDialogOptions } from 'electron';
import { IPC, AppSettings } from '../../shared/types';
import { getSettings, updateSettings } from '../settings/store';
import { switchDataPath, restoreDefaultDataPath } from '../settings/migration';
import { sanitizeSettingsPatch } from '../settings/validate';
import { AppError, errMsg } from '../utils/error';
import { createLogger } from '../utils/logger';
import { handle, requireObject, requireString } from './wrap';
import { tr } from '../i18n';
import { MAX_IPC_PATH_CHARS, requireAbsolutePath } from './path-limits';

const log = createLogger('ipc-settings');

// audit 2026-08-28:dialog.showOpenDialog 的 title 走主进程 i18n 表(settings.pickerData),
// 跟随 settings.language 选标题。
//   - 不引入 main 侧 i18next 依赖(避免把 renderer 的 react-i18next 拉到 main)
//   - 不让 renderer 把 title 通过 IPC 传过来(契约污染,且 locale 由 main 拿更近)

// 弹一个文件夹选择对话框,统一两个 SETTINGS_PICK_* 的模板代码(原 settings.ts
// 里 8 行 × 2 处复制)。Options 只在 properties / title 上有差异,封装为 helper 后
// 调用方只关心"我要什么标题 + 哪些 properties",不再关心 BrowserWindow 拿取
// / canceled 判断 / 空数组兜底这些 boilerplate。
//
// audit C2R9 (2026-08-22):2 个 IPC handler 几乎一字不差,settings dialog 的 4 个
// 步骤(从 event 拿 win → 调 showOpenDialog → 判 canceled → 返回 string|null)
// 完全可抽;抽后调用方 1 行,且未来加第 3 个 picker 时零成本。
async function pickFolder(
  event: Electron.IpcMainInvokeEvent,
  options: OpenDialogOptions,
): Promise<string | null> {
  // audit 2026-08-25:显式 null check —— renderer 在 dialog 弹出前 reload / 关闭
  // (e.g. devtools hot reload) → BrowserWindow.fromWebContents 返回 null,
  // win! 解引用会 throw TypeError → wrap.ts 转成 INTERNAL 但用户看到的是
  // unhandled "Cannot read properties of null"。改为显式 null check 直接返 null,
  // 与下面 canceled 路径同语义 —— 拿不到 win 就当用户取消了。
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return null;
  const res = await dialog.showOpenDialog(win, options);
  if (res.canceled || !res.filePaths[0]) return null;
  return res.filePaths[0];
}

// audit-r244:SETTINGS_UPDATE 的 patch **只允许「UI 偏好」字段** ——
//
//   背景:rootPath / dataPath 是**加载路径**字段(由 initSettings 从
//   location.json 推导 + reconcileRootPath 校正),renderer 没有理由改它们。
//   旧实现里 sanitizeSettingsPatch 就是 sanitizeAppSettings 的别名(同一个
//   **加载侧**净化器),它接受任何「绝对 + ≤4096 字符」的 rootPath ⇒
//   被劫持 / XSS 的 renderer 调 api.updateSettings({rootPath:'C:\\Windows'})
//   就能把 rootPath **落盘**(store.updateSettings 直接 `{...base, ...patch}`
//   + saveSettings)⇒
//     - 设置页显示错的根(renderer 的 deriveNotesPath(settings.rootPath)
//       指向工作区外的目录);
//     - 「打开数据目录」按钮走 SHELL_OPEN_PATH → assertInsideAllowedRoot
//       对**真实**根校验 → EPERM ⇒ 按钮变死;
//     - 落盘的脏值直到下次启动 reconcileRootPath 才自愈,期间 UI 全错。
//   不是数据丢失(没有文件 IO 跟着伪造的 rootPath 走),但「renderer 能改
//   磁盘位置」本身是 IPC 边界该堵的口子。
//
//   修法:在 IPC 边界按**白名单**挑字段 —— 只有 UI 偏好字段可更新。
//   刻意**不改** settings/validate.ts 的 sanitizeAppSettings:加载路径必须
//   继续接受 rootPath / dataPath(否则 initSettings 拿不到旧值推导 rootPath,
//   见 validate.ts:39-42 的注释),两条路径的口径本来就不同 —— 这正是
//   validate.ts 里 sanitizeLoadedSettings / sanitizeSettingsPatch 要**分开
//   命名**的原因。
const UPDATABLE_SETTING_KEYS = ['theme', 'language', 'version', 'workspaceLayout'] as const;

function pickUpdatableSettings(patch: Partial<AppSettings>): Partial<AppSettings> {
  const src = patch as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const key of Object.keys(src)) {
    if ((UPDATABLE_SETTING_KEYS as readonly string[]).includes(key)) {
      out[key] = src[key];
    } else {
      dropped.push(key);
    }
  }
  if (dropped.length > 0) {
    // 留痕:被剥掉的字段说明有调用方(或被劫持的 renderer)在试着改不该改的东西。
    log.warn('settings update dropped non-updatable fields', { dropped });
  }
  return out as Partial<AppSettings>;
}

export function registerSettingsIPC() {
  handle<[], AppSettings>(IPC.SETTINGS_GET, async () => getSettings());

  // updateSettings 内部会被 updateSettings 的 patch merge 透传到 settings.json。
  // 坏形状(数组 / 字符串 / null)应当被拒在 IPC 边界,避免 service 把它当
  // object 写盘。下游 store.updateSettings 没有 typeof 检查,这里兜底。
  //
  // audit round 3 (2026-08-22):在 IPC 层 sanitize patch — 把"坏字段静默丢弃"
  // 收紧到边界,避免 settings 注入脏字段扩散到 store。
  // sanitizeLoadedSettings 同样的策略(load 路径已有,update 路径缺)。
  // audit-r56:删 libraryPath / extraImportRoots 路由分支 —— 字段已下线。
  //   SETTINGS_UPDATE 现在只剩 theme / language / version / workspaceLayout
  //   这几个 UI 偏好字段,无任何「副作用」,handler 简化为 sanitize + merge。
  handle<[Partial<AppSettings>], AppSettings>(IPC.SETTINGS_UPDATE, async (_, patch) => {
    const patchObj = requireObject(IPC.SETTINGS_UPDATE, patch);
    const cleanPatch = pickUpdatableSettings(sanitizeSettingsPatch(patchObj));
    return updateSettings(cleanPatch);
  });

  // audit-r56:删 SETTINGS_PICK_LIBRARY_PATH / SETTINGS_PICK_IMPORT_ROOT —— 库
  //   路径与受信任导入根都不再存在。SETTINGS_PICK_DATA_PATH 仍走(用户改
  //   notes 工作目录根的入口)。
  handle<[], string | null>(IPC.SETTINGS_PICK_DATA_PATH, async (event) =>
    pickFolder(event, {
      title: tr('settings.pickerData'),
      properties: ['openDirectory', 'createDirectory'],
    }),
  );

  handle<[string], AppSettings>(IPC.SETTINGS_MIGRATE_DATA, async (_event, rawPath) => {
    // 防 string 类型被传成 number / object / null,避免 fs.mkdir 拿到非字符串炸掉
    // audit round 9 (2026-09-15):maxLen 走 path-limits.ts 共享常量(MAX_IPC_PATH_CHARS),
    //   与 shell.ts / notes.ts 同款。Windows MAX_PATH = 260,UNC \\?\
    //   前缀路径可达 ~32k,但实践中没人用那么长,4096 给未来网络路径留余量。
    const newPath = requireString(IPC.SETTINGS_MIGRATE_DATA, rawPath, 'newPath', {
      maxLen: MAX_IPC_PATH_CHARS,
    });
    // audit round 18 (2026-08-27):要求绝对路径 —— 旧版 switchDataPath 内部
    // 已经 resolve,但相对路径会基于 process.cwd() 解析,用户从 cwd 调起时正常,
    // 但把 app 打成 daemon 跑 / 跨进程调起时 cwd 可能不是预期目录。把绝对路径
    // 要求上提到 IPC 边界,renderer 只能从 dialog pickFolder 拿到绝对路径
    // 传进来,无法塞 `../../etc/passwd` 之类基于 cwd 的攻击向量。
    // audit 2026-09-16 r19:M3 — 抽 requireAbsolutePath 共享校验。
    requireAbsolutePath(newPath, { ipc: IPC.SETTINGS_MIGRATE_DATA, field: 'newPath' });
    log.info('Migrating data to', newPath);
    await switchDataPath(newPath);
    return getSettings();
  });

  // 恢复默认数据路径 —— 走 location.defaultDataPath() → switchDataPath 全流程。
  // 与 SETTINGS_MIGRATE_DATA 同源(都走 switchDataPath),唯一差异是路径由主进程
  // 派生而非用户 pick —— IPC 不需要输入校验,renderer 注入不了。
  //
  // audit-r205:这里**不再**直接 switchDataPath(default) —— 那条路要求目标目录
  //   为空,而默认位置里躺着上一次工作区的副本(changeDataPath 是复制语义)
  //   ⇒ 用户一旦搬离默认位置,这个按钮就永久报「target directory must be empty」。
  //   改走 restoreDefaultDataPath:先把默认目录**改名让开**(不删任何字节),
  //   再切换。详见 settings/migration.ts 的 r205 头注。
  handle<[], AppSettings>(IPC.SETTINGS_RESTORE_DEFAULT_DATA, async () => {
    try {
      await restoreDefaultDataPath();
    } catch (err: unknown) {
      // restoreDefaultDataPath 内部已包 rollback,若仍走到这里说明 rollback 也炸了,
      // 把原始错误透传,UI 用 toast.dataRestoreFailed 显示。
      log.error('restoreDefaultDataPath failed', errMsg(err));
      throw err instanceof AppError ? err : new AppError('MIGRATION_FAILED', errMsg(err), err);
    }
    return getSettings();
  });

  // audit-r56:删 LIBRARY_MIGRATION_MOVE / KEEP / GET_STATE handler —— 库归位
  //   整套通道下线。
}
