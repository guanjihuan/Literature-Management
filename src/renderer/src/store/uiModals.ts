// UI 模态层共享开关(设置抽屉 + 搜索面板)
import { create } from 'zustand';

interface UiModalsState {
  settingsOpen: boolean;
  setSettingsOpen: (open: boolean) => void;
  // audit v2.0 Phase 3a (2026-09-17):Cmd+Shift+F 全局搜索面板 —
  //   与 settingsOpen 同款 ephemeral 布尔字段,持久化无意义。
  searchOpen: boolean;
  setSearchOpen: (open: boolean) => void;
}

export const useUiModals = create<UiModalsState>((set) => ({
  settingsOpen: false,
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  searchOpen: false,
  setSearchOpen: (open) => set({ searchOpen: open }),
}));
