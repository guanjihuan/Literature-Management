// 时间格式化工具 — 单一真相,避免各 View 重复内联 toLocaleDateString
//
// 设计:
//   - 所有可见字符串经 i18n —— 调用方把 t() 传进来(避免把 i18next 引入
//     此 lib 强制 caller 必须 useTranslation hook)
//   - timeAgo 用 i18n key 'time.justNow' / 'time.minutesAgo' / 'time.hoursAgo'
//     / 'time.daysAgo'
//   - 7+ 天回退走 Intl.DateTimeFormat + i18n lng 自动本地化(不强加 zh-CN)
//
// 历史:Dashboard / RecentView / ScratchpadView 已下线,StatusBar 也不再
//   显示相对时间(头注"V1.5 30s tick 刷新 X 分钟前"那块描述也是历史)。
//   现存调用方两站(audit-r124 校正,原文「唯一现存调用方是 NotesList」
//   自 LiteratureList:692 接入后已失真):NotesList / LiteratureList 的
//   行副文案。后续若做统计 / 概览模块可从 git 历史复活 formatDateLong/Short。

import type { TFunction } from 'i18next';

/**
 * 拿到 i18n 当前语言(lng)。i18next v23 把 .language 移到了 .resolvedLanguage
 * 之外的小细节导致 TFunction 类型签名不一致 —— 用类型拓宽到 i18next TFunction
 * & { language?: string },不强依赖任何具体版本字段。
 */
function currentLng(t: TFunction): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = t as TFunction & { resolvedLanguage?: string; language?: string };
  return fn.resolvedLanguage ?? fn.language ?? 'en';
}

/**
 * 把时间戳格式化为"刚刚 / X 分钟前 / X 小时前 / X 天前 / 日期" 五档渐进式描述。
 * 接受 ISO string 或 unix-ms number。空 / 非法输入返回 ''。
 * 用 Date.parse 而非 new Date(iso) — 后者对非 ISO 字符串更宽容,可能掩盖 bug。
 *
 * t: i18n t 函数(从 useTranslation() 拿)
 */
export function timeAgo(input: string | number, t: TFunction): string {
  let ts: number;
  if (typeof input === 'number') {
    ts = input;
  } else {
    ts = Date.parse(input);
    if (Number.isNaN(ts)) return '';
  }
  const diff = Date.now() - ts;
  // audit round 14 (2026-09-15):A11Y-002 — plural 形式。en-US 用
  //   'min' / 'mins' / 'hr' / 'hrs' / 'day' / 'days' 区分单复数;中文无
  //   形态变化但 i18next v23 仍走 _other 变体。
  // audit-r124 校正(原注描述的调用形态从未是本文件实态):这里调用
  //   **base key + count**,由 i18next plural resolver 内部再拼
  //   _one / _other suffix —— 不是「直接传 _one/_other key、无需 count」。
  //   由此源码里不会出现 t('time.minutesAgo_one') 字面量,locale 的
  //   suffix 键在 dead-key 扫描中是 false-positive,由
  //   i18n-dead-keys.test.ts 的白名单兜住(其注记与本注同口径)。
  if (diff < 60_000) return t('time.justNow');
  if (diff < 3_600_000) return t('time.minutesAgo', { count: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t('time.hoursAgo', { count: Math.floor(diff / 3_600_000) });
  if (diff < 7 * 86_400_000) return t('time.daysAgo', { count: Math.floor(diff / 86_400_000) });
  // 7+ 天 → 用本地化日期(走 Intl + 当前 i18n lng,不强加 zh-CN)
  return new Intl.DateTimeFormat(currentLng(t)).format(ts);
}
