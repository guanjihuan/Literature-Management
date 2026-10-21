// 拖入文件 → OS 绝对路径提取。
//
// fix drag-drop (2026-10-13):Electron 30 把 File.path 标 deprecated,32 彻底移除。
// 旧实现走 f.path,升级时 drop 静默失效(UI 显示「拖入内容不含可识别路径」/
// 「path is outside importable roots」)。修法:webUtils.getPathForFile 主路径,
// File.path 兜底,两路拿不到返 ''(与「跳过此 file」语义对齐)。
//
// 抽象到本文件的理由:
//   1) 行为级 guard:fallback 顺序一旦写反(优先 file.path),webUtils 路径被
//      旁路,Electron 升级时拖入仍坏但本地测试(老 Electron)仍过 — 锁在单文件
//      + 测试里,后续维护无法简单绕过
//   2) LiteratureList / NotesList 走同一份逻辑,避免一个修了另一个忘改的漂移
//      (旧 LibraryList 亦走这份;组件 r71 已删,audit-r73 更新措辞)
//
// 同步 API:path 提取 <1ms,无需 async 化让调用方多 await 一个 microtask

import { api } from './api';

// File.path 是 Electron 注入的非标准属性,老 Electron(<32) 兜底用
type FileWithPath = File & { path?: string };

/** 从拖入 / picker 拿到的 File 实例派生 OS 绝对路径。
 *  拿不到返 '' — 调用方应把空路径视为「跳过此 file」不送 IPC */
export function getDroppedFilePath(file: File): string {
  // 优先 webUtils:Electron 30+ 官方入口,沙箱 renderer 也能拿正确路径,
  // folder drop(把 folder 当 File 拖)的 File.path 在某些 Chromium 版本
  // 只给空串 / stale 路径,主路径更鲁棒
  // audit-r81 (2026-10-17) MEDIUM:裸 `api.getPathForFile(file)` 在桥缺失
  //   (外部浏览器开 dev server / 启动 race / mock 不全)时 Proxy.get 返回
  //   undefined → 同步 TypeError,本文件「拿不到返空串」契约作废,下面的
  //   legacy f.path 兜底成为死代码。属性读取安全,只有「调用」要 guard。
  //   锁 = tests/unit/renderer/lib/drop-bridge-missing.test.ts(真实 Proxy,
  //   不 mock api 模块 —— 旧 drop.test.ts 的 vi.mock 恰好绕开了这条路径)。
  //
  // r197:属性读取的 guard 有了,**调用**的 guard 仍然缺。preload 侧目前有
  //   try/catch(返 null),但「桥存在」≠「调用不抛」:preload 实现变化 /
  //   测试替身 / 用户在浏览器 dev server 里跑,都可能让调用抛异常。
  //   异常一旦逃出去,下面的 legacy f.path 兜底永远走不到,本文件的契约
  //   (「拿不到返 ''」)作废 ⇒ 整个 drop 流程炸掉,用户看到的是
  //   「拖进来没反应」而不是本文件承诺的可预期降级。
  let viaWebUtils: string | null | undefined;
  try {
    viaWebUtils = typeof api.getPathForFile === 'function' ? api.getPathForFile(file) : undefined;
  } catch {
    // 桥调用抛异常 → 当作「拿不到」,继续走 f.path 兜底
    viaWebUtils = undefined;
  }
  if (typeof viaWebUtils === 'string' && viaWebUtils.length > 0) {
    return viaWebUtils;
  }
  // 兜底:Electron < 30 没有 webUtils,preload try/catch 返 null 时 f.path 仍能用
  // 双重过滤把空串 / undefined 一并视为「不可用」— 绝不能把空串当路径送 IPC,
  // 会被 assertInsideAllowedRoot 当成相对路径处理,触发 dirname 解析错误
  const legacy = (file as FileWithPath).path;
  if (typeof legacy === 'string' && legacy.length > 0) {
    return legacy;
  }
  return '';
}

/** 批量版:把 FileList / File[] 压平为已过滤的 OS 路径数组。
 *  顺序保留:drop 多选顺序 = 用户在文件管理器里的多选顺序(Win/macOS 都是
 *  Ctrl/Cmd+click),importPaths IPC 原序消费,subdirectory 排序对调试日志 +
 * 部分导入文件时 toast 详情都有意义 */
export function collectDroppedPaths(files: FileList | File[]): string[] {
  const paths: string[] = [];
  for (const f of Array.from(files)) {
    const p = getDroppedFilePath(f);
    if (p) paths.push(p);
  }
  return paths;
}

/** 笔记面板专用三桶分类。NotesList 只接受 .md / .markdown,但**必须**把
 *  「文件没法派生 OS 路径」和「路径 OK 但非 .md」分开反馈 — 合并反馈会让
 *  用户在 Electron 升级后拖入合法 .md 仍被报「仅支持 .md 文件」误导排查。
 *
 *  - `paths`             .md / .markdown 大小写不敏感 + OS 路径能解析 → 喂 importFromFile
 *  - `invalidTypeNames`  后缀非 .md/.markdown → notes.dropInvalidType toast
 *  - `noPathNames`       文件**看起来是 .md** 但 OS 路径拿不到 → notes.dropNoPath
 *                        toast(典型:Electron 32+ 移除 f.path + webUtils 也没拿到)
 *                        fix r37 核心目标 — 旧 inline 把这两类塞同一个 rejectedNames,
 *                        根因被「仅支持 .md」话术掩盖
 *
 *  顺序保留语义同 collectDroppedPaths:返回数组下标对得上原 FileList,toast 文案
 *  按顺序拼,debug 时能从文件名定位哪一条 file 走的哪桶
 *
 *  audit r37 (2026-10-13):从 NotesList.tsx 内联抽出,行为级锁「无路径」必须
 *  不被「非 .md」吞掉。文献导入不需要这个分类(任意后缀都允许,非普通文件由
 *  主进程拒,不在 renderer 做后缀判定 —— 旧 LibraryList 同理,audit-r73 措辞更新) */
export function classifyDroppedNotesFiles(files: FileList | File[]): {
  paths: string[];
  invalidTypeNames: string[];
  noPathNames: string[];
} {
  const paths: string[] = [];
  const invalidTypeNames: string[] = [];
  const noPathNames: string[] = [];
  for (const f of Array.from(files)) {
    const p = getDroppedFilePath(f);
    const lower = f.name.toLowerCase();
    const isMd = lower.endsWith('.md') || lower.endsWith('.markdown');
    if (!isMd) {
      // 后缀非 .md → invalidType 桶,与「无路径」严格分开
      invalidTypeNames.push(f.name);
      continue;
    }
    if (!p) {
      // .md 但路径拿不到 → noPath 桶,与「非 .md」分开反馈
      noPathNames.push(f.name || '');
      continue;
    }
    paths.push(p);
  }
  return { paths, invalidTypeNames, noPathNames };
}
