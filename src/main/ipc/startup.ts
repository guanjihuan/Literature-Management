// Startup progress IPC handlers
// 当前只暴露 STARTUP_GET_STATE(invoke),STARTUP_PROGRESS 是 webContents.send 推送,
// 不需要 handler。renderer 在 mount StartupOverlay 时 invoke 一次拿 snapshot,
// 用来填补"主进程 push 已先于 renderer listener 注册"的竞态。
import { IPC, StartupProgressSnapshot } from '../../shared/types';
import { handle } from './wrap';
import { startupProgress } from '../startup-progress';

export function registerStartupIPC(): void {
  handle<[], StartupProgressSnapshot>(IPC.STARTUP_GET_STATE, () => startupProgress.snapshot());
}
