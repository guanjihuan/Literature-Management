// 工作台应用菜单构建。菜单点击 ≠ 直接执行 action:经 IPC.MENU_INVOKE 把 {id}
// 推给渲染层,CommandDispatcher.invoke(id) 走单一调度入口(命令面板/快捷键共享),
// 新增菜单项 = 改 registry + menu 各一处。
// macOS 与 Win/linux 菜单结构差异:macOS 顶部有 App 菜单(about/services/hide/quit),
// Win/linux 走 File.quit;Edit 内 cut/copy/paste 是 Electron role 自带本地化,不手动翻译。
// label 走 src/main/i18n.ts t();切语言由 renderer 调 IPC.MENU_REBUILD 重建。
import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from 'electron';
import { IPC } from '../shared/types';
import { t, type Lang } from './i18n';

type Sender = (id: string) => void;

/** 把菜单点击转换为 IPC 推送到当前窗口 */
function makeSender(getWindow: () => BrowserWindow | null): Sender {
  return (id: string) => {
    const w = getWindow();
    if (!w || w.isDestroyed()) return;
    w.webContents.send(IPC.MENU_INVOKE, { id });
  };
}

/** 构建工作台应用菜单(getWindow 支持返回 null,lang 切换时重建) */
export function buildAppMenu(getWindow: () => BrowserWindow | null, lang: Lang): Menu {
  const isMac = process.platform === 'darwin';
  const send = makeSender(getWindow);

  // macOS 顶栏第一项必须是 app.name(系统约定),只有它出现在应用菜单区
  const macAppMenu: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            {
              label: t('menu.preferences', lang),
              accelerator: 'CmdOrCtrl+,',
              click: () => send('settings.open'),
            },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        },
      ]
    : [];

  // File 菜单:Win/linux 文件菜单第一;macOS 紧跟 App 菜单
  const fileMenu: MenuItemConstructorOptions = {
    label: t('menu.file', lang),
    submenu: [
      {
        label: t('menu.file.newNote', lang),
        accelerator: 'CmdOrCtrl+N',
        click: () => send('file.newNote'),
      },
      // 「新建收藏夹」(⌘⇧N)2026-09 下线 — collections 并入 favorites
      // audit-r72:「重新扫描」(⌘R → library.rescan)死项删除 —— library 扫描
      //   面随 r56 退役,renderer command registry 里 'library.rescan' 已在
      //   r63 移除(menu:test 曾锁它),且 i18n.ts 无 'menu.file.rescan' 键 →
      //   t() 回退漏出 raw key。新表键-菜单一致性守卫见
      //   tests/unit/main/menu-label-i18n-keys.test.ts。
      { type: 'separator' },
      {
        label: t('menu.file.save', lang),
        accelerator: 'CmdOrCtrl+S',
        click: () => send('file.save'),
      },
      { type: 'separator' },
      isMac ? { role: 'close' } : { role: 'quit' },
    ],
  };

  // Edit 菜单:Electron role 提供原生 cut/copy/paste/undo/redo,自带系统本地化,
  // 不在 main i18n 里翻译。文本撤销走 macOS role:undo,由 textarea/input 自动处理,
  // 与命令系统互不干扰。
  const editMenu: MenuItemConstructorOptions = {
    label: t('menu.edit', lang),
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(isMac
        ? ([
            { role: 'pasteAndMatchStyle' },
            { role: 'delete' },
            { role: 'selectAll' },
          ] as MenuItemConstructorOptions[])
        : ([
            { role: 'delete' },
            { type: 'separator' },
            { role: 'selectAll' },
          ] as MenuItemConstructorOptions[])),
    ],
  };

  // View 菜单:⌘B(左栏折叠)于 r242 回归;⌘J / ⌘P / Zen 模式仍下线
  const viewMenu: MenuItemConstructorOptions = {
    label: t('menu.view', lang),
    submenu: [
      {
        // r242:左侧列表面板折叠 / 展开(与标题栏按钮、renderer ⌘B 同一个命令 id)
        label: t('menu.view.toggleSidebar', lang),
        accelerator: 'CmdOrCtrl+B',
        click: () => send('view.toggleSidebar'),
      },
      {
        label: t('menu.view.toggleStatusBar', lang),
        accelerator: 'CmdOrCtrl+Shift+S',
        click: () => send('view.toggleStatusBar'),
      },
      { type: 'separator' },
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
    ],
  };

  // Window 菜单
  const windowMenu: MenuItemConstructorOptions = {
    label: t('menu.window', lang),
    submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      ...(isMac
        ? ([{ type: 'separator' }, { role: 'front' }] as MenuItemConstructorOptions[])
        : ([{ role: 'close' }] as MenuItemConstructorOptions[])),
    ],
  };

  // Help 菜单:「访问文档」旧菜单项指 404 仓库已删;⌘? ShortcutsSheet 同步下线
  const helpMenu: MenuItemConstructorOptions = {
    role: 'help',
    submenu: [
      {
        label: t('menu.help.openSettings', lang),
        accelerator: 'CmdOrCtrl+,',
        click: () => send('settings.open'),
      },
    ],
  };

  // navigateMenu(⌘[/⌘]/⌘1..8)整体删除 — useTabsStore + TabsBar 下线,顶栏模块切换走快捷键
  const template: MenuItemConstructorOptions[] = [
    ...macAppMenu,
    fileMenu,
    editMenu,
    viewMenu,
    windowMenu,
    helpMenu,
  ];

  return Menu.buildFromTemplate(template);
}

/** 挂到当前应用,启动时调用一次。切语言时由 renderer 通过 IPC.MENU_REBUILD 重新调用 */
export function installAppMenu(getWindow: () => BrowserWindow | null, lang: Lang): void {
  Menu.setApplicationMenu(buildAppMenu(getWindow, lang));
}
