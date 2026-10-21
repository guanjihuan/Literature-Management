// src/renderer/src/lib/shortcut.ts
//
// audit v2.0 Phase 3b (2026-09-17):快捷键显示格式化 — 单一真相源。
//
// 之前 TitleBar / NotesList / LibraryList 各自把 `mod+N` 字符串字面量写到
// title attr(原生 tooltip),用户看到的"mod+N"是内部字符串,既不符号化(⌘)
// 也不分平台(macOS 应该显示 ⌘N,Windows/Linux 显示 Ctrl+N)。每个 callsite
// 都得自己写 if/else,drift 风险。
//
// 改:本文件暴露 `formatShortcut(shortcut)` 单一 helper,内部统一处理:
//   - 'mod'           → ⌘(mac) / Ctrl(Win/Linux)
//   - 'shift'         → ⇧(mac) / Shift(Win/Linux)
//   - 'alt'           → ⌥(mac) / Alt(Win/Linux)
//   - 'meta'          → ⌃(mac,显示兜底 control;audit-r124 校正,原注误写
//                        ⌘,实态见下方 mac 分支)/ Win(Win/Linux)
//   - 大写/标点 + Arrow = 原始字符
//   - '+' 分隔符 — mac 紧凑(⌘⇧S),Win/Linux 显式(Ctrl+Shift+S)
//
// 平台探测走 `window.api?.platform === 'darwin'`(启动期 platform 未就绪时
// fallback 到 'Ctrl',与 TitleBar 同款默认行为)。

import { api } from './api';

type Mod = 'mod' | 'shift' | 'alt' | 'meta';

/**
 * 把 electron 风格的快捷键字符串(`'mod+shift+S'`)格式化为平台原生符号
 * (`'⌘⇧S'` on macOS / `'Ctrl+Shift+S'` on Win/Linux)。
 *
 * 输入约束:与 [src/renderer/src/command/registry.ts] 的 `Command.shortcut`
 * 同款 — 只接受 mod / shift / alt / meta 4 个 modifier key,字母 / 数字 /
 * 标点直接透传。不校验未知 key(audit-r124 校正,原注承诺「后置 warn」
 * 从未实现):非 modifier 段取**最后一个**作 key,多段非法组合(如
 * 'mod+a+b')前者静默丢弃 —— 现存 caller 全部是单键组合,形态不触发。
 */
export function formatShortcut(shortcut: string | undefined | null): string {
  if (!shortcut) return '';
  const isMac = api?.platform === 'darwin';

  const parts = shortcut.split('+');
  const mods: Mod[] = [];
  let key = '';

  for (const p of parts) {
    const lower = p.toLowerCase();
    if (lower === 'mod' || lower === 'shift' || lower === 'alt' || lower === 'meta') {
      mods.push(lower as Mod);
    } else {
      key = p; // 保留原始大小写(Shift 修饰时大写语义由 layout 处理)
    }
  }

  // modifier 顺序固定 mod > shift > alt > meta(electron 内部一致)
  const order: Mod[] = ['mod', 'shift', 'alt', 'meta'];
  mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));

  if (isMac) {
    const macMods = mods
      .map((m) => {
        if (m === 'mod') return '⌘';
        if (m === 'shift') return '⇧';
        if (m === 'alt') return '⌥';
        return '⌃'; // meta 在 macOS 实际很少用,按 control 显示
      })
      .join('');
    return `${macMods}${key}`;
  }

  const winMods = mods
    .map((m) => {
      if (m === 'mod') return 'Ctrl';
      if (m === 'shift') return 'Shift';
      if (m === 'alt') return 'Alt';
      return 'Win';
    })
    .join('+');
  return winMods ? `${winMods}+${key}` : key;
}
