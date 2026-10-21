// tests/unit/i18n/locale-parity.test.ts
//
// 守卫:zh-CN.json / en-US.json 顶层键结构必须严格一致。
//   行为:把两文件扁平化到 dot 键(递归 object),两侧集合不同就 fail。
//   目的:防止漏译 / 拼错键名 —— 双 locale 同时被引,i18next 在缺的 key 上抛
//   警告并把 zh 当 fallback,renderer 看似正常但英文版回退中文,debug 极难。
//
// 已知 i18n stub:en-US 部分技术字面量(loadingDots '…')和 zh 相同是
//   预期 —— 不因此 fail。
//
// 历史:audit-r156 (2026-09-?) 起一直被守;r165-hotfix 收紧"两边 dict
//   完整性"语义后从 1 例失败拉到 1 例通过(去掉 en-US 9 个多余键)。
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

interface LocaleJson {
  [key: string]: unknown;
}

const LOCALES_DIR = resolve(__dirname, '../../../src/renderer/src/i18n/locales');

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

describe('i18n locale parity', () => {
  const zhPath = resolve(LOCALES_DIR, 'zh-CN.json');
  const enPath = resolve(LOCALES_DIR, 'en-US.json');
  const zh = JSON.parse(readFileSync(zhPath, 'utf8')) as LocaleJson;
  const en = JSON.parse(readFileSync(enPath, 'utf8')) as LocaleJson;
  const zhKeys = new Set(flatKeys(zh));
  const enKeys = new Set(flatKeys(en));

  it('zh-CN.json 和 en-US.json 顶层都读得到且是合法 JSON', () => {
    expect(typeof zh).toBe('object');
    expect(typeof en).toBe('object');
  });

  it('两 locale 的扁平键集合严格一致', () => {
    const onlyZh = [...zhKeys].filter((k) => !enKeys.has(k)).sort();
    const onlyEn = [...enKeys].filter((k) => !zhKeys.has(k)).sort();
    expect({ onlyZh, onlyEn }).toEqual({ onlyZh: [], onlyEn: [] });
  });

  it('两 locale 都有 _meta.code 字段(自我描述)', () => {
    const zhMeta = (zh as { _meta?: { code?: string } })._meta;
    const enMeta = (en as { _meta?: { code?: string } })._meta;
    expect(zhMeta?.code).toBe('zh-CN');
    expect(enMeta?.code).toBe('en-US');
  });
});
