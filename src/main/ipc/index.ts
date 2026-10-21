// IPC 注册汇总
import { registerSettingsIPC } from './settings';
import { registerLibraryIPC } from './library';
// audit-r71:文献功能重建 —— literature:list / import-from-file / delete 三通道。
// audit-r136:加 get-state + LiteratureService 注入(由 registerAllIPC 传单例)。
import { registerLiteratureIPC } from './literature';
import { registerNotesIPC } from './notes';
// 0007 虚拟文件夹:侧栏文件管理组织层(新建/重命名/删除/移动 + 资源改归属)
import { registerFoldersIPC } from './folders';
// 重构 (2026-09):registerAIIPC 已删除 —— AI 模块整体下线,
//   不再需要 IPC.AI_* 入口。
import { registerSearchIPC } from './search';
// 重构 (2026-08-28):registerCollectionsIPC 已删除 —— 分组并入 favorites;
//   favorites IPC 在 registerWorkspaceIPC 内注册(list / toggle / get-state +
//   changed push)。原「group 系列」invoke 已随 V1.4 分组只读化下线(audit-r73 注)。
import { registerWorkspaceIPC } from './workspace';
import { registerShellIPC } from './shell';
import { registerStartupIPC } from './startup';
import { registerBootstrapIPC } from './bootstrap';
import { registerWindowIPC } from './window';
import { getNotesService } from '../notes/service';
// audit-r136:literature service 注入 —— 与 notes 同款「module-level single,
//   ipc 收参 + 写路径共用」。register 阶段拿单例引用(还没 start),start 在
// bootstrap 的 Promise.allSettled 阶段调。
import { getLiteratureService } from '../literature/literature-service';

export function registerAllIPC() {
  registerSettingsIPC();
  registerLibraryIPC();
  registerLiteratureIPC(getLiteratureService());
  registerNotesIPC(getNotesService());
  registerFoldersIPC(getNotesService(), getLiteratureService());
  registerSearchIPC();
  registerWorkspaceIPC();
  registerShellIPC();
  registerStartupIPC();
  // perf(2026-08-22):启动期合并 IPC — 见 bootstrap.ts 注释
  registerBootstrapIPC();
  // 自定义无边框窗口控制(2026-09):最小化/最大化/关闭按钮的 IPC 入口。
  registerWindowIPC();
}
