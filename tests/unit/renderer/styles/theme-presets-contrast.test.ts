// tests/unit/renderer/styles/theme-presets-contrast.test.ts
//
// 守 r247「15 档预设都按 WCAG 校准过」的**对比度**契约。
//
// 为什么要有这个守卫:
//   配色方案的「好不好看」很难自动判,但「看不看得清」可以。本守卫把每一档
//   配方的关键色对量成 WCAG 2.x 对比度,低于阈值就红 —— 于是
//   「新加一档配色,顺手把某个灰阶调暗了两档」这种事在 CI 就被拦住,
//   不用等用户来吐槽「Nord 下正文发灰看不清」。
//
// 阈值出处(WCAG 2.1):
//   - 正文级文字 4.5:1 (SC 1.4.3 AA)
//   - 大号文字 / 图形控件 / 焦点环 3:1 (SC 1.4.11)
//   - 状态色的「实心底 + 白字」= 正文级 ⇒ 4.5:1
//
// 语义分工(见 globals.css「状态色两槽」注释):
//   --success-rgb 等是「色」(图标 / 文字 / 描边);
//   --success-strong-rgb 等是「底」(实心按钮 / toast 底 + 白字)——
//   Dracula 的原色 #50FA7B 压白字只有 1.37:1,所以底必须走 strong 档。
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

import { THEME_PRESETS } from '../../../../src/shared/types';
import {
  parseTopLevelBlocks,
  findPresetBlock,
  findPreviewBlock,
  contrastRatio,
  token,
  WHITE,
  type ThemeBlock,
} from './theme-css';

const ROOT = process.cwd();
const CSS = readFileSync(join(ROOT, 'src/renderer/src/styles/globals.css'), 'utf8');
const blocks = parseTopLevelBlocks(CSS);

/** 每一档都要查的「块」:两块基础配方 + 14 档具体预设 */
function allThemeBlocks(): Array<{ name: string; block: ThemeBlock }> {
  const out: Array<{ name: string; block: ThemeBlock }> = [];
  for (const polarity of ['dark', 'light'] as const) {
    const b = findPreviewBlock(blocks, polarity);
    if (b) out.push({ name: `基础${polarity}`, block: b });
  }
  for (const preset of THEME_PRESETS) {
    if (preset === 'default') continue;
    const b = findPresetBlock(blocks, preset);
    if (b) out.push({ name: preset, block: b });
  }
  return out;
}

const THEMES = allThemeBlocks();

/** 收集不达标的项,统一报错(比逐条 expect 好读) */
function collect(
  themes: Array<{ name: string; block: ThemeBlock }>,
  check: (block: ThemeBlock) => { label: string; ratio: number; min: number },
): string[] {
  const bad: string[] = [];
  for (const { name, block } of themes) {
    const { label, ratio, min } = check(block);
    if (ratio < min) bad.push(`${name}: ${label} = ${ratio.toFixed(2)}:1 (< ${min}:1)`);
  }
  return bad;
}

describe('主题预设的 WCAG 对比度(r247)', () => {
  it('量到了全部 16 个配方块(2 基础 + 14 预设)', () => {
    expect(THEMES.length).toBe(16);
  });

  it('正文级文字 ≥ 4.5:1(fg / fg-secondary 压在主区 bg 上)', () => {
    const bad = collect(THEMES, (b) => ({
      label: 'fg vs bg',
      ratio: contrastRatio(token(b, 'fg-rgb'), token(b, 'bg-rgb')),
      min: 4.5,
    }));
    expect(bad, `正文对比度不足:\n${bad.join('\n')}`).toEqual([]);

    const bad2 = collect(THEMES, (b) => ({
      label: 'fg-secondary vs bg',
      ratio: contrastRatio(token(b, 'fg-secondary-rgb'), token(b, 'bg-rgb')),
      min: 4.5,
    }));
    expect(bad2, `次级文字对比度不足:\n${bad2.join('\n')}`).toEqual([]);
  });

  it('三级文字 ≥ 4.5:1(fg-tertiary 压在 header / tabs 的 bg-raised 上)', () => {
    const bad = collect(THEMES, (b) => ({
      label: 'fg-tertiary vs bg-raised',
      ratio: contrastRatio(token(b, 'fg-tertiary-rgb'), token(b, 'bg-raised-rgb')),
      min: 4.5,
    }));
    expect(bad, `三级文字对比度不足:\n${bad.join('\n')}`).toEqual([]);
  });

  it('弱化文字 ≥ 3:1(fg-muted 压在面板 bg-surface 上)', () => {
    const bad = collect(THEMES, (b) => ({
      label: 'fg-muted vs bg-surface',
      ratio: contrastRatio(token(b, 'fg-muted-rgb'), token(b, 'bg-surface-rgb')),
      min: 3,
    }));
    expect(bad, `弱化文字对比度不足:\n${bad.join('\n')}`).toEqual([]);
  });

  it('强调色 ≥ 3:1(accent 作为图标 / 焦点环 / 链接底)', () => {
    const bad = collect(THEMES, (b) => ({
      label: 'accent vs bg',
      ratio: contrastRatio(token(b, 'accent-rgb'), token(b, 'bg-rgb')),
      min: 3,
    }));
    expect(bad, `强调色对比度不足:\n${bad.join('\n')}`).toEqual([]);

    const bad2 = collect(THEMES, (b) => ({
      label: 'accent vs bg-raised',
      ratio: contrastRatio(token(b, 'accent-rgb'), token(b, 'bg-raised-rgb')),
      min: 3,
    }));
    expect(bad2, `强调色在 header 上对比度不足:\n${bad2.join('\n')}`).toEqual([]);
  });

  it('状态色 ≥ 3:1(作为文字 / 图标色时)', () => {
    for (const name of ['success', 'warning', 'danger']) {
      const bad = collect(THEMES, (b) => ({
        label: `${name} vs bg`,
        ratio: contrastRatio(token(b, `${name}-rgb`), token(b, 'bg-rgb')),
        min: 3,
      }));
      expect(bad, `${name} 对比度不足:\n${bad.join('\n')}`).toEqual([]);
    }
  });

  it('模块语义色 ≥ 3:1(侧栏模块图标 / 徽标)', () => {
    for (const name of ['module-library', 'module-notes']) {
      const bad = collect(THEMES, (b) => ({
        label: `${name} vs bg`,
        ratio: contrastRatio(token(b, `${name}-rgb`), token(b, 'bg-rgb')),
        min: 3,
      }));
      expect(bad, `${name} 对比度不足:\n${bad.join('\n')}`).toEqual([]);
    }
  });

  it('实心底 + 白字 ≥ 4.5:1(success-strong / warning-strong / danger-strong)', () => {
    for (const name of ['success-strong', 'warning-strong', 'danger-strong']) {
      const bad = collect(THEMES, (b) => ({
        label: `white vs ${name}`,
        ratio: contrastRatio(WHITE, token(b, `${name}-rgb`)),
        min: 4.5,
      }));
      expect(bad, `${name} 压白字对比度不足:\n${bad.join('\n')}`).toEqual([]);
    }
  });

  it('滚动条 thumb ≥ 3:1(压在面板 bg-surface 上)', () => {
    const bad = collect(THEMES, (b) => ({
      label: 'scrollbar-thumb vs bg-surface',
      ratio: contrastRatio(token(b, 'scrollbar-thumb-rgb'), token(b, 'bg-surface-rgb')),
      min: 3,
    }));
    expect(bad, `滚动条对比度不足:\n${bad.join('\n')}`).toEqual([]);
  });
});
