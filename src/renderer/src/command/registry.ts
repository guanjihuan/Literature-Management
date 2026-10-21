// 菜单 / 快捷键共用的"动作目录"。shortcut 字段是唯一真相源
// (buildShortcutBindings 消费,避免双源漂移)
import { FONT_FAMILIES, MODULE_KEYS, THEME_PRESETS, type ModuleKey } from '@shared/types';
import type { ThemePreset, FontFamily } from '../lib/theme';

export type CommandGroup = 'module' | 'view' | 'library' | 'settings' | 'general';

export interface Command {
  id: string;
  shortcut?: string;
  group: CommandGroup;
  run: (payload?: unknown) => void | Promise<void>;
  when?: () => boolean;
}

export interface CommandActions {
  setActive: (m: ModuleKey) => void;
  toggleStatusBar: () => void;
  /** r242:折叠 / 展开左侧列表面板(⌘B / Ctrl+B) */
  toggleSidebar: () => void;
  setFontFamily: (f: FontFamily) => void;
  setThemePreset: (p: ThemePreset) => void;
  toggleTheme: () => Promise<void>;
  openSettings: () => void;
  // ⌘⇧F 全局搜索面板入口(选 mod+shift+F 不选 mod+F — 与 F12 dev tools
  // 重叠,VSCode/Slack/Notion 业界都用 ⌘⇧F)
  openSearch: () => void;
  saveActiveNote: () => void | Promise<void>;
  newNote: () => void | Promise<void>;
}

export function buildCommands(actions: CommandActions): Command[] {
  const cmds: Command[] = [];

  // r217:模块清单走 @shared/types 的 MODULE_KEYS 单源(此前手抄字面量,
  //   与 ModuleKey union 靠注释对齐)。顺序是行为契约:⌘1 = library,⌘2 = notes。
  MODULE_KEYS.forEach((key: ModuleKey, idx: number) => {
    cmds.push({
      id: `module.${key}`,
      group: 'module',
      shortcut: `mod+${idx + 1}`,
      run: () => actions.setActive(key),
    });
  });

  cmds.push({
    id: 'file.save',
    shortcut: 'mod+S',
    group: 'general',
    run: () => actions.saveActiveNote(),
  });
  cmds.push({
    id: 'file.newNote',
    shortcut: 'mod+N',
    group: 'general',
    run: () => actions.newNote(),
  });

  cmds.push({
    id: 'view.toggleStatusBar',
    shortcut: 'mod+shift+S',
    group: 'view',
    run: () => actions.toggleStatusBar(),
  });

  // r242:左栏折叠 / 展开。⌘B / Ctrl+B —— VS Code / Notion 业界同款键位,
  //   主进程 View 菜单同 accelerator(菜单 accelerator 会被系统吃掉,
  //   renderer 这条是菜单缺失时的兜底,两者都指向同一个命令 id)。
  cmds.push({
    id: 'view.toggleSidebar',
    shortcut: 'mod+B',
    group: 'view',
    run: () => actions.toggleSidebar(),
  });

  // r247:主题预设引 SSOT(@shared/types 的 THEME_PRESETS tuple)——
  //   此前手抄 4 档,加预设时命令注册表不跟 ⇒ 命令面板选不到新主题
  //   (与 r229 修掉的字体族手抄同款)。哨兵:
  //   tests/unit/shared/themes-enum-single-source-parity.test.ts。
  const presetIds: ThemePreset[] = [...THEME_PRESETS];
  for (const preset of presetIds) {
    cmds.push({
      id: `theme.setPreset.${preset}`,
      group: 'settings',
      run: () => actions.setThemePreset(preset),
    });
  }
  // audit-r229:字体族引 SSOT(@shared/types 的 FONT_FAMILIES tuple)——
  //   此前手抄 ['system','serif','mono'],加字族时命令注册表不跟 ⇒ 命令面板
  //   选不到新字体(与 r125 修掉的 theme 族手抄同款)。哨兵:
  //   tests/unit/shared/font-enum-single-source-parity.test.ts。
  const fontIds: FontFamily[] = [...FONT_FAMILIES];
  for (const font of fontIds) {
    cmds.push({
      id: `theme.setFont.${font}`,
      group: 'settings',
      run: () => actions.setFontFamily(font),
    });
  }

  cmds.push({
    id: 'settings.open',
    shortcut: 'mod+,',
    group: 'settings',
    run: () => actions.openSettings(),
  });
  cmds.push({
    id: 'search.open',
    shortcut: 'mod+shift+F',
    group: 'general',
    run: () => actions.openSearch(),
  });
  cmds.push({
    id: 'settings.theme',
    group: 'settings',
    run: () => actions.toggleTheme(),
  });

  return cmds;
}
