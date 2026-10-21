// tests/unit/renderer/styles/theme-presets-token-coverage.test.ts
//
// 守 r247「主题预设扩到 15 档」的**配方完整性**契约:
//
//   每档预设(除 default 外)在 globals.css 里都必须有一块自己的配方,
//   且该块必须把 **全部 28 个颜色 token** 都定义齐 —— 少一个,那个 token
//   就会**继承**自 :root(基础暗色 / 浅色配方),于是「选 Nord 却看到一截
//   基础暗色的灰」这种半吊子配色,而且极难被发现(只有切到那一档才看得见)。
//
// 为什么这是行为面而不是实现细节:
//   预设清单的真相源是 shared/types.ts 的 THEME_PRESETS;CSS 配方是它的
//   **另一半**。加了一档预设却忘了写 CSS ⇒ 用户在设置页点得到那一档,
//   主题「切了但没变」(或只变了一半)—— 这正是 r125 / r229 在字体族、
//   主题枚举上修过的同款漂移。
//
// 守卫点:
//   1. THEME_PRESETS 里每个非 default 预设都有对应的 CSS 块;
//   2. 每块(以及两块基础配方)都定义了全部必需 token;
//   3. 每块都声明了 color-scheme(浏览器原生控件 / 滚动条 / 表单跟随);
//   4. 没有「孤儿块」:CSS 里有、THEME_PRESETS 里没有的预设(删预设漏删 CSS)。
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

import { THEME_PRESETS } from '../../../../src/shared/types';
import {
  parseTopLevelBlocks,
  findPresetBlock,
  findPreviewBlock,
} from './theme-css';

const ROOT = process.cwd();
const CSS = readFileSync(join(ROOT, 'src/renderer/src/styles/globals.css'), 'utf8');

/**
 * 每一档配方必须定义齐的颜色 token。
 *
 * 分组与 globals.css 的设计 token 注释一一对应:
 *   背景 6 档 + 边框 4 档 + 文字 4 档 + 强调 3 档
 *   + 状态 6 个(色 / 实心底 各 3)+ 模块语义 2 + 遮罩 1 + 滚动条 1
 */
const REQUIRED_TOKENS = [
  // 背景层级
  'bg-rgb',
  'bg-canvas-rgb',
  'bg-surface-rgb',
  'bg-raised-rgb',
  'bg-hover-rgb',
  'bg-active-rgb',
  'bg-selected-rgb',
  // 边框
  'border-rgb',
  'border-subtle-rgb',
  'border-strong-rgb',
  'border-focus-rgb',
  // 文字四级灰阶
  'fg-rgb',
  'fg-secondary-rgb',
  'fg-tertiary-rgb',
  'fg-muted-rgb',
  // 强调
  'accent-rgb',
  'accent-hover-rgb',
  'accent-dim-rgb',
  // 状态色(色 / 实心底 两槽)
  'success-rgb',
  'success-strong-rgb',
  'warning-rgb',
  'warning-strong-rgb',
  'danger-rgb',
  'danger-strong-rgb',
  // 模块语义色 / 滚动条
  'module-library-rgb',
  'module-notes-rgb',
  'scrollbar-thumb-rgb',
] as const;

/**
 * 刻意**不**要求每档预设都定义的 token:
 *   overlay-scrim-rgb —— 遮罩层永远是纯黑(浅色主题上也是黑遮罩,这是
 *   桌面端通用做法)。它随 :root 继承即可,逐档重复写没有意义。
 */

const blocks = parseTopLevelBlocks(CSS);

describe('主题配方 token 完整性(r247)', () => {
  it('两块基础配方(暗 / 浅)定义了全部必需 token', () => {
    for (const polarity of ['dark', 'light'] as const) {
      const block = findPreviewBlock(blocks, polarity);
      expect(block, `globals.css 里找不到 [data-theme-preview='${polarity}'] 基础配方块`).toBeDefined();
      const missing = REQUIRED_TOKENS.filter((t) => !block!.tokens.has(t));
      expect(missing, `基础${polarity}配方缺 token: ${missing.join(', ')}`).toEqual([]);
    }
  });

  it('每档预设都有对应的 CSS 配方块', () => {
    const missing = THEME_PRESETS.filter((p) => p !== 'default' && !findPresetBlock(blocks, p));
    expect(missing, `这些预设没有 CSS 配方块(切过去会继承基础配方): ${missing.join(', ')}`).toEqual(
      [],
    );
  });

  it('每档预设都定义了全部必需 token', () => {
    const problems: string[] = [];
    for (const preset of THEME_PRESETS) {
      if (preset === 'default') continue;
      const block = findPresetBlock(blocks, preset);
      if (!block) continue; // 上一条已报
      const missing = REQUIRED_TOKENS.filter((t) => !block.tokens.has(t));
      if (missing.length) problems.push(`${preset} 缺 ${missing.join(', ')}`);
    }
    expect(problems, `预设配方不完整:\n${problems.join('\n')}`).toEqual([]);
  });

  it('每档预设都声明了 color-scheme(原生控件 / 滚动条跟随)', () => {
    const problems: string[] = [];
    for (const preset of THEME_PRESETS) {
      if (preset === 'default') continue;
      const block = findPresetBlock(blocks, preset);
      if (!block) continue;
      const scheme = block.decls.get('color-scheme');
      if (scheme !== 'light' && scheme !== 'dark') {
        problems.push(`${preset} → color-scheme=${String(scheme)}`);
      }
    }
    expect(problems, `这些预设没声明 color-scheme:\n${problems.join('\n')}`).toEqual([]);
  });

  it('没有孤儿预设块(CSS 里有、THEME_PRESETS 里没有的预设)', () => {
    const orphans: string[] = [];
    for (const block of blocks) {
      const m = block.selector.match(/\[data-theme-preset='([^']+)'\]/);
      if (!m) continue;
      if (!(THEME_PRESETS as readonly string[]).includes(m[1])) orphans.push(m[1]);
    }
    expect(orphans, `这些 CSS 预设块已不在 THEME_PRESETS 里(删预设漏删 CSS): ${orphans.join(', ')}`).toEqual(
      [],
    );
  });
});
