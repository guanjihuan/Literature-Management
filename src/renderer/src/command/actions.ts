// 菜单 / 快捷键共用命令的 actions 构造器
import type { CommandActions } from './registry';
import { DEFAULT_SETTINGS, THEMES } from '@shared/types';
import { useWorkspaceStore } from '../store/workspace';
import { useSettingsStore } from '../store/settings';
import { useUiModals } from '../store/uiModals';

export function buildCommandActions(): CommandActions {
  return {
    setActive: (m) => useWorkspaceStore.getState().setActive(m),
    toggleStatusBar: () => useWorkspaceStore.getState().toggleStatusBar(),
    // r242:左栏折叠 / 展开 —— 标题栏按钮与 ⌘B 共用这一个 action,
    //   状态只有 workspace store 一份(不存在「按钮改了、快捷键没改」的漂移)。
    toggleSidebar: () => useWorkspaceStore.getState().toggleSidebar(),
    setFontFamily: (f) => useWorkspaceStore.getState().setFontFamily(f),
    setThemePreset: (p) => useWorkspaceStore.getState().setThemePreset(p),
    toggleTheme: async () => {
      // audit-r125:去 null 早退 —— TitleBar.cycleTheme 同族第二站(r122-b 修了
      // 点击面,命令面守卫从未跟上)。降级态(settings load 失败永久 null)旧代码
      // 静默 return,连 reject 都不产生,dispatcher H9「失败必须可见」无从谈起。
      // 回退起点引 DEFAULT_SETTINGS.theme;IPC reject 时 store.update throw 由
      // dispatcher.invoke 单点 catch 走 log.error + toast,此处不自带 catch。
      // 循环序取自 THEMES 单源(r125 哨兵锁,手抄禁绝)。
      const s = useSettingsStore.getState();
      const current = s.settings?.theme ?? DEFAULT_SETTINGS.theme;
      const next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
      await s.update({ theme: next });
    },
    openSettings: () => useUiModals.getState().setSettingsOpen(true),
    // ⌘⇧F 全局搜索面板入口 — 与 openSettings 同款 uiModals 开关模式
    openSearch: () => useUiModals.getState().setSearchOpen(true),
    // 从 WORKBENCH_EVENT CustomEvent 迁移到 store flag(与 pendingNewNote /
    // pendingRename / pendingFocus 同款),renderer 统一走 zustand store
    saveActiveNote: () => useWorkspaceStore.getState().requestSaveActiveNote(),
    newNote: () => {
      useWorkspaceStore.getState().setActive('notes');
      useWorkspaceStore.getState().requestNewNote();
    },
  };
}
