// settings.json 字段级校验:把 JSON.parse 出的 unknown 收窄成 Partial<AppSettings>。
// 坏字段被剥掉(等价用户从未写过,DEFAULT_SETTINGS 兜底),不抛错 — 走 saveSettings
// 「无变化跳过」语义,下次落盘自然洗掉。下游 SettingsPage 的 .length / .map /
// 类型 union 触发 "Cannot read properties of undefined" 类崩溃的根因被堵死。
//
// 与 ZodAppSettings 两层并存:strict 边界(IPC)用 Zod,本文件保「剥脏不抛」+ 内联
// 长度上限/绝对路径兜底,不替换为 ZodAppSettings.partial().safeParse(后者的
// 整片拒绝 + ZodError.issues 数组语义无法 1:1 翻成本文件的「只剥坏字段」)
import { isAbsolute } from 'path';
import type { AppSettings, WorkspaceLayout } from '@shared/types';
import { FONT_FAMILIES, THEMES, THEME_PRESETS } from '@shared/types';
import { MAX_IPC_PATH_CHARS } from '../ipc/path-limits';

// audit-r125:theme 三档收 THEMES 单源(与下行 FONT_FAMILIES/THEME_PRESETS 同族补全)
const VALID_THEMES: ReadonlySet<string> = new Set(THEMES);
// version 是自由字符串但会写进 settings.json。读侧 1MB cap、写侧无 cap ——
// 超长 version 就能撑爆配置(2026-10 enabledExtensions 6MB 事件同模式)
// 64 字符宽松到不可能误伤真实值
const MAX_SETTINGS_FIELD_CHARS = 64;
const VALID_LANGUAGES: ReadonlySet<string> = new Set(['zh-CN', 'en-US']);
// 从 @shared/types 导入,与 renderer/src/store/workspace.ts 共用单一真相源
const VALID_FONT_FAMILY: ReadonlySet<string> = new Set(FONT_FAMILIES);
const VALID_THEME_PRESET: ReadonlySet<string> = new Set(THEME_PRESETS);

/** 字段值不符合预期则丢弃该字段(走 DEFAULT_SETTINGS 兜底)。
 *  顶层非 object 返空对象,让外层 spread 拿全 DEFAULT_SETTINGS */
export function sanitizeAppSettings(raw: unknown): Partial<AppSettings> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const o = raw as Record<string, unknown>;
  const out: Partial<AppSettings> = {};

  if (typeof o.rootPath === 'string' && isAbsolute(o.rootPath)) {
    // rootPath 必须绝对(相对路径会基于 process.cwd() 解析)
    if (o.rootPath.length <= MAX_IPC_PATH_CHARS) {
      out.rootPath = o.rootPath;
    }
  }
  if (typeof o.dataPath === 'string') {
    // dataPath 也必须绝对:SETTINGS_PICK_DATA_PATH dialog 必返绝对、SETTINGS_MIGRATE_DATA
    // 已 isAbsolute 守卫,这里是兜底 IPC SETTINGS_UPDATE 整批 patch 注入
    // 已 @deprecated 但继续接受 — 丢弃会导致 initSettings 拿不到旧值做 rootPath 推导
    if (isAbsolute(o.dataPath) && o.dataPath.length <= MAX_IPC_PATH_CHARS) {
      out.dataPath = o.dataPath;
    }
  }
  if (typeof o.theme === 'string' && VALID_THEMES.has(o.theme)) {
    out.theme = o.theme as AppSettings['theme'];
  }
  if (typeof o.language === 'string' && VALID_LANGUAGES.has(o.language)) {
    out.language = o.language as AppSettings['language'];
  }
  if (typeof o.version === 'string' && o.version.length <= MAX_SETTINGS_FIELD_CHARS) {
    out.version = o.version;
  }
  if (
    o.workspaceLayout &&
    typeof o.workspaceLayout === 'object' &&
    !Array.isArray(o.workspaceLayout)
  ) {
    const wl = sanitizeWorkspaceLayout(o.workspaceLayout);
    if (wl) out.workspaceLayout = wl;
  }
  return out;
}

/** 启动加载 settings.json。thin wrapper 保留独立名字便于 grep 「加载路径」vs「更新路径」 */
export function sanitizeLoadedSettings(raw: unknown): Partial<AppSettings> {
  return sanitizeAppSettings(raw);
}

/** IPC SETTINGS_UPDATE patch。共享 sanitizeAppSettings 自动保证启动 / 更新同源 */
export function sanitizeSettingsPatch(raw: unknown): Partial<AppSettings> {
  return sanitizeAppSettings(raw);
}

function sanitizeWorkspaceLayout(raw: unknown): WorkspaceLayout | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const out: WorkspaceLayout = {};
  // `modified` 替代保留关键字 `any`,审计期发现 `any` shadowing
  let modified = false;
  // r242:sidebarCollapsed 复活 —— 只保留「左栏列表折叠」这一条(标题栏按钮 +
  //   ⌘B 切换)。detailCollapsed / activityBarHidden / zenMode 仍下线
  //   (右栏常驻无折叠,ActivityBar / zenMode 整体删除)。
  for (const key of ['statusBarHidden', 'sidebarCollapsed'] as const) {
    if (typeof o[key] === 'boolean') {
      out[key] = o[key];
      modified = true;
    }
  }
  if (typeof o.fontFamily === 'string' && VALID_FONT_FAMILY.has(o.fontFamily)) {
    out.fontFamily = o.fontFamily as WorkspaceLayout['fontFamily'];
    modified = true;
  }
  if (typeof o.themePreset === 'string' && VALID_THEME_PRESET.has(o.themePreset)) {
    out.themePreset = o.themePreset as WorkspaceLayout['themePreset'];
    modified = true;
  }
  return modified ? out : null;
}
