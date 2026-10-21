// 自定义窗口控制 IPC (2026-09)
//
// 动机:
//   主进程 BrowserWindow 用 frame:false + titleBarStyle:hidden 完全去掉原生 chrome,
//   渲染层 TitleBar 接管最小化/最大化/关闭按钮 + 拖拽区。这些操作必须在主进程做
//   (渲染层无 BrowserWindow 实例),所以通过 IPC 暴露。
//
// IPC 设计要点:
//   - minimize / maximize-toggle / close 走 handle<[], void> 常规包络
//     (audit-r124 校正,原注「单向 invoke 无返回值/失败主进程吞掉」不实:
//     wrap.ts ipcMain.handle 恒回 {ok,data};失败回 {ok:false} 且 r55 起
//     catch 兜底必有 log.error,并非吞掉)。void = data 无内容,渲染层
//     TitleBar.fireWindowControl 不消费返回值,失败对用户静默 —— 静默的
//     是 caller 侧语义,不是主进程吞异常
//   - isMaximized 是启动期一次性拉快照 — 渲染层 mount TitleBar 时拿初值,后续
//     由 maximize-changed 推送保持同步。和 STARTUP_GET_STATE 一个套路,避免
//     "主进程 push 已先于 renderer listener 注册"竞态。
//   - maximize-changed 是带布尔载荷的推送事件 — 渲染层仅当 changed=true 才换
//     maximize 图标,没变化时不响。
import { BrowserWindow } from 'electron';
import { IPC } from '../../shared/types';
import { handle } from './wrap';

export function registerWindowIPC(): void {
  handle<[], void>(IPC.WINDOW_MINIMIZE, (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    // isDestroyed 守卫:race 下 webContents 还指向已被 close 的 BrowserWindow
    //   (Renderer 关窗 + 主进程 close 几乎同时,IPC 仍能 invoke 进来)—— minimize
    //   在 destroyed window 上抛 "Object has been destroyed" 异常,wrap 把它
    //   归类为 INTERNAL,renderer 弹无意义 toast。改成静默 no-op。
    if (!win || win.isDestroyed()) return;
    win.minimize();
  });

  handle<[], void>(IPC.WINDOW_MAXIMIZE_TOGGLE, (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win.isDestroyed()) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });

  handle<[], void>(IPC.WINDOW_CLOSE, (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win.isDestroyed()) return;
    win.close();
  });

  handle<[], boolean>(IPC.WINDOW_IS_MAXIMIZED, (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win.isDestroyed()) return false;
    return win.isMaximized();
  });
}

/**
 * 在窗口创建后挂上 maximize-changed 推送。
 *
 * 不要在这里写 ipcMain.on — 调用方(createWindow)要在 webContents 加载之前
 * 注册 'maximize' / 'unmaximize' 监听,否则首次 maximize 事件可能错过。
 * createWindow 内部已经做 win.on('maximize', ...) / win.on('unmaximize', ...)。
 *
 * helper 抽出来是为了让 createWindow 集中放"窗口自身事件"的注册,
 * IPC 注册集中放 ipc/index.ts — 边界清晰。
 */
export function broadcastMaximizeChanged(win: BrowserWindow, maximized: boolean): void {
  if (win.isDestroyed()) return;
  win.webContents.send(IPC.WINDOW_MAXIMIZE_CHANGED, maximized);
}
