// tests/unit/renderer/styles/theme-css.ts
//
// 主题 CSS 的最小解析工具(只给 theme-presets-*.test.ts 用,不是测试文件)。
//
// 为什么自己写解析器而不用 postcss:
//   依赖树里没有 postcss,为一个断言脚本引入一个解析器不划算;而本文件要读的
//   只是「顶层 CSS 块 + 块内的 `--token: R G B` 声明」,60 行足够且没有歧义。
//
// 解析结果:
export interface ThemeBlock {
  /** 块选择器原文(可能多行,已折叠空白) */
  selector: string;
  /** `--token 名 → [r, g, b]` */
  tokens: Map<string, [number, number, number]>;
  /** 块内的非颜色声明(如 color-scheme) */
  decls: Map<string, string>;
}

/** 从 globals.css 解析出所有顶层块 */
export function parseTopLevelBlocks(css: string): ThemeBlock[] {
  // 注释整体剥掉(含跨行注释 —— 里面的 `选择器写法 :root[data-theme-preset='x']`
  // 这种示例文字会被误当成真选择器)。
  const lines = css.replace(/\/\*[\s\S]*?\*\//g, '').split('\n');
  const out: ThemeBlock[] = [];
  let depth = 0;
  let selectorBuf: string[] = [];
  let current: ThemeBlock | null = null;

  for (const line of lines) {
    if (depth === 0) {
      // 块外:攒选择器文本(选择器可能跨多行,`:root,` 单独一行那种)
      const braceAt = line.indexOf('{');
      if (braceAt >= 0) {
        selectorBuf.push(line.slice(0, braceAt));
        const selector = selectorBuf.join(' ').replace(/\s+/g, ' ').trim();
        selectorBuf = [];
        current = { selector, tokens: new Map(), decls: new Map() };
      } else if (line.trim()) {
        selectorBuf.push(line);
      }
    } else {
      const decl = line.match(/^\s*([-a-z0-9]+)\s*:\s*([^;]+);/);
      if (decl && current) {
        const name = decl[1];
        const value = decl[2].trim();
        const rgb = value.match(/^(\d+)\s+(\d+)\s+(\d+)$/);
        if (name.startsWith('--')) {
          if (rgb) {
            current.tokens.set(name.slice(2), [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]);
          } else {
            current.decls.set(name, value);
          }
        } else {
          current.decls.set(name, value);
        }
      }
    }
    for (const ch of line) {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          if (current) out.push(current);
          current = null;
          selectorBuf = [];
        }
      }
    }
  }
  return out;
}

/** 找「选择器里带 [data-theme-preset='x']」的块 */
export function findPresetBlock(blocks: ThemeBlock[], preset: string): ThemeBlock | undefined {
  return blocks.find((b) => b.selector.includes(`[data-theme-preset='${preset}']`));
}

/** 找基础配方块([data-theme-preview='dark' | 'light']) */
export function findPreviewBlock(blocks: ThemeBlock[], polarity: 'dark' | 'light'): ThemeBlock | undefined {
  return blocks.find((b) => b.selector.includes(`[data-theme-preview='${polarity}']`));
}

// ── WCAG 对比度 ──────────────────────────────────────────────────────────

export type Rgb = [number, number, number];

function srgbToLin(c: number): number {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

export function relativeLuminance([r, g, b]: Rgb): number {
  return 0.2126 * srgbToLin(r) + 0.7152 * srgbToLin(g) + 0.0722 * srgbToLin(b);
}

/** WCAG 2.x 对比度(1..21) */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

export const WHITE: Rgb = [255, 255, 255];

/** 从块里取 token(缺了就 throw,调用方保证覆盖) */
export function token(block: ThemeBlock, name: string): Rgb {
  const v = block.tokens.get(name);
  if (!v) throw new Error(`块「${block.selector}」缺 token ${name}`);
  return v;
}
