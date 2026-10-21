// tests/unit/shared/font-enum-single-source-parity.test.ts
//
// 守字体族枚举的**单一真相源**契约(2026-10-20,r229):
//
//   FONT_FAMILIES(src/shared/types.ts)是唯一权威列表;任何**手抄**了字体族
//   字面量的地方(zod schema / 命令注册表 / 设置页选项表)必须与它对齐。
//
// 为什么这条是行为面:字体族是「命令面板切字体 → 设置页下拉 → 设置持久化
// 校验」三段链路的共同输入。**漏改 zod schema 的后果最隐蔽** —— 用户选了
// 新字体,存盘时 strict schema 拒掉,字体设置**静默丢失**(没有任何报错)。
// 这与 r125 修掉的 theme 族是同一类病,当时已建哨兵
// tests/unit/shared/themes-enum-single-source-parity.test.ts;字体族当时漏了,
// 本轮补齐(同款结构:运行时契约 + 源码扫描双保险)。
//
// 本文件用「运行时契约 + 源码扫描」实现,不依赖被扫文件的内部结构:
//   1. tuple 非空 + 元素唯一;
//   2. types.ts 的 `type FontFamily = 'a' | 'b' | …` 联合类型与 tuple 同成员;
//   3. **zod 边界**:ZodWorkspaceLayout 接受每个 tuple 成员、拒绝 tuple 外的名字
//      (schema 手抄漂移 ⇒ 这里红);
//   4. **命令注册表**:buildCommands 为每个 tuple 成员注册且仅注册一条
//      `theme.setFont.<font>` 命令;
//   5. **设置页选项表**:FONT_TITLE_KEYS 的 key 集合 === tuple 成员集合;
//   6. **源码扫描**:src/ 下任何提到 'serif' / 'mono' 的括号组,必须提到
//      **全部** tuple 成员(加字族漏改副本站 ⇒ 红)。
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

import { FONT_FAMILIES, type FontFamily } from '../../../src/shared/types';
import { ZodWorkspaceLayout } from '../../../src/shared/schemas/settings';
import { buildCommands, type CommandActions } from '../../../src/renderer/src/command/registry';

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

/**
 * 字体族「有辨识度」的名字 —— 排除 'system'(与 theme 的 light/dark/system
 * 撞名,不能拿它当「这是字体族上下文」的判据)。
 */
// 显式标注 readonly FontFamily[] —— 否则 filter 的类型收窄会把元素类型
// 压成 ('serif'|'mono')[],后续拿 FontFamily 值去 includes 就报 TS2345。
const DISTINCTIVE: readonly FontFamily[] = FONT_FAMILIES.filter((f) => f !== 'system');

/** 组内出现的字体族名(引号字面量 + 裸标识符 —— `serif: '...'` 是裸键) */
function fontNamesIn(group: string): string[] {
  const quoted = [...group.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2] ?? '');
  const bare = [...group.matchAll(/\b([A-Za-z][\w-]*)\b/g)].map((m) => m[1]!);
  const found = new Set<string>();
  for (const t of [...quoted, ...bare]) {
    if ((FONT_FAMILIES as readonly string[]).includes(t)) found.add(t);
  }
  return [...found];
}

describe('字体族枚举单一真相源(r229)', () => {
  it('FONT_FAMILIES 非空且元素唯一', () => {
    expect(FONT_FAMILIES.length).toBeGreaterThan(0);
    expect(new Set(FONT_FAMILIES).size).toBe(FONT_FAMILIES.length);
  });

  it('types.ts 的 FontFamily 联合类型与 FONT_FAMILIES 同成员', () => {
    const typesSrc = readFileSync(join(ROOT, 'src/shared/types.ts'), 'utf8');
    const m = typesSrc.match(/export type FontFamily\s*=\s*([^;]+);/);
    expect(m, 'types.ts 里找不到 FontFamily 联合类型').not.toBeNull();
    const unionMembers = [...(m as RegExpMatchArray)[1].matchAll(/'([^']+)'/g)].map((x) => x[1]!);
    expect([...unionMembers].sort()).toEqual([...FONT_FAMILIES].sort());
  });

  it('zod 边界:每个 FONT_FAMILIES 成员都被 ZodWorkspaceLayout 接受', () => {
    for (const f of FONT_FAMILIES) {
      const r = ZodWorkspaceLayout.safeParse({ fontFamily: f });
      expect(r.success, `字体族 ${f} 应被 schema 接受(存盘被拒 = 字体设置静默丢失)`).toBe(true);
    }
  });

  it('zod 边界:tuple 外的字体名被 ZodWorkspaceLayout 拒绝', () => {
    const r = ZodWorkspaceLayout.safeParse({ fontFamily: 'comic-sans-not-a-real-family' });
    expect(r.success).toBe(false);
  });

  it('命令注册表:每个 FONT_FAMILIES 成员各注册一条 theme.setFont.<font> 命令', () => {
    const actions = {
      setActive: () => {},
      toggleStatusBar: () => {},
      // r240:新增的左栏折叠 action(CommandActions 的必填字段)
      toggleSidebar: () => {},
      setFontFamily: () => {},
      setThemePreset: () => {},
      toggleTheme: async () => {},
      openSettings: () => {},
      openSearch: () => {},
      saveActiveNote: () => {},
      newNote: () => {},
    } satisfies CommandActions;
    const cmds = buildCommands(actions);
    const fontCmdIds = cmds.map((c) => c.id).filter((id) => id.startsWith('theme.setFont.'));
    const expected = FONT_FAMILIES.map((f) => `theme.setFont.${f}`);
    expect([...fontCmdIds].sort(), '命令面板里的字体命令应与 FONT_FAMILIES 一一对应').toEqual(
      [...expected].sort(),
    );
  });

  it('设置页选项表:FONT_TITLE_KEYS 的 key 集合 === FONT_FAMILIES 成员集合', () => {
    const src = readFileSync(
      join(ROOT, 'src/renderer/src/components/settings/SettingsPage.tsx'),
      'utf8',
    );
    const m = /const FONT_TITLE_KEYS[^=]*=\s*\{([^}]*)\}/.exec(src);
    expect(m, 'SettingsPage.tsx 里找不到 FONT_TITLE_KEYS 表').not.toBeNull();
    const keys = [...(m as RegExpMatchArray)[1].matchAll(/\b([A-Za-z][\w-]*)\s*:/g)].map(
      (x) => x[1]!,
    );
    expect([...keys].sort()).toEqual([...FONT_FAMILIES].sort());
  });

  it('源码扫描:提到任一字体的括号组必须提到全部 FONT_FAMILIES 成员', () => {
    const violations: string[] = [];
    for (const file of walkTs(join(ROOT, 'src'))) {
      const src = readFileSync(file, 'utf8');
      for (const group of bracketGroups(src)) {
        const names = fontNamesIn(group);
        if (names.length === 0) continue;
        // 只在该组确实提到「有辨识度的字体名」时才算字体族上下文
        if (!names.some((n) => DISTINCTIVE.includes(n as FontFamily))) continue;
        const missing = FONT_FAMILIES.filter((f) => !names.includes(f));
        if (missing.length > 0) {
          violations.push(
            `${file.replace(ROOT, '.')}: 提到字体 ${names.join('/')} 但缺 ${missing.join('/')}`,
          );
        }
      }
    }
    expect(
      violations,
      `这些位置手抄了字体族却漏改(加字族时会静默漂移):\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});
