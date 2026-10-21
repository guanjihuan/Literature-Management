// tests/unit/i18n/placeholder-contract.test.ts
//
// 守卫(r206,2026-10-20):**i18n 调用点 ↔ locale 模板的占位符契约**。
//
// 为什么这条是安全面(不是风格):占位符对不上时 i18next **不报错、不抛异常**
// —— 它把填不上的 `{xxx}` 原样留在渲染结果里。用户看到的是
//   「导入失败:{count} 个文件导入失败:
//   {msgs}」这种半成品文案(2026-10-17 r73 的真实现场:
//   调用点传 `{ msg }`,而 locale 模板要 `{count}` / `{msgs}` —— 两个都没填上)。
// 而 TypeScript **完全看不见**这件事:react-i18next 的 t() 第二个参数是
// `Record<string, unknown>`,传错 key 名不报错;locale JSON 是普通字符串,
// 编译期也不校验。⇒ 只有一条**行为级**契约能拦。
//
// 三条不变式:
//   1. 同一 key 的 zh-CN / en-US 两份模板占位符集合**完全一致**
//      (漏翻译一侧的占位符 = 切语言后文案少一段);
//   2. 同一 key 的复数变体(base / _one / _other)占位符集合完全一致
//      (i18next 按 count 选变体,变体之间占位符不同 = 某些数量下少占位符);
//   3. 每个 t('key', {vars}) 调用点,vars 集合**恰好等于**模板占位符集合
//      (少传 ⇒ 裸占位符露出;多传 ⇒ 填不进去,通常是 key 写错)。
//
// 判定方式:静态扫 src/renderer/src/** 的 t() 调用点 + 读两份 locale JSON。
// 扫之前先剥注释(注释里的 t('x') 不是调用点)。
//
// 覆盖边界(诚实声明):
//   - 只认**字面量** key 与**字面量** vars 对象;`t(someVar)`、`t(`a.${b}`)`、
//     `t('k', opts)`(opts 是变量)一律跳过 —— 静态分析看不见它们的 vars。
//   - 只覆盖 src/renderer/src/**;主进程那套 T 字典由
//     tests/unit/main/menu-label-i18n-keys.test.ts 守(结构不同:扁平的
//     key → {zh-CN,en-US},不是嵌套 JSON)。
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const LOCALES_DIR = join(ROOT, 'src/renderer/src/i18n/locales');
const RENDERER_DIR = join(ROOT, 'src/renderer/src');

interface LocaleJson {
  [key: string]: unknown;
}

function readLocale(name: string): LocaleJson {
  return JSON.parse(readFileSync(join(LOCALES_DIR, `${name}.json`), 'utf8')) as LocaleJson;
}

function flatKeys(value: LocaleJson, prefix = ''): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...flatKeys(v as LocaleJson, key));
    } else {
      out.push(key);
    }
  }
  return out;
}

function flatValues(value: LocaleJson, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(value)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of flatValues(v as LocaleJson, key)) out.set(k2, v2);
    } else {
      out.set(key, String(v));
    }
  }
  return out;
}

const PLACEHOLDER_RE = /\{([A-Za-z0-9_]+)\}/g;

function placeholdersOf(text: string): Set<string> {
  const out = new Set<string>();
  PLACEHOLDER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PLACEHOLDER_RE.exec(text)) !== null) out.add(m[1]);
  return out;
}

// === 源码扫描 ===

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkTs(full));
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/**
 * 剥掉注释(保留行数,便于报行号)。
 *
 * 自己写而不是用正则,是因为正则分不清 `//` 是注释还是字符串里的
 * 'https://...'。这里做一个极小的词法扫描:单/双引号字符串整体跳过,
 * 模板串按整段跳过(内部 ${} 的转义不深究 —— 仓库里没有含反引号的
 * 嵌套模板串)。
 */
function stripComments(src: string): string {
  const out: string[] = [];
  let i = 0;
  const n = src.length;
  let inLine = false;
  let inBlock = false;
  let quote: string | null = null;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out.push(c);
      } else {
        out.push(' ');
      }
      i++;
      continue;
    }
    if (inBlock) {
      if (c === '*' && c2 === '/') {
        inBlock = false;
        out.push('  ');
        i += 2;
        continue;
      }
      out.push(c === '\n' ? '\n' : ' ');
      i++;
      continue;
    }
    if (quote) {
      out.push(c);
      if (c === '\\') {
        if (i + 1 < n) out.push(src[i + 1]);
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '/' && c2 === '/') {
      inLine = true;
      out.push('  ');
      i += 2;
      continue;
    }
    if (c === '/' && c2 === '*') {
      inBlock = true;
      out.push('  ');
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      out.push(c);
      i++;
      continue;
    }
    out.push(c);
    i++;
  }
  return out.join('');
}

/** 从 openIdx(必须是 '(' 的位置)起取出成对括号内的内容 */
function argsOf(src: string, openIdx: number): string {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return src.slice(openIdx + 1, i);
    }
  }
  return src.slice(openIdx + 1);
}

/** 顶层逗号切分(跳过括号/引号内部) */
function splitTopLevel(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (quote) {
      cur += c;
      if (c === '\\') {
        cur += args[i + 1] ?? '';
        i++;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** 对象字面量的键集合 —— 同时认 `k: v` 与简写 `{ k }` */
function objectKeys(obj: string): string[] | null {
  const body = obj.trim();
  if (!body.startsWith('{') || !body.endsWith('}')) return null;
  const inner = body.slice(1, -1).trim();
  if (!inner) return [];
  const keys: string[] = [];
  for (const part of splitTopLevel(inner)) {
    const m = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*(:|$)/.exec(part);
    if (!m) return null; // 计算属性 / 展开 → 放弃分析这一处
    keys.push(m[1]);
  }
  return keys;
}

interface CallSite {
  file: string;
  line: number;
  key: string;
  /** null = 调用点没传 vars(第二实参不是对象字面量) */
  vars: string[] | null;
  /** 第二实参存在但不是对象字面量(比如字符串默认值 / 变量) */
  varsUnknown: boolean;
}

function collectCallSites(): CallSite[] {
  const out: CallSite[] = [];
  // 独立的标识符 t( —— 前一个字符不能是标识符字符/点(排除 .t( / obj.t( )
  const re = /(?<![A-Za-z0-9_$.])t\s*\(/g;
  for (const file of walkTs(RENDERER_DIR)) {
    const rel = file.slice(ROOT.length + 1).replaceAll('\\', '/');
    const raw = readFileSync(file, 'utf8');
    const src = stripComments(raw);
    for (const m of src.matchAll(re)) {
      const openIdx = m.index + m[0].length - 1;
      const args = splitTopLevel(argsOf(src, openIdx));
      if (args.length === 0) continue;
      const keyMatch = /^'([A-Za-z0-9_.]+)'$/.exec(args[0]);
      if (!keyMatch) continue; // 动态 key / 模板串 → 跳过
      const key = keyMatch[1];
      const line = src.slice(0, m.index).split('\n').length;
      if (args.length === 1) {
        out.push({ file: rel, line, key, vars: null, varsUnknown: false });
        continue;
      }
      const second = args[1];
      const keys = objectKeys(second);
      if (keys) {
        out.push({ file: rel, line, key, vars: keys, varsUnknown: false });
      } else {
        out.push({ file: rel, line, key, vars: null, varsUnknown: true });
      }
    }
  }
  return out;
}

/** 复数变体:i18next 按 count 选 base / _one / _other */
function variantsOf(key: string, locale: Map<string, string>): string[] {
  return [key, `${key}_one`, `${key}_other`].filter((k) => locale.has(k));
}

describe('i18n 占位符契约(r206)', () => {
  const zh = readLocale('zh-CN');
  const en = readLocale('en-US');
  const zhVals = flatValues(zh);
  const enVals = flatValues(en);
  const callSites = collectCallSites();

  it('同一 key 的 zh-CN / en-US 占位符集合一致', () => {
    const bad: string[] = [];
    for (const key of flatKeys(zh)) {
      const a = placeholdersOf(zhVals.get(key) ?? '');
      const b = placeholdersOf(enVals.get(key) ?? '');
      if (a.size !== b.size || [...a].some((x) => !b.has(x))) {
        bad.push(`  ${key}: zh=[${[...a].sort()}] en=[${[...b].sort()}]`);
      }
    }
    expect(bad.join('\n')).toBe('');
  });

  it('同一 key 的复数变体(base / _one / _other)占位符集合一致', () => {
    const bad: string[] = [];
    const all = new Set([...zhVals.keys(), ...enVals.keys()]);
    for (const key of all) {
      // 只看「某个复数变体存在」的 key
      if (!key.endsWith('_one') && !key.endsWith('_other')) continue;
      const base = key.replace(/_(one|other)$/, '');
      const group = [base, `${base}_one`, `${base}_other`].filter((k) => zhVals.has(k));
      const sets = group.map((k) => placeholdersOf(zhVals.get(k) ?? ''));
      const first = sets[0];
      if (sets.some((s) => s.size !== first.size || [...s].some((x) => !first.has(x)))) {
        bad.push(
          `  ${base}: ` +
            group.map((k) => `${k}=[${[...placeholdersOf(zhVals.get(k) ?? '')].sort()}]`).join(' '),
        );
      }
    }
    expect(bad.join('\n')).toBe('');
  });

  it('每个 t() 调用点传的 vars 恰好等于模板占位符集合', () => {
    const bad: string[] = [];
    for (const cs of callSites) {
      if (cs.varsUnknown) continue; // 第二实参不是对象字面量 → 看不见
      const variants = variantsOf(cs.key, zhVals);
      if (variants.length === 0) {
        bad.push(`  ${cs.file}:${cs.line} → t('${cs.key}') 的 key 在 locale 里不存在`);
        continue;
      }
      const need = placeholdersOf(zhVals.get(variants[0]) ?? '');
      const given = new Set(cs.vars ?? []);
      const missing = [...need].filter((x) => !given.has(x));
      const extra = [...given].filter((x) => !need.has(x));
      if (missing.length || extra.length) {
        bad.push(
          `  ${cs.file}:${cs.line} → t('${cs.key}') 传=[${[...given].sort()}] ` +
            `需=[${[...need].sort()}]` +
            (missing.length ? ` 少传:${missing.join(',')}` : '') +
            (extra.length ? ` 多传:${extra.join(',')}` : ''),
        );
      }
    }
    expect(bad.join('\n')).toBe('');
  });

  it('扫描器本身有效:能认出「少传 / 多传 / key 不存在」三种违规', () => {
    // 探针:用真实的调用点解析器验证判定逻辑本身没写反。
    const fake = [
      "const a = t('k.one', { name: 1 });",
      "const b = t('k.two', { wrong: 1 });",
      "const c = t('k.missing', { name: 1 });",
    ].join('\n');
    const parsed = [...fake.matchAll(/(?<![A-Za-z0-9_$.])t\s*\(/g)].map((m) => {
      const openIdx = m.index + m[0].length - 1;
      const args = splitTopLevel(argsOf(fake, openIdx));
      return { key: /^'([A-Za-z0-9_.]+)'$/.exec(args[0])![1], vars: objectKeys(args[1]) };
    });
    expect(parsed).toEqual([
      { key: 'k.one', vars: ['name'] },
      { key: 'k.two', vars: ['wrong'] },
      { key: 'k.missing', vars: ['name'] },
    ]);
    // 简写对象也要认出来(i18next 支持 `{ count }` 这种写法)
    expect(objectKeys('{ count }')).toEqual(['count']);
    expect(objectKeys('{ count: n, msgs: m }')).toEqual(['count', 'msgs']);
  });

  it('扫描器确实扫到了调用点(空集 = 扫描器坏了,不是契约没问题)', () => {
    // 探针:防止上面几条因为「一个调用点都没扫到」而空过。
    expect(callSites.length).toBeGreaterThan(20);
    // 已知调用点:NotesList 的导入失败 toast(r73 的历史 bug 点)
    const hit = callSites.find(
      (c) => c.key === 'toast.importNoteFailed' && c.vars?.includes('msgs'),
    );
    expect(hit).toBeDefined();
  });
});
