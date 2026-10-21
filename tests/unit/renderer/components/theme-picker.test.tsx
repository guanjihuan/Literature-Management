// tests/unit/renderer/components/theme-picker.test.tsx
//
// 守 r247「设置页主题选择器改成色卡网格」的行为契约。
//
// 背景:预设从 4 档扩到 15 档后,原来那排「文字芯片 + 一个小图标」完全
// 撑不住了 —— 15 个芯片换行铺满,用户看不出每个配色长什么样,只能一个个
// 点下去试。改成网格色卡后,每张卡片带一块**真实配色**的缩略预览。
//
// 本测锁的行为面:
//   A. radiogroup 语义完整(容器 role / 一张卡片 role=radio / 选中态唯一 /
//      roving tabindex)—— 键盘用户要能只用方向键切主题。
//   B. 点卡片 → 回调该预设 id(设置页据此落盘)。
//   C. 每张卡片的缩略图挂在**正确的 token 作用域**上:
//      具体预设挂 data-theme-preset="<id>",「默认」挂 data-theme-preview
//      (跟随当前浅色 / 深色设置)—— 预览色必须等于真正切过去后的配色。
//   D. 「默认」预设的预览跟随 settings.theme(light → light 预览)。
//   E. 选中「强制明暗」的预设时给出提示(否则上面的「浅色 / 深色」开关
//      看起来像失灵了)。
//   F. ThemePicker.tsx 里**不含任何硬编码颜色** —— 配色只有 globals.css
//      一份,预览不可能与真实主题漂移。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { readFileSync } from 'fs';
import { join } from 'path';

// i18n:只关心键名与插值结构,不在乎文案
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, string>) => (opts?.polarity ? `${k}[${opts.polarity}]` : k),
  }),
}));

// settings store:ThemePicker 只读 settings.theme(决定「默认」预设的预览极性)
vi.mock('../../../../src/renderer/src/store/settings', () => {
  const state = { settings: { theme: 'dark' } as { theme: string } };
  const useSettingsStore = ((selector?: (s: unknown) => unknown) =>
    selector ? selector(state) : state) as unknown as {
    (selector?: (s: unknown) => unknown): unknown;
    getState: () => unknown;
  };
  useSettingsStore.getState = () => state;
  return { useSettingsStore };
});

import { ThemePicker, PRESET_OPTIONS } from '../../../../src/renderer/src/components/settings/ThemePicker';
import { THEME_PRESETS } from '../../../../src/shared/types';

const ROOT = process.cwd();

function renderPicker(value: string = 'default') {
  const onChange = vi.fn();
  const utils = render(
    <ThemePicker
      value={value as never}
      onChange={onChange}
      labelledBy="preset-label"
      describedBy="preset-desc"
    />,
  );
  return { ...utils, onChange };
}

describe('主题选择器色卡网格(r247)', () => {
  beforeEach(() => {
    cleanup();
  });
  afterEach(() => {
    cleanup();
  });

  it('PRESET_OPTIONS 覆盖全部预设且顺序与 THEME_PRESETS 一致', () => {
    expect(PRESET_OPTIONS.map((p) => p.id)).toEqual([...THEME_PRESETS]);
  });

  it('容器是 radiogroup,每档一张 role=radio 卡片', () => {
    const { container } = renderPicker();
    const group = container.querySelector('[role="radiogroup"]');
    expect(group).not.toBeNull();
    expect(group?.getAttribute('aria-labelledby')).toBe('preset-label');
    expect(group?.getAttribute('aria-describedby')).toBe('preset-desc');
    const cards = container.querySelectorAll('[role="radio"]');
    expect(cards.length).toBe(THEME_PRESETS.length);
  });

  it('选中态唯一:只有当前预设 aria-checked=true 且 tabIndex=0', () => {
    const { container } = renderPicker('nord');
    const cards = Array.from(container.querySelectorAll('[role="radio"]'));
    const checked = cards.filter((c) => c.getAttribute('aria-checked') === 'true');
    expect(checked.length).toBe(1);
    expect(checked[0].getAttribute('tabindex')).toBe('0');
    for (const c of cards.filter((x) => x !== checked[0])) {
      expect(c.getAttribute('tabindex')).toBe('-1');
    }
  });

  it('点卡片回调该预设 id', () => {
    const { container, onChange } = renderPicker('default');
    const cards = Array.from(container.querySelectorAll('[role="radio"]'));
    fireEvent.click(cards[3]);
    expect(onChange).toHaveBeenCalledWith(THEME_PRESETS[3]);
  });

  it('具体预设的缩略图挂在 data-theme-preset 上(预览 = 真实配色)', () => {
    const { container } = renderPicker('default');
    for (const preset of THEME_PRESETS) {
      if (preset === 'default') continue;
      const scoped = container.querySelector(`[data-theme-preset="${preset}"]`);
      expect(scoped, `${preset} 的缩略图没有挂 data-theme-preset`).not.toBeNull();
    }
  });

  it('「默认」预设的缩略图跟随浅色 / 深色设置(而不是固定一档)', () => {
    const { container } = renderPicker('default');
    const scoped = container.querySelector('[data-theme-preview]');
    expect(scoped).not.toBeNull();
    expect(scoped?.getAttribute('data-theme-preview')).toBe('dark');
  });

  it('选中强制明暗的预设时提示「主题」开关对它无效', () => {
    const { container } = renderPicker('nord');
    expect(container.textContent).toContain('settings.appearanceThemePresetFixed');
    const { container: c2 } = renderPicker('default');
    expect(c2.textContent).not.toContain('settings.appearanceThemePresetFixed');
  });

  it('ThemePicker.tsx 里不含硬编码颜色(配色只有 globals.css 一份)', () => {
    const src = readFileSync(
      join(ROOT, 'src/renderer/src/components/settings/ThemePicker.tsx'),
      'utf8',
    );
    const hexes = src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(hexes, `色卡组件里不该有硬编码颜色: ${hexes.join(', ')}`).toEqual([]);
  });
});
