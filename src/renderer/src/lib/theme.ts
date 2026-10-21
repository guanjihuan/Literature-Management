// src/renderer/src/lib/theme.ts
//
// 主题体系 — 两个正交维度:
//   - theme (light/dark/system) — 决定是否跟随系统颜色方案,定义在 AppSettings.theme
//   - themePreset — 颜色配方(r247 起 15 档,清单见 shared/types.ts 的
//     THEME_PRESETS),通过 document.documentElement[data-theme-preset] 切换
//
// 实现策略(2026-09-02 V1.5 翻转):
//   - :root 定义的就是 DARK 配方(VSCode / Linear 风格,暗色为默认)
//   - :root.light 显式覆盖为浅色配方 —— 用户选 light 时挂上
//   - 默认无 className = 暗色(零延迟,首屏直接走暗色,无 class 闪烁)
//   - applyTheme('light') → 加 .light
//   - applyTheme('dark')  → 移除 .light(走 :root 默认)
//   - applyTheme('system')→ 根据 prefers-color-scheme 决定加/去 .light
//   - themePreset 的 light 变体同样通过 [data-theme-preset] 覆盖 token,
//     App.tsx 在 effect 里把它当作"强制浅色 / 强制暗色"处理(挂/去 .light 类)
//
// 调用顺序:
//   App.tsx 启动后监听 settings.theme + useWorkspaceStore.themePreset,
//   任何变更都会触发 applyTheme + applyPreset 的 effect,DOM 同步。

// audit C3R33 (2026-08-22):FontFamily / ThemePreset 类型从 @shared/types 导入,
// 与 src/main/settings/validate.ts / src/renderer/src/store/workspace.ts 共用
// 单一真相源。theme.ts 这里只是 re-export 给 lib 内调用方
// (applyThemePreset / applyFontFamily / PRESET_IS_DARK) + 兼容既有外部 import。
// audit-r125:Theme 本地 alias(三档 union 手抄第 6 站)改引 @shared/types 单源
import type { FontFamily, Theme, ThemePreset } from '@shared/types';
export type { FontFamily, ThemePreset };

// 哪些预设是"暗色配方" — App.tsx 用这个表自动挂/去 .light 类
// (2026-09-02 V1.5):null = 不强制(沿用 theme);true = 强制暗色;false = 强制浅色
//
// r247:扩到 15 档。每加一个预设,**这里必须同时加一行** —— Record<ThemePreset,…>
// 是编译期完备的,漏加直接 TS 红(不会静默漏掉)。
//
// 这张表也是设置页配色选择器画「☀/🌙」极性标记的唯一依据
// (components/settings/ThemePicker.tsx),别在 UI 侧另抄一份明暗判断。
export const PRESET_IS_DARK: Readonly<Record<ThemePreset, boolean | null>> = {
  default: null, // 跟随 theme(浅色/深色/系统)
  'github-light': false,
  'github-dark': true,
  'solarized-light': false,
  'solarized-dark': true,
  'one-dark': true,
  nord: true,
  dracula: true,
  'tokyo-night': true,
  'gruvbox-light': false,
  'gruvbox-dark': true,
  'catppuccin-latte': false,
  'catppuccin-mocha': true,
  sepia: false,
  'high-contrast': true,
};

export function applyTheme(theme: Theme): () => void {
  const root = document.documentElement;
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = () => {
    // system + 浅色 OS → 加 .light;其他情况(暗色 OS / dark / light)按字面意思
    if (theme === 'dark') root.classList.remove('light');
    else if (theme === 'light') root.classList.add('light');
    else root.classList.toggle('light', !mq.matches);
  };
  apply();
  if (theme === 'system') {
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }
  return () => {};
}

/**
 * 切换主题预设 — 把 data-theme-preset 写到 <html>,CSS 用该选择器覆盖 token。
 * 返回副作用 cleanup 函数(无 listener 时返回空函数)。
 */
export function applyThemePreset(preset: ThemePreset): () => void {
  const root = document.documentElement;
  if (preset === 'default') {
    root.removeAttribute('data-theme-preset');
  } else {
    root.setAttribute('data-theme-preset', preset);
  }
  return () => {};
}

/** 切换全局字体族 — body 通过 [data-font-family] 选择器加载对应 font stack。 */
export function applyFontFamily(font: FontFamily): () => void {
  const root = document.documentElement;
  root.setAttribute('data-font-family', font);
  return () => {};
}
