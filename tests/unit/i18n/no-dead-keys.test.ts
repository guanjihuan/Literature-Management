// tests/unit/i18n/no-dead-keys.test.ts
//
// 守 r233「locale 键集合不得有死键」这条卫生契约。
//
// ── 为什么值得守 ─────────────────────────────────────────────────
//   renderer 的 t() 是**字符串寻址**,TS 永远不报错:功能下线时谁也不会
//   删 locale 键 ⇒ 键集合只涨不缩,r206 主进程字典清过一次(90→77),
//   renderer 字典从没清过。死键的代价:
//     ① 误导维护者 —— 看到 `modal.renameLiterature` 以为还有这个弹窗,
//        实际只有 `renameLiteratureConfirm` 活着(r233 实测);
//     ② 误导占位符契约 / locale parity 的排查面 —— 集合越大噪声越多;
//     ③ 翻译成本 —— 每加一个 locale 就要为死键多付一遍翻译。
//   r233 清掉的两条:`modal.renameLiterature`(ConfirmDialog 化后只剩
//   Confirm 键活着)、`folders.moveOutOfFolder`(「移出文件夹」功能自
//   disk-folder 改造后整段下线,只剩注释提到)。
//
// ── 扫描口径(先剥注释再匹配,注释提到 key 不算使用)───────────────
//   一个键算「活着」当且仅当 src/renderer 去注释源码里命中以下任一形态:
//     1. 字面量:t('ns.key') / t("ns.key") / t(`ns.key`);
//     2. 复数基:`notes.listCount_one/_other` 的基 `notes.listCount` 命中
//        字面量(i18next 按 count 自动拼后缀);
//     3. 前缀模板:源码出现 `t(`ns.${…}`)` ⇒ `ns.*` 整族视同 used
//        (settings.platform / startup.phase 靠这条);
//     4. tWithFallback('ns', …) 第一参是命名空间字面量 ⇒ `ns.*` 整族
//        视同 used(ErrorFallback 的 errorBoundary.* / toast.* 靠这条,
//        口径与组件头注的「调用形态不变式」一致)。
//   `_meta.*` 是结构字段(locale-parity 直接 JSON 读,不走 t()),豁免。
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const LOCALES_DIR = join(ROOT, 'src/renderer/src/i18n/locales');
const RENDERER_SRC = join(ROOT, 'src/renderer/src');

interface LocaleJson {
  [key: string]: unknown;
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

/** 剥掉注释 —— 注释里提到 key 不算使用(否则死键靠死注释「续命」)。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/;

/** 死键扫描:返回 src/renderer 里没有任何活引用的 locale 键。 */
export function findDeadLocaleKeys(locale: LocaleJson, strippedCorpus: string): string[] {
  const keys = flatKeys(locale);
  const hit = (s: string): boolean =>
    strippedCorpus.includes(`'${s}'`) ||
    strippedCorpus.includes(`"${s}"`) ||
    strippedCorpus.includes('`' + s + '`');
  const dead: string[] = [];
  for (const k of keys) {
    if (k.startsWith('_meta.')) continue;
    const base = k.replace(PLURAL_SUFFIX, '');
    if (hit(k)) continue;
    if (base !== k && hit(base)) continue;
    const ns = k.split('.').slice(0, -1).join('.');
    if (ns && (strippedCorpus.includes('`' + ns + '.${') || strippedCorpus.includes(`'${ns}.\${`)))
      continue;
    if (ns && strippedCorpus.includes(`tWithFallback('${ns}'`)) continue;
    dead.push(k);
  }
  return dead;
}

describe('renderer locale 无死键(r233)', () => {
  const zh = JSON.parse(readFileSync(join(LOCALES_DIR, 'zh-CN.json'), 'utf8')) as LocaleJson;
  const corpus = collectSourceFiles(RENDERER_SRC)
    .map((f) => stripComments(readFileSync(f, 'utf8')))
    .join('\n');

  it('zh-CN 每个键都在 src/renderer 有活引用(死键 = 功能已下线但键没删)', () => {
    const dead = findDeadLocaleKeys(zh, corpus);
    expect(dead, `死键(功能下线后忘删):\n  ${dead.join('\n  ')}`).toEqual([]);
  });

  it('en-US 同样无死键(两 locale 键集合 parity 已有守卫,这里双保险)', () => {
    const en = JSON.parse(readFileSync(join(LOCALES_DIR, 'en-US.json'), 'utf8')) as LocaleJson;
    const dead = findDeadLocaleKeys(en, corpus);
    expect(dead, `死键(功能下线后忘删):\n  ${dead.join('\n  ')}`).toEqual([]);
  });
});
