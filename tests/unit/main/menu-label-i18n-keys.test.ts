// tests/unit/main/menu-label-i18n-keys.test.ts
//
// 守卫(r206,2026-10-20):**主进程 i18n 字典 T 的完整性 + 无死键**。
//
// 背景:主进程有一套**独立于 renderer** 的最小 i18n ——
//   src/main/i18n-dict.ts 里的 `T: { key: { 'zh-CN':…, 'en-US':… } }`,
//   由 src/main/i18n.ts 的 t(key, lang) / tr(key) 解析。
//   它跟 renderer 那套 i18next(JSON 文件)是**两套不相干的系统**,各有各的坑:
//
//   ① **key 拼错 / 漏建 ⇒ 菜单栏露出裸 key**。resolveT 查不到就 `return key`,
//      所以 `t('menu.file.newNotee', lang)` 会把 "menu.file.newNotee" 直接
//      印在应用菜单上 —— 用户看到一串点号,不是文案。TS 不会报:key 是
//      纯 string。
//   ② **双语缺一侧 ⇒ 切语言后文案不换**(fallback zh-CN)。
//   ③ **两侧占位符不一致 ⇒ 切语言后少一段**(与 renderer 侧同款问题,
//      参见 tests/unit/i18n/placeholder-contract.test.ts)。
//   ④ **死键堆积** —— 特性下线后没人删的文案条目,躺在字典里误导后来人
//      「这个 key 好像还在用」。r206 实测 T 有 **13 条零引用**条目:
//      虚拟文件夹域 folder.*(7,随 migration 0008 drop_folders 退役)、
//      diskFolder.{notFound,moveFailed,invalidRelPath}(3)、
//      library.fileNotFoundPath / notes.dbSyncFailed /
//      common.menuActionFailed(后者与 renderer locale 同名 = 第二个真相源)。
//      本轮已删,并加本守卫防复涨。
//
// 与 renderer 侧守卫的分工:renderer 守「JSON 嵌套 locale + 复数变体」,
// 这里守「主进程扁平 T 字典」。两套系统结构不同,守卫也分开。
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { T, resolveT } from '@main/i18n-dict';

const ROOT = process.cwd();
const MAIN_DIR = join(ROOT, 'src/main');
const DICT_FILE = 'src/main/i18n-dict.ts';
const LANGS = ['zh-CN', 'en-US'] as const;

const PLACEHOLDER_RE = /\{([A-Za-z0-9_]+)\}/g;

function placeholdersOf(text: string): Set<string> {
  const out = new Set<string>();
  PLACEHOLDER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PLACEHOLDER_RE.exec(text)) !== null) out.add(m[1]);
  return out;
}

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkTs(full));
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** src/main 下(除字典文件本身)出现过的所有字符串字面量 */
function stringLiteralsInMain(): Set<string> {
  const out = new Set<string>();
  for (const file of walkTs(MAIN_DIR)) {
    const rel = file.slice(ROOT.length + 1).replaceAll('\\', '/');
    if (rel === DICT_FILE) continue;
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/'([A-Za-z0-9_.]+)'/g)) out.add(m[1]);
    for (const m of src.matchAll(/"([A-Za-z0-9_.]+)"/g)) out.add(m[1]);
  }
  return out;
}

/** 找出 t('x', lang) / tr('x') 形式引用了但 T 里没有的 key */
function missingKeysInCallSites(): string[] {
  const bad: string[] = [];
  const re = /\b(?:t|tr)\(\s*'([A-Za-z0-9_.]+)'/g;
  for (const file of walkTs(MAIN_DIR)) {
    const rel = file.slice(ROOT.length + 1).replaceAll('\\', '/');
    if (rel === DICT_FILE) continue;
    const src = readFileSync(file, 'utf8');
    src.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(re)) {
        const key = m[1];
        if (!(key in T)) bad.push(`  ${rel}:${i + 1} → ${key}`);
      }
    });
  }
  return bad;
}

describe('主进程 i18n 字典(r206)', () => {
  const dictKeys = Object.keys(T);

  it('字典非空,且每个条目两种语言都有值', () => {
    expect(dictKeys.length).toBeGreaterThan(0);
    const bad: string[] = [];
    for (const [key, entry] of Object.entries(T)) {
      for (const lang of LANGS) {
        const v = entry[lang];
        if (typeof v !== 'string' || v.length === 0) {
          bad.push(`  ${key} 缺 ${lang}`);
        }
      }
    }
    expect(bad.join('\n')).toBe('');
  });

  it('同一 key 的 zh-CN / en-US 占位符集合一致', () => {
    const bad: string[] = [];
    for (const [key, entry] of Object.entries(T)) {
      const a = placeholdersOf(entry['zh-CN'] ?? '');
      const b = placeholdersOf(entry['en-US'] ?? '');
      if (a.size !== b.size || [...a].some((x) => !b.has(x))) {
        bad.push(`  ${key}: zh=[${[...a].sort()}] en=[${[...b].sort()}]`);
      }
    }
    expect(bad.join('\n')).toBe('');
  });

  it('调用点引用的 key 必须在 T 里(否则菜单/对话框露出裸 key)', () => {
    const bad = missingKeysInCallSites();
    expect(bad.join('\n')).toBe('');
  });

  it('T 里不许出现零引用死键', () => {
    const literals = stringLiteralsInMain();
    const dead = dictKeys.filter((k) => !literals.has(k));
    expect(
      dead,
      `以下字典条目在 src/main 里零引用(特性下线后的遗留),请删除或接线:\n${dead.join('\n')}`,
    ).toEqual([]);
  });

  it('resolveT 行为:未知 key 原样返回 key 自身', () => {
    // 这条是上面「菜单露出裸 key」风险的**根因** —— 显式钉住,
    // 免得有人把 resolveT 改成抛错/返回空串,把风险从"难看"变成"崩"。
    expect(resolveT('definitely.not.a.key', 'zh-CN')).toBe('definitely.not.a.key');
    expect(resolveT('definitely.not.a.key', 'en-US')).toBe('definitely.not.a.key');
  });

  it('resolveT 行为:占位符按 params 替换', () => {
    expect(resolveT('validation.noteFilenameInvalidChars', 'zh-CN', { name: 'a/b' })).toContain(
      'a/b',
    );
    expect(resolveT('validation.noteFilenameInvalidChars', 'zh-CN', { name: 'a/b' })).not.toContain(
      '{name}',
    );
    // 少传参数 ⇒ 占位符原样留着(这正是调用点契约要拦的现象)
    expect(resolveT('validation.noteFilenameInvalidChars', 'zh-CN')).toContain('{name}');
  });

  it('menu.ts 里用到的每个 label key 都在 T 里', () => {
    const src = readFileSync(join(MAIN_DIR, 'menu.ts'), 'utf8');
    const bad: string[] = [];
    for (const m of src.matchAll(/\bt\(\s*'([A-Za-z0-9_.]+)'\s*,\s*lang\s*\)/g)) {
      const key = m[1];
      if (!(key in T)) bad.push(`  ${key}`);
    }
    expect(bad.join('\n')).toBe('');
  });

  it('扫描器非空转:至少扫到若干调用点与字典条目', () => {
    // 探针:防止上面几条因为「正则一个都没匹配上」而空过。
    const src = readFileSync(join(MAIN_DIR, 'menu.ts'), 'utf8');
    const hits = [...src.matchAll(/\bt\(\s*'([A-Za-z0-9_.]+)'\s*,\s*lang\s*\)/g)].map((m) => m[1]);
    expect(hits.length).toBeGreaterThan(3);
    expect(hits.every((k) => k in T)).toBe(true);
    expect(dictKeys.length).toBeGreaterThan(50);
  });
});
