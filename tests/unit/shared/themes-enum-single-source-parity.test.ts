// tests/unit/shared/themes-enum-single-source-parity.test.ts
//
// 守 theme 枚举的**单一真相源**契约(2026-10-20,r201):
//
//   THEME_PRESETS(src/shared/types.ts)是唯一权威列表;任何**手抄**了主题
//   预设字面量的地方(命令注册表 / 设置页选项表 / 暗色配方表 / zod schema)
//   必须与它**逐个对齐**。
//
// 为什么这条是行为面:预设集合是"主题切换命令 → 设置页下拉 → 暗色配方表
// → 设置持久化校验"这四段链路的共同输入。新增一个预设却漏改其中一处时,
//   - 漏改命令注册表 → 命令面板里选不到新主题;
//   - 漏改暗色配方表 → Record<ThemePreset, …> 编译期就红(TS 兜底);
//   - 漏改 zod schema → 用户选了新主题,**存盘时被 strict schema 拒**,
//     主题设置静默丢失(最隐蔽的一种)。
//
// 本文件用「源码扫描」实现,不依赖被扫文件的内部结构:
//   1. 扫 src/ 下所有 .ts/.tsx 的**括号组**,凡是提到 ≥2 个不同预设名的组,
//      必须提到**全部**预设名(漏改即红);
//   2. types.ts 里的 `type ThemePreset = 'a' | 'b' | …` 联合类型与
//      THEME_PRESETS 必须同成员(运行时 tuple 与编译期 union 两份手抄);
//   3. 预设名不得出现「已不在 tuple 里的旧名字」(删预设漏改副本站);
//   4. 四处**已知**副本站(zod schema / 暗色配方表 / 命令注册表 / 设置页
//      预设元数据表)的预设集合与 tuple **完全一致**(不多不少)。
//      r247:设置页那一站搬到 components/settings/ThemePicker.tsx
//      (15 档预设改色卡网格,选项表随之搬家)。
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

import { THEME_PRESETS } from '../../../src/shared/types';

const ROOT = process.cwd();

/** 扫 src/ 下所有 .ts/.tsx */
function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkTs(full));
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** 取出源码里所有括号组的内容(含嵌套) */
function bracketGroups(src: string): string[] {
  const out: string[] = [];
  const stack: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') {
      stack.push(i);
    } else if (c === ')' || c === ']' || c === '}') {
      const start = stack.pop();
      if (start !== undefined) out.push(src.slice(start + 1, i));
    }
  }
  return out;
}

/** 组内出现的预设名(引号字面量 + 裸标识符 —— `default: null` 是裸键) */
function presetNamesIn(group: string, known: readonly string[]): string[] {
  const quoted = [...group.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2] ?? '');
  const bare = [...group.matchAll(/\b([A-Za-z][\w-]*)\b/g)].map((m) => m[1]);
  const found = new Set<string>();
  for (const t of [...quoted, ...bare]) {
    if (known.includes(t)) found.add(t);
  }
  return [...found];
}

/**
 * 取对象字面量**顶层**的键(嵌套对象里的键不算)。
 * PRESET_META 的每个条目是 `{ titleKey: …, hintKey: … }`,内层的 titleKey /
 * hintKey 不是预设名,必须排除 —— 否则抽取结果会多出两个「预设」。
 */
function topLevelKeys(body: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '{' || ch === '[' || ch === '(') {
      depth++;
      continue;
    }
    if (ch === '}' || ch === ']' || ch === ')') {
      depth--;
      continue;
    }
    if (depth !== 0) continue;
    const m = body.slice(i).match(/^\s*(?:'([^']+)'|([A-Za-z][\w-]*))\s*:/);
    if (m) {
      keys.push(m[1] ?? m[2]);
      i += m[0].length - 1;
    }
  }
  return keys;
}

describe('theme 枚举单一真相源(r201)', () => {
  it('THEME_PRESETS 非空且元素唯一', () => {
    expect(THEME_PRESETS.length).toBeGreaterThan(0);
    expect(new Set(THEME_PRESETS).size).toBe(THEME_PRESETS.length);
  });

  it('types.ts 的 ThemePreset 联合类型与 THEME_PRESETS 同成员', () => {
    const typesSrc = readFileSync(join(ROOT, 'src/shared/types.ts'), 'utf8');
    const m = typesSrc.match(/export type ThemePreset\s*=\s*([^;]+);/);
    expect(m, 'types.ts 里找不到 ThemePreset 联合类型').not.toBeNull();
    const unionMembers = [...(m as RegExpMatchArray)[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
    expect([...unionMembers].sort()).toEqual([...THEME_PRESETS].sort());
  });

  it('src/ 里凡是提到 ≥2 个预设的括号组,必须列全所有预设', () => {
    const known = [...THEME_PRESETS];
    const violations: string[] = [];
    for (const file of walkTs(join(ROOT, 'src'))) {
      const src = readFileSync(file, 'utf8');
      const rel = file.slice(ROOT.length + 1).replaceAll('\\', '/');
      for (const group of bracketGroups(src)) {
        const names = presetNamesIn(group, known);
        if (names.length >= 2 && names.length < known.length) {
          violations.push(`${rel} → 提到 [${names.join(', ')}],缺 [${known
            .filter((k) => !names.includes(k))
            .join(', ')}]`);
        }
      }
    }
    expect(violations, `以下位置手抄的主题预设与 THEME_PRESETS 不一致:\n${violations.join('\n')}`).toEqual(
      [],
    );
  });

  it('四处副本站的预设集合与 THEME_PRESETS **完全一致**(不多不少)', () => {
    // 定向抽取 4 个副本站 —— 「多一个」= 删预设漏改副本站,
    // 「少一个」= 加预设漏改副本站,两个方向都锁。
    //
    // r247 起两个副本站改成**引 SSOT** 而不是手抄(zod enum / 命令注册表),
    // 抽取器因此接受两种形态:
    //   - 手抄字面量 → 抽出字面量比对
    //   - 直接引用 THEME_PRESETS → 视为「恒等」(集合必然一致),但仍要求
    //     该引用真的存在 —— 否则「删了这行」会被当成通过。
    const expected = [...THEME_PRESETS].sort();
    const cases: Array<{ label: string; file: string; extract: (src: string) => string[] }> = [
      {
        label: 'zod schema(z.enum)',
        file: 'src/shared/schemas/settings.ts',
        extract: (src) => {
          if (/themePreset:\s*z\.enum\(THEME_PRESETS\)/.test(src)) return expected;
          const m = src.match(/themePreset:\s*z\.enum\(\[([^\]]*)\]\)/);
          expect(m, 'settings schema 里找不到 themePreset 的 z.enum').not.toBeNull();
          return [...(m as RegExpMatchArray)[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
        },
      },
      {
        label: '暗色配方表(PRESET_IS_DARK)',
        file: 'src/renderer/src/lib/theme.ts',
        extract: (src) => {
          const m = src.match(/PRESET_IS_DARK[^=]*=\s*\{([^}]*)\}/);
          expect(m, 'theme.ts 里找不到 PRESET_IS_DARK 表').not.toBeNull();
          const body = (m as RegExpMatchArray)[1];
          const quoted = [...body.matchAll(/'([^']+)'/g)].map((x) => x[1]);
          const bare = [...body.matchAll(/^\s*([A-Za-z][\w-]*)\s*:/gm)].map((x) => x[1]);
          return [...quoted, ...bare];
        },
      },
      {
        label: '命令注册表(presetIds)',
        file: 'src/renderer/src/command/registry.ts',
        extract: (src) => {
          if (/presetIds[^=]*=\s*\[\.\.\.THEME_PRESETS\]/.test(src)) return expected;
          const m = src.match(/presetIds[^=]*=\s*\[([^\]]*)\]/);
          expect(m, 'registry.ts 里找不到 presetIds 列表').not.toBeNull();
          return [...(m as RegExpMatchArray)[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
        },
      },
      {
        // r247:设置页的预设元数据搬到 components/settings/ThemePicker.tsx
        //   (15 档预设改色卡网格,不再用文字芯片列表)。
        label: '设置页预设元数据(PRESET_META)',
        file: 'src/renderer/src/components/settings/ThemePicker.tsx',
        extract: (src) => {
          const m = src.match(/PRESET_META[^=]*=\s*\{([\s\S]*?)\n\};/);
          expect(m, 'ThemePicker.tsx 里找不到 PRESET_META 表').not.toBeNull();
          return topLevelKeys((m as RegExpMatchArray)[1]);
        },
      },
    ];

    const bad: string[] = [];
    for (const c of cases) {
      const found = c.extract(readFileSync(join(ROOT, c.file), 'utf8'));
      const sorted = [...found].sort();
      if (sorted.join(',') !== expected.join(',')) {
        bad.push(`${c.label}(${c.file}) → [${sorted.join(', ')}] ≠ [${expected.join(', ')}]`);
      }
    }
    expect(
      bad,
      `以下副本站与 THEME_PRESETS 不一致:\n${bad.join('\n')}`,
    ).toEqual([]);
  });
});
