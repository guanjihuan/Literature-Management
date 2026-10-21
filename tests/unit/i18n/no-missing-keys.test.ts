// tests/unit/i18n/no-missing-keys.test.ts
//
// 守「**代码里用的 i18n 键必须真的存在**」这条契约(no-missing-keys)。
//
// ── 为什么值得守(与 no-dead-keys 是镜像的一对)────────────────────
//   renderer 的 t() 是**字符串寻址**:写错一个字母,TS 不报错、eslint 不
//   报错、build 不报错 —— 只有真正渲染到那一处时,i18next 找不到 key,
//   **把 key 本身当文案印出来**。用户看到的是 `notes.svaeSucess` 这种
//   点号串,而不是「保存成功」。
//
//   与已有守卫的分工:
//     · locale-parity.test.ts  → zh 集合 == en 集合(漏译)
//     · no-dead-keys.test.ts    → locale 里的键都被代码用(死键)
//     · **本测**                → 代码里用的键都在 locale 里(缺键)
//   主进程侧有同款守卫:tests/unit/main/menu-label-i18n-keys.test.ts
//   (「调用点引用的 key 必须在 T 里」)。renderer 侧此前**没有**这面镜子:
//   r206 只在主进程字典上补过,renderer 的 JSON 侧一直裸奔。
//
// ── 扫描口径(与 no-dead-keys 对齐,免得两套口径互相打脸)───────────
//   先剥注释(注释里提到 key 不算使用),再扫 src/renderer/**/*.ts(x):
//     1. 字面量:t('ns.key') / t("ns.key") / t(`ns.key`) —— 键必须存在;
//     2. 复数基:代码写 'notes.listCount',locale 里是
//        'notes.listCount_one' / '_other' ⇒ 按 i18next 的复数后缀解析,
//        基键 + 任意一个复数变体存在即算命中;
//     3. 前缀模板:t(`ns.${…}`) ⇒ 要求 ns.* 至少有一个键存在
//        (settings.platform / startup.phase 走这条);
//     4. tWithFallback('ns', …) ⇒ 要求 ns.* 至少有一个键存在
//        (ErrorFallback 的 errorBoundary.* / toast.* 走这条)。
//   `_meta.*` 是结构字段(locale-parity 直接 JSON 读,不走 t()),不参与。
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const LOCALES_DIR = join(ROOT, 'src/renderer/src/i18n/locales');
const RENDERER_SRC = join(ROOT, 'src/renderer/src');

interface LocaleJson {
  [k: string]: unknown;
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

/** 收集 src/renderer 全部 .ts/.tsx(排除 locales 目录本身)。 */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (p.includes('locales')) continue;
      out.push(...collectSourceFiles(p));
    } else if (/\.(ts|tsx)$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

/** 剥掉注释 —— 注释里提到 key 不算使用。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

const PLURAL_SUFFIXES = ['_zero', '_one', '_two', '_few', '_many', '_other'];

/** 从源码里抽出「用到的字面量键」。 */
function findUsedKeys(corpus: string): string[] {
  const out = new Set<string>();
  // t('ns.key') / t("ns.key") / t(`ns.key`)
  const lit = /\bt\(\s*['"`]([A-Za-z0-9_.-]+)['"`]/g;
  let m: RegExpExecArray | null;
  while ((m = lit.exec(corpus)) !== null) out.add(m[1]!);
  return [...out];
}

/** 从源码里抽出「用到的模板命名空间」(t(`ns.${…}`) / tWithFallback('ns', …))。 */
function findUsedNamespaces(corpus: string): string[] {
  const out = new Set<string>();
  const tpl = /\bt\(\s*['"`]([A-Za-z0-9_-]+)\.\$\{/g;
  let m: RegExpExecArray | null;
  while ((m = tpl.exec(corpus)) !== null) out.add(m[1]!);
  const fb = /\btWithFallback\(\s*['"`]([A-Za-z0-9_-]+)['"`]/g;
  while ((m = fb.exec(corpus)) !== null) out.add(m[1]!);
  return [...out];
}

/**
 * 键是否存在 —— 复数基也算命中(i18next 按 count 拼 _one/_other 后缀)。
 */
function keyExists(keys: Set<string>, key: string): boolean {
  if (keys.has(key)) return true;
  return PLURAL_SUFFIXES.some((s) => keys.has(key + s));
}

export function findMissingKeys(locale: LocaleJson, usedKeys: string[], usedNamespaces: string[]): string[] {
  const keys = new Set(flatKeys(locale));
  const missing: string[] = [];
  for (const k of usedKeys) {
    if (k.startsWith('_meta.')) continue;
    if (!keyExists(keys, k)) missing.push(k);
  }
  for (const ns of usedNamespaces) {
    const hasAny = [...keys].some((k) => k.startsWith(`${ns}.`));
    if (!hasAny) missing.push(`${ns}.* (模板命名空间无任何键)`);
  }
  return missing.sort();
}

describe('renderer i18n 无缺键(用了但 locale 里没有 ⇒ 界面印出裸 key)', () => {
  const zh = JSON.parse(readFileSync(join(LOCALES_DIR, 'zh-CN.json'), 'utf8')) as LocaleJson;
  const en = JSON.parse(readFileSync(join(LOCALES_DIR, 'en-US.json'), 'utf8')) as LocaleJson;
  const corpus = collectSourceFiles(RENDERER_SRC)
    .map((f) => stripComments(readFileSync(f, 'utf8')))
    .join('\n');
  const usedKeys = findUsedKeys(corpus);
  const usedNamespaces = findUsedNamespaces(corpus);

  it('扫描器非空转:至少扫到若干调用点与命名空间(防空转守卫)', () => {
    expect(usedKeys.length).toBeGreaterThan(50);
    expect(usedNamespaces.length).toBeGreaterThan(0);
  });

  it('zh-CN:代码里用到的每个键都存在(缺键 = 界面印出 key 本身)', () => {
    const missing = findMissingKeys(zh, usedKeys, usedNamespaces);
    expect(missing, `zh-CN 缺键:\n  ${missing.join('\n  ')}`).toEqual([]);
  });

  it('en-US:代码里用到的每个键都存在(缺键 = 英文界面印出 key 本身)', () => {
    const missing = findMissingKeys(en, usedKeys, usedNamespaces);
    expect(missing, `en-US 缺键:\n  ${missing.join('\n  ')}`).toEqual([]);
  });
});
