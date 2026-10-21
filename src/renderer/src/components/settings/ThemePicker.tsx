// ThemePicker — 设置页「主题预设」选择器(r247)
//
// 为什么不是一排 RadioChip:
//   15 个预设(扩到 15 档后)用文字芯片排成 flex-wrap,用户完全看不出
//   「这个配色长什么样」—— 只能一个个点下去试。配色选择器的本质是
//   **看颜色**,所以这里改成色卡网格:每张卡片带一块**真实配色**的缩略预览。
//
// 预览怎么做到「不复制一份颜色」:
//   globals.css 里预设块的选择器是 `:root[data-theme-preset='x'], [data-theme-preset='x']`
//   (r247 扩到「任意元素都能挂配方」)。所以给缩略图那个 div 挂上
//   `data-theme-preset="nord"`,它自己就会拿到 Nord 的整套 token,
//   子元素再从它继承 —— **色值只有 globals.css 一份**,预览不会漂移。
//   「默认」预设没有自己的配方,改挂 `data-theme-preview="dark|light"`
//   复用基础浅/暗两块,跟随用户当前的浅色/深色设置。
//
// 极性标记(☀ / 🌙 / 跟随)来自 PRESET_IS_DARK —— 那是全项目唯一的
// 明暗判断表(lib/theme.ts),别在 UI 侧另抄一份。

import { useTranslation } from 'react-i18next';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { THEME_PRESETS, type ThemePreset } from '@shared/types';
import { PRESET_IS_DARK } from '../../lib/theme';
import { useRadioGroup } from '../../hooks/useRadioGroup';
import { useSettingsStore } from '../../store/settings';
import { clsx } from '../../lib/clsx';

/**
 * 预设元数据 —— 显示名(i18n key)+ 可选的一句话说明。
 *
 * 键即预设 id:Record<ThemePreset, …> 编译期完备 —— 新增预设而忘了写元数据
 * 直接 TS 红(不会静默漏一项)。
 *
 * ⚠ 这里**必须列全所有预设**:tests/unit/shared/themes-enum-single-source-parity.test.ts
 * 有一条守卫 —— src/ 里凡是提到 ≥2 个预设名的括号组,必须提到全部预设名。
 * 少写一个 → 那条守卫红。这是刻意的:它挡的正是「加了新主题但某个副本站
 * 忘了跟」这类漂移(与 r125/r229 修的字体族手抄同款病根)。
 */
const PRESET_META: Record<ThemePreset, { titleKey: string; hintKey?: string }> = {
  default: { titleKey: 'settings.themePresetDefault', hintKey: 'settings.themeHintDefault' },
  'github-light': { titleKey: 'settings.themePresetGithubLight' },
  'github-dark': { titleKey: 'settings.themePresetGithubDark' },
  'solarized-light': { titleKey: 'settings.themePresetSolarizedLight' },
  'solarized-dark': { titleKey: 'settings.themePresetSolarizedDark' },
  'one-dark': { titleKey: 'settings.themePresetOneDark' },
  nord: { titleKey: 'settings.themePresetNord' },
  dracula: { titleKey: 'settings.themePresetDracula' },
  'tokyo-night': { titleKey: 'settings.themePresetTokyoNight' },
  'gruvbox-light': { titleKey: 'settings.themePresetGruvboxLight' },
  'gruvbox-dark': { titleKey: 'settings.themePresetGruvboxDark' },
  'catppuccin-latte': { titleKey: 'settings.themePresetCatppuccinLatte' },
  'catppuccin-mocha': { titleKey: 'settings.themePresetCatppuccinMocha' },
  sepia: { titleKey: 'settings.themePresetSepia', hintKey: 'settings.themeHintSepia' },
  'high-contrast': {
    titleKey: 'settings.themePresetHighContrast',
    hintKey: 'settings.themeHintHighContrast',
  },
};

/** 展示顺序 = THEME_PRESETS tuple 顺序(按色系家族分组,见 shared/types.ts 注释) */
export const PRESET_OPTIONS: ReadonlyArray<{
  id: ThemePreset;
  titleKey: string;
  hintKey?: string;
}> = THEME_PRESETS.map((id) => ({ id, ...PRESET_META[id] }));

/** 主题设置(浅色/深色/系统)→ 当前实际生效的极性 —— 只给「默认」预设的预览用 */
function resolveDark(theme: string | undefined): boolean {
  if (theme === 'light') return false;
  if (theme === 'dark') return true;
  // system:跟随 OS。jsdom 下没有 matchMedia → 按暗色兜底(与 App.tsx 的
  // 「无 matchMedia 即视为不支持跟随」保持同一退路)。
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  return true;
}

/** 极性图标 —— 明暗判断只认 PRESET_IS_DARK 一张表 */
function PolarityIcon({ preset }: { preset: ThemePreset }) {
  const forced = PRESET_IS_DARK[preset];
  if (forced === null) {
    return <Monitor size={12} aria-hidden="true" className="shrink-0 text-fg-muted" />;
  }
  return forced ? (
    <Moon size={12} aria-hidden="true" className="shrink-0 text-fg-muted" />
  ) : (
    <Sun size={12} aria-hidden="true" className="shrink-0 text-fg-muted" />
  );
}

/**
 * 配色缩略图 —— 用预设**自己的** token 画一个应用界面缩影:
 * 顶栏(raised)+ 侧栏(surface)+ 正文条(tertiary)+ 一条强调色(accent)。
 * 元素挂 data-theme-preset(非「默认」预设)或 data-theme-preview(默认预设)。
 */
function ThemeSwatch({ preset, dark }: { preset: ThemePreset; dark: boolean }) {
  const isDefault = preset === 'default';
  return (
    <div
      {...(isDefault
        ? { 'data-theme-preview': dark ? 'dark' : 'light' }
        : { 'data-theme-preset': preset })}
      className="relative h-14 w-full overflow-hidden rounded border border-border-subtle bg-bg-canvas"
    >
      <div className="absolute inset-x-0 top-0 h-2.5 bg-bg-raised" />
      <div className="absolute bottom-0 left-0 top-2.5 w-6 bg-bg-surface" />
      <div className="absolute left-8 top-6 right-3 space-y-1.5">
        <div className="h-1 w-9 rounded-full bg-accent" />
        <div className="h-1 w-full rounded-full bg-fg-tertiary/45" />
        <div className="h-1 w-2/3 rounded-full bg-fg-tertiary/25" />
      </div>
    </div>
  );
}

export interface ThemePickerProps {
  value: ThemePreset;
  onChange: (p: ThemePreset) => void;
  /** radiogroup 的 aria-labelledby 目标 id */
  labelledBy?: string;
  /** radiogroup 的 aria-describedby 目标 id */
  describedBy?: string;
}

export function ThemePicker({ value, onChange, labelledBy, describedBy }: ThemePickerProps) {
  const { t } = useTranslation();
  // 「主题」这一档(浅色/深色/系统)决定「默认」预设的预览长什么样
  const theme = useSettingsStore((s) => s.settings?.theme);
  const radio = useRadioGroup({
    tabs: PRESET_OPTIONS.map((p) => ({ id: p.id })),
    active: value,
    onChange: (id) => onChange(id as ThemePreset),
    orientation: 'both',
  });

  const forced = PRESET_IS_DARK[value];
  const polarityKey = forced === null ? null : forced ? 'settings.themePolarityDark' : 'settings.themePolarityLight';

  return (
    <div>
      <div
        {...radio.getContainerProps()}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        className="grid grid-cols-2 gap-2 sm:grid-cols-3"
      >
        {PRESET_OPTIONS.map((p) => {
          const item = radio.getItemProps(p.id);
          const isDefault = p.id === 'default';
          return (
            <button
              key={p.id}
              ref={item.ref}
              type="button"
              role="radio"
              aria-checked={item.selected}
              tabIndex={item.selected ? 0 : -1}
              onClick={item.onClick}
              className={clsx(
                'flex flex-col gap-1.5 rounded-md border p-1.5 text-left transition-colors duration-120',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                item.selected
                  ? 'border-accent bg-accent-dim/50'
                  : 'border-border-subtle hover:border-border-strong hover:bg-bg-hover',
              )}
            >
              <ThemeSwatch
                preset={p.id}
                dark={isDefault ? resolveDark(theme) : PRESET_IS_DARK[p.id] === true}
              />
              <span className="flex items-center gap-1 px-0.5">
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg">
                  {t(p.titleKey)}
                </span>
                <PolarityIcon preset={p.id} />
                {item.selected && (
                  <Check size={12} aria-hidden="true" className="shrink-0 text-accent" />
                )}
              </span>
              {p.hintKey && (
                <span className="px-0.5 text-2xs leading-tight text-fg-tertiary">{t(p.hintKey)}</span>
              )}
            </button>
          );
        })}
      </div>
      {polarityKey && (
        <p className="mt-2 text-2xs text-fg-tertiary">
          {t('settings.appearanceThemePresetFixed', { polarity: t(polarityKey) })}
        </p>
      )}
    </div>
  );
}
