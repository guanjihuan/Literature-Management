// src/shared/path-layout.ts
// 工作目录布局推导 — 单一真相。
//
// audit 2026-09-23:workspace-unification sub-phase 1 —— 给 rootPath 统一
//   布局(数据 + 笔记 + 收藏 + 设置)提供一个独立推导函数,代替散落在
//   各处的 `settings.dataPath` 直读。后续 sub-phase 把 notes/* / workspace/*
//   / ipc/* 逐个切到本模块,call site 永远写:
//     import { deriveNotesPath } from '@shared/path-layout';
//     const notes = deriveNotesPath(settings.rootPath);
//
//   本文件在 src/shared/ 下,必须同时被 main / preload / renderer 引用
//   (electron.vite.config.ts 给三端都配了 '@shared' 别名),所以**不能**
//   import Node 内置模块 —— renderer 的 Vite 构建不提供 `path` polyfill,
//   裸 `import { join } from 'path'` 会在打包时被 externalize,运行到
//   调用点才报 `join is not a function`,而且 typecheck / vitest 都发现不了
//   (两个环境都能解析 node_modules)。这与 src/shared/path-utils.ts 头部
//   声明的「零 fs / 零 Node path 模块依赖」是同一条约定。
//   2026-09-24 因此把 path.join 换成下面的零依赖 joinRootPath()。
//
// audit-r56:删 deriveLibraryPath —— 文献管理回归「按 path 读 bytes」,
//   没有「库」子目录(<rootPath>/library/)的规范位置了;后续代码不再需要
//   把 rootPath 拼成库绝对路径。剩余 notes / favorites / settings 三个推导
//   保留。

import { WORKSPACE_DATA_LAYOUT } from './types';

/**
 * 推断 rootPath 使用的路径分隔符。
 *
 * rootPath 的来源是 `app.getPath('documents')` / `dialog.showOpenDialog` /
 * settings.json 落盘值 —— 三者都是**主进程拿到的原生绝对路径**,所以分隔符
 * 可以直接从字符串形态反推,不需要 process.platform(shared 层拿不到,也不该拿)。
 *
 * 判定顺序:
 *   1. `C:\` / `c:/` 盘符 → win32
 *   2. `\\server\share`(含正斜杠写法)UNC 前缀 → win32
 *   3. 串内出现 `\` → win32(用户从别处粘进来的路径)
 *   4. 其余(含相对路径 'ResearchHub') → posix
 */
function detectSeparator(rootPath: string): '/' | '\\' {
  if (/^[a-zA-Z]:[\\/]/.test(rootPath)) return '\\';
  if (/^[\\/]{2}[^\\/]/.test(rootPath)) return '\\';
  if (rootPath.includes('\\')) return '\\';
  return '/';
}

/**
 * win32 下把 rootPath 规范化成全反斜杠形态。
 *
 * 必须做这步:`C:/Users/foo` 是 Windows 上极常见的形态(用户手改 settings.json、
 * 从聊天记录/环境变量粘路径),而 `path.join` 在 win32 下同样会把它规范化成
 * `C:\Users\foo`。只判断分隔符、不规范化 root 内部,会产出
 * `C:/Users/foo\library` 这种混合分隔符 —— fs API 多数时候还能吃,但
 * `safe-write.ts` 的 startsWith 白名单比对、IPC 侧字符串比较、
 * 以及把路径喂给外部工具(编辑器 / 引文管理器)时都会出问题。
 *
 * UNC 前缀(`\\server\share`)例外:开头两个反斜杠是语义的一部分,
 * 折叠成 `\` 会把网络共享打成非法路径,所以折叠后补回来。
 */
function normalizeWin32Root(root: string): string {
  let s = root.replace(/\//g, '\\');
  const isUnc = s.startsWith('\\\\');
  s = s.replace(/\\{2,}/g, '\\');
  return isUnc ? `\\${s}` : s;
}

/**
 * 零依赖的跨平台路径拼接,语义对齐 `path.join(root, ...segs)` 在本模块
 * 用到的子集(不解析 `..`、不碰 cwd、不读 fs)。
 *
 * 与 `path.join` 的差异(**有意为之**):
 *   - 不做 `..` / `.` 归一化。call site 传进来的 layout 常量都是编译期字面量
 *     ('library' / 'notes' / 'workspace/favorites' / 'settings.json'),
 *     不含 `..`;而 normalize 反而会让 `resolveInsideDataPath` 的白名单校验
 *     拿到与 caller 不同形态的字符串。这里只做「剥尾部多余分隔符 + 规范化 +
 *     补一个」。
 *   - 空 segment 跳过(等价 path.join 忽略空串)。
 *   - posix 侧不折叠重复分隔符(`//a` 保持 `//a`)—— Node posix 自身对双斜杠
 *     的保留规则与 UNC 无关,保持原样最省事。
 *
 * rootPath 允许带或不带尾部分隔符;结果不带尾部分隔符
 * (与 `path.join` 一致 —— `path.join('/a/','b')` === '/a/b')。
 */
function joinRootPath(rootPath: string, ...segments: string[]): string {
  const sep = detectSeparator(rootPath);
  // 剥掉 rootPath 尾部连续分隔符。`/` 与 `C:\` 剥完是空串 / 'C:',
  // 这两种都要保留 sep 作为前缀,否则 '/notes'(丢掉根) 或 'C:notes'(丢掉分隔符)。
  let base = rootPath.replace(/[\\/]+$/, '');
  if (base === '') base = sep;
  else if (sep === '\\') base = normalizeWin32Root(base);
  let out = base;
  for (const raw of segments) {
    // layout 常量可能是嵌套路径('workspace/favorites'),按两种分隔符切
    for (const seg of raw.split(/[\\/]+/)) {
      if (!seg) continue;
      out = out.endsWith(sep) ? out + seg : out + sep + seg;
    }
  }
  return out;
}

/**
 * 推导笔记目录 `<rootPath>/notes/` —— 替代散落的 join(dataPath, NOTES_DIR)。
 *
 * 兼容期说明:当前部分 call site 仍传旧 `dataPath` 而非 `rootPath`。这是
 * 有意的 —— `notes` 子目录在 v2 / v3 layout 下都是 dataPath 的直接子目录,
 * 所以同一个函数对两种入参都拼得出正确结果。sub-phase 3 把 call site 切到
 * `settings.rootPath` 之后,本函数只剩一种入参形态。
 */
export function deriveNotesPath(rootPath: string): string {
  return joinRootPath(rootPath, WORKSPACE_DATA_LAYOUT.NOTES_DIR);
}

/**
 * 推导 workspace 收藏目录 `<rootPath>/workspace/favorites/`。
 * FAVORITES_DIR 是嵌套字面量 'workspace/favorites',内部按分隔符切分后逐段拼。
 */
export function deriveFavoritesPath(rootPath: string): string {
  return joinRootPath(rootPath, WORKSPACE_DATA_LAYOUT.FAVORITES_DIR);
}
