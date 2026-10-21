// src/main/utils/scrub-internal.ts
//
// audit r52 (2026-10-15) C3:把 INTERNAL 错误消息里的用户路径替换为占位符,
// 防止 IPC wire 把家目录暴露到 renderer(以及任何 telemetry / Sentry 抓取
// IPC 错误日志的渠道)。
//
// 用法:仅在 `IpcErrorCode.code === 'INTERNAL'` 分支调用 —— AppError 已知
//   code(DUPLICATE_NAME / VALIDATION / NOT_FOUND 等)的消息一般不包含路径,
//   直接透传保留上下文。INTERNAL 分支的消息来源是 `errMsg(err)`(原始 Error
//   .message 或 String(err)),可能含「failed at C:\Users\foo\ResearchHub\...」
//   这类全路径,进 IPC 后被结构化日志全量记录,家目录泄露。
//
// 设计:本文件独立成 module(不放在 utils/error.ts)以避开循环依赖 ——
//   utils/error.ts 是被 safe-write 依赖的基础层,反过来 error.ts 不能 import
//   safe-write(否则 cycle)。把 scrubInternal 拆到独立文件,正常
//   `import { getRootPath } from './safe-write'`,import 链 error →
//   scrub-internal → safe-write → error 不成环(vitest mock 也能正常拦到
//   safe-write 替换 getRootPath)。
//
// 性能:split+join 走 V8 内部 O(n) 字符串扫描,500 字符以内实测 < 10µs,
//   IPC 错误路径非热路径,无 benchmark 意义。
//
// 测试:tests/unit/main/utils/scrub-internal.test.ts。
import { getRootPath } from './safe-write';
import { isCaseInsensitiveFs } from './platform';

/**
 * 把 INTERNAL 错误消息里的用户路径替换为 `<rootPath>`,并截断到 500 字符。
 *
 * - 替换 getRootPath() 全路径为占位符。getLibraryPath() 在 ADR-0003 后已下线,
 *   library 路径都从 getRootPath() 派,所以单点替换 root 即覆盖所有用户路径。
 * - 启动期 getRootPath() 未 init 时抛 —— try/catch 吞,scrub 不阻断。
 * - 截 500 字符:防止长 stack trace 全进 IPC(单条消息 5MB 炸 IPC buffer)。
 * - rootPath 路径前缀不重叠:`C:\Users\foo\ResearchHubX` 不能被误判为
 *   `C:\Users\foo\ResearchHub`。要求匹配后**必须是** path separator
 *   (Windows `\\` 或 POSIX `/`)或字符串末尾 —— 否则不动。子目录
 *   `ResearchHub\library\x.pdf` 命中(后跟 `\`),同前缀
 *   `ResearchHubX\y` 不命中(后跟 `X`,非 separator)。
 * - audit-r87:case-insensitive FS(win32/darwin)上大小写不敏感匹配。
 *   fs 错误消息原样回显**调用参数**,IPC 参数大小写由外部决定(用户粘贴
 *   路径 / 旧配置迁移 / shell 返回),与 settings 存的 root 字符串可不一致;
 *   同目录的 2^n 种大小写表示都要脱敏。与 path-compare「大小写差异 =
 *   同一目录」不变式对齐。POSIX 保持区分大小写(变体即不同路径)。
 */
export function scrubInternal(message: string): string {
  let root: string | null = null;
  try {
    root = getRootPath();
  } catch {
    root = null;
  }
  let out = message;
  // audit-r124:root 以分隔符结尾时(实测盘根配置下 getRootPath 可返回
  //   'C:\' 形态;任何 root+尾分隔符同理),旧 pattern
  //   `root(?=[\\/]|$)` 把 root 尾分隔符消费后再要求 lookahead 命中
  //   separator —— 'C:\Users\…' 里 'C:\' 之后的 'U' 不满足,整条消息
  //   一个字节都不脱敏,且静默。规约尾部分隔符后拼 lookahead 即正确:
  //   'C:' + (?=[\\/]) 对 'C:\Users\…' 命中,盘内全部路径归入 <rootPath>。
  //   规约后长度 < 2 仅剩 POSIX '/' 根(整盘皆内部,替换会吞所有绝对路径
  //   前缀)→ 保守跳过,记档于此。
  const rootCmp = root ? root.replace(/[\\/]+$/, '') : '';
  if (rootCmp.length >= 2) {
    // 全局替换 root 后必须是 separator 或 end-of-string:
    //   ResearchHub\library\x.pdf → <rootPath>\library\x.pdf  (✅ \ 跟后面)
    //   ResearchHubX\y           → ResearchHubX\y              (✅ X 非 separator)
    //   ...ResearchHub...        → ...<rootPath>...            (✅ end-of-string 在前)
    // 用 lookahead 而不是 consumed 字符,避免误吞 separator。
    // audit-r87:case-insensitive FS 上同目录有 2^n 种大小写表示,且 INTERNAL
    // 消息里的路径 = fs 原样回显**调用参数**(IPC 参数大小写由外部决定:
    // 用户粘贴路径 / 旧配置 / shell 返回),与 settings 存的 root 字符串
    // 大小写可不一致 → 区分大小写的 regex 会整条漏脱敏。'i' 只在
    // isCaseInsensitiveFs(win32/darwin)追加,POSIX 保持区分(变体=不同路径);
    // 与 path-compare「大小写差异 = 同一目录」的跨模块不变式对齐。
    const flags = isCaseInsensitiveFs ? 'gi' : 'g';
    out = out.replace(new RegExp(escapeRegExp(rootCmp) + '(?=[\\\\/]|$)', flags), '<rootPath>');
  }
  return out.length > 500 ? out.slice(0, 500) + '…' : out;
}

/**
 * 转义 RegExp 元字符,让 root 字符串(可能含 `\`,`.`,`$` 等)能直接做
 * 匹配 pattern 源。
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
