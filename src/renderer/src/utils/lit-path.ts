// 文献路径小工具(audit-r71)—— renderer 侧对 LiteratureResource.absPath 做
// 纯字符串拆解。不引 Node path(Electron 沙箱 renderer 没有),不引 fs。
//
// 为什么需要:lit 行的展示主键是文件本身(标题=去后缀文件名),但 UI 还要
// 完整文件名(带扩展名,区分 a.pdf / a.docx)、Reader 分发要的扩展名、右键
// 「在文件夹中显示」要的父目录。三处都是 split/pop 级别的操作,集中一份,
// LiteratureList 与 WorkbenchContentPanel 共用避免形状漂移。
//
// 分隔符:absPath 来自 OS(Windows 混用 \ 与 /),一律按 /[\\/]/ 切;
// 绝不从 id(lit: 前缀 + POSIX 化 '/')反推 fs 路径 —— id 只做 store key。

/** 'C:\data\a\b.pdf' → 'b.pdf';无分隔符时原样返回 */
export function filenameOf(absPath: string): string {
  return absPath.split(/[\\/]/).pop() ?? absPath;
}

/** 文件名的扩展名(带点、保留原大小写);无后缀返 ''。
 *  Reader 内部 normalizeExt 会再统一小写 + 补点,这里只做提取。 */
export function extOf(absPath: string): string {
  const name = filenameOf(absPath);
  const m = /\.[^.\\/]+$/.exec(name);
  return m ? m[0] : '';
}

/** 'C:\data\a\b.pdf' → 'C:\data\a'。找不到分隔符(裸文件名)返 '' —
 *  调用方(shell:open-path 空串会被主进程拒)应把 '' 视为「无父目录可展示」。 */
export function parentDirOf(absPath: string): string {
  const idx = Math.max(absPath.lastIndexOf('/'), absPath.lastIndexOf('\\'));
  if (idx < 0) return '';
  // audit-r86 (2026-10-17):根邻接文件,分隔符本身就是根,不能剥掉:
  //   - 盘根文件 'C:\f.pdf' → 'C:\';旧返回 'C:' 是 drive-relative 路径
  //     (指向该盘的"当前目录",cmd/PowerShell 语义),openPath 打开的
  //     位置随进程 CWD 漂移,几乎总不是用户期望的盘根。
  //   - POSIX 根文件 '/f.pdf' → '/';旧返回 '' 被上层当「无父目录」
  //     直传 api.openPath 被主进程拒,'/' 明明存在可开。
  if (idx === 2 && absPath[1] === ':') return absPath.slice(0, 3);
  if (idx === 0) return absPath[0];
  return absPath.slice(0, idx);
}
