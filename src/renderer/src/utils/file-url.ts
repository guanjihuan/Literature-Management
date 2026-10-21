// 文件路径 → rkms:// URL 转换工具
// 从 PDFReader 提取为共享模块,供 ImageReader 等复用
//
// 为什么是 rkms:// 而不是 file:// :
//   - Chromium 89 起 file:// URL 全部按 opaque origin 处理,iframe /
//     fetch 跨父窗 origin 直接被拦;在 Electron 30 (Chrome 120) 里
//     即使父窗是 file://,PDFReader 的 iframe=file:// 也拿不到 PDF 字节,
//     PDFium 接管渲染失败,iframe 空白
//   - rkms 是主进程注册的 privileged scheme (standard + secure +
//     supportFetchAPI + corsEnabled),跟 http/https 一样走,iframe/img/
//     fetch 都能用
//   - 主进程 handler 把 rkms://xxx 翻成 net.fetch(pathToFileURL) ,由
//     Chromium file fetcher 实际读盘 — 跟直接 file:// 等价,但跨父窗
//     origin 不会卡

import { RKMS_SCHEME } from '@shared/protocol';

// 把绝对路径转成 rkms:// URL。
//   - 反斜杠 → 正斜杠
//   - 已经是 rkms:// URL 直接原样返回（避免二次 encode）
//   - 旧调用方 / 历史持久化数据可能塞进 file:// URL:不能 passthrough —
//     file:// 直接喂给 <iframe> 会被 Chromium 跨父窗 origin 拦截,PDF
//     加载不出来(就是这整个 rkms 修复要解决的那个 bug)。剥掉 scheme
//     后把内部路径递归走一遍正常路径,产出 rkms:// URL 走主进程 handler
//   - 路径段用 encodeURIComponent 处理：' '、'#'、中文等都正确转义
//   - Windows 盘符 `D:` 不参与 encode，否则冒号会被 encode 成 %3A
export function fileUrlOf(absPath: string): string {
  if (!absPath) return '';
  const forward = absPath.replace(/\\/g, '/');
  const lower = forward.toLowerCase();
  // passthrough:已经构造好的 rkms URL 直接返回,避免二次编码把 %20 再
  // 编一次。passthrough 用 lowercase 匹配,RKMS:// 大小写变体也认 —
  // 用户手写或拼写错误时不至于被错误"重编码"
  if (lower.startsWith(`${RKMS_SCHEME}://`)) return forward;
  // 防御:历史数据里塞进来的 file:// scheme 也不能直接 passthrough(见上方
  // 注释),剥掉 scheme 递归一遍。两种形态:
  //   - file:///D:/foo → 内部 '/D:/foo'   → 剥前导单 / → 'D:/foo'(走盘符分支)
  //   - file:////server/share/foo → 内部 '//server/share/foo'(走 UNC 分支,
  //     前导双 / 必须保留)
  if (lower.startsWith('file://')) {
    let inner = forward.slice('file://'.length);
    if (inner.startsWith('/') && !inner.startsWith('//')) inner = inner.slice(1);
    return fileUrlOf(inner);
  }

  // UNC 路径(Windows 网络共享 \\server\share\file.pdf)优先级高于其它分支:
  //   - 反斜杠转正斜杠后变成 `//server/share/file.pdf`
  //   - 必须保持前导 `//` 进 URL 的 pathname,否则 WHATWG URL 把 `server` 解析成
  //     authority,handler 里 pathToFileURL 拿到的是 `/share/file.pdf` 这种
  //     残缺路径,完全不是 UNC → 静默 500。
  //   - 拼成 rkms:// + //server/... = rkms:////server/...(4 个 /,2 个给
  //     authority marker,2 个给 pathname 的前导 //)。
  if (forward.startsWith('//')) {
    return `${RKMS_SCHEME}://` + encodePathSegments(forward);
  }

  // Windows 盘符:把 `D:` 抠出来单独保留,后面那段当 path 段处理
  const driveMatch = forward.match(/^([a-z]:)(.*)$/i);
  if (driveMatch) {
    return `${RKMS_SCHEME}:///` + driveMatch[1] + encodePathSegments(driveMatch[2]);
  }

  // POSIX:绝对路径已经有前导 /,拼 rkms:// 即可
  const prefix = forward.startsWith('/') ? `${RKMS_SCHEME}://` : `${RKMS_SCHEME}:///`;
  return prefix + encodePathSegments(forward);
}

// 按 / 切,逐段 encodeURIComponent。
// encodeURIComponent 不编码 '/',所以段间分隔符仍是斜杠。
// '()' 是 sub-delims,encodeURIComponent 不动,但 PDF iframe 接受,无需额外处理。
function encodePathSegments(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}
