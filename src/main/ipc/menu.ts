// src/main/ipc/menu.ts — 主进程 chrome (菜单 / 窗口 title) 的 IPC 入口
//
// 为什么需要这个 channel:
//   切换语言时,renderer 端 react-i18next 重渲 React tree 已覆盖所有 UI 文本,
//   但主进程持有两块不在 React 树里的 chrome:
//     1. 应用菜单(Electron Menu,在 OS 顶栏/菜单栏显示)
//     2. 窗口 title(任务栏 / Dock 显示)
//   这两块只能由主进程自己重建 —— IPC.MENU_REBUILD 让 renderer 在
//   i18n.changeLanguage 之后通知主进程"按当前 lang 重建"。
//
// 安全:
//   IPC handler 内部只读 settings.language,无外部输入参数;
//   走 handle<[]> 的标准 wrap,不引入额外校验负担。
import { BrowserWindow } from 'electron';
import { IPC } from '../../shared/types';
import { installAppMenu } from '../menu';
import { safeLang, t } from '../i18n';
import { handle } from './wrap';

/**
 * 按当前 settings.language 重建 chrome。
 * 暴露给 IPC handler 调用,也可在 settings store 改动后由主进程主动调。
 *
 * 用 safeLang 而非 getSettings().language —— 本函数调用点有两处:
 *   - bootstrap 完成 startup 之后(此时 settings 已 ready,走 fast path)
 *   - IPC.MENU_REBUILD handler(在 createWindow 之后,settings 必然 ready)
 * 但两处都依赖 settings 状态,bootstrap 内部 rebuild 紧跟 startup,理论上
 * settings 一定 ready,然而拿一个 try/catch 兜底不增成本且能让函数对未来
 * "先建窗口再 initSettings" 的重构天然免疫。
 */
export function rebuildChromeForLang(): void {
  const lang = safeLang();
  installAppMenu(() => BrowserWindow.getAllWindows()[0] ?? null, lang);
  // 任务栏 / Dock 标题同步切换 —— setTitle 不影响窗口内 TitleBar 组件
  // (TitleBar 显示的是 i18n 里的 titleBar.appTitle,已由 renderer i18next 处理)。
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.setTitle(t('window.title', lang));
    }
  }
}

/**
 * 注册菜单相关 IPC。单一 IPC:renderer 切语言后调一次。
 */
export function registerMenuIPC(): void {
  handle<[], void>(IPC.MENU_REBUILD, async () => {
    rebuildChromeForLang();
  });
}
