// 应用自身文档的 CSP 响应头注入 —— `frame-ancestors` 的**唯一生效位置**。
//
// 背景(audit r169,2026-10-19):
//   renderer/index.html 的 <meta> CSP 里长期挂着 `frame-ancestors 'none'`。
//   但 frame-ancestors 只在**响应头**里生效 —— 放在 <meta> 里 Chromium
//   直接忽略,并每次启动打一条 error:
//     "The Content Security Policy directive 'frame-ancestors' is ignored
//      when delivered via a <meta> element."
//   即该 directive 一直是**空操作**(防护从未生效),同时每次启动刷一条错。
//
// 实测(临时 Electron harness,2026-10-19,已删):
//   - 注入到 **file:// 文档**响应头 → **强制执行**:
//       "Refused to frame 'file:///' because an ancestor violates the
//        following Content Security Policy directive: "frame-ancestors 'none'""
//       + net::ERR_BLOCKED_BY_RESPONSE
//   - 注入到 **rkms:// 自定义 scheme** 响应头 → **不执行**(Chromium 只对
//     web 系 scheme 强制 frame-ancestors),<iframe src="rkms://…"> 照常 commit。
//   → 所以 frame-ancestors 只能、也只该加在**应用自身文档**上。
//
// 为什么不在 rkms:// 资源上加兜底(见 src/main/protocol.ts 同处注释):
//   那里加了今天也不生效;而一旦 Chromium 将来开始对自定义 scheme 强制,
//   PDFReader / ImageReader 的 <iframe src="rkms://…"> 会被自家 directive
//   打死 —— 收益为零、风险为正,故不加。本文件是对它的正确替代。
//
// 注入范围:仅 mainFrame(主文档)。
//   - 子资源(JS/CSS/图片)带 CSP 无意义;
//   - mainFrame 判定保证不误伤 rkms:// iframe 等 subFrame(它们各自有自己的
//     响应头策略)。
//   - 本 session 里的 mainFrame 只有应用主窗口(dev 下是 vite dev server 的
//     http://localhost:5173,prod 下是 file://),不存在第三方页面。
//
// 与 renderer/index.html 里 <meta> CSP 的关系:两者**并存生效**(多份 CSP
//   取交集)。meta 继续管 script-src / object-src / frame-src 等,本文件只
//   补 meta 表达不了的 frame-ancestors,互不替代。
import { session } from 'electron';

// 应用主文档的 CSP 响应头值。单独成常量便于测试断言与后续扩展。
export const APP_DOCUMENT_CSP = "frame-ancestors 'none'";

// 注入用的 URL 过滤:
//   - file://*/*                   prod 下 loadFile 加载的构建产物
//   - http://localhost:*/* 与 http://127.0.0.1:*/*   dev server(端口随机)
const DOCUMENT_URL_FILTER = ['file://*/*', 'http://localhost:*/*', 'http://127.0.0.1:*/*'];

/**
 * 在既有响应头基础上补上应用文档的 CSP。
 *
 * 纯函数(不碰 electron),便于单测直接断言。行为要点:
 *   - 大小写不敏感地清掉已有的 content-security-policy,避免与上游
 *     (如 vite dev server)自带的 CSP 叠成两条 —— 两条 CSP 取交集,
 *     上游那条若更严会把应用直接锁死,更松则两条都松(白写)。
 *   - 其余响应头原样保留。
 */
export function buildDocumentHeaders(
  existing: Record<string, string | string[]> | undefined
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = { ...(existing ?? {}) };
  for (const key of Object.keys(out)) {
    if (key.toLowerCase() === 'content-security-policy') delete out[key];
  }
  out['Content-Security-Policy'] = APP_DOCUMENT_CSP;
  return out;
}

/**
 * 给应用主文档装上 frame-ancestors 响应头。必须在 createWindow 之前调用
 * (首个文档请求就要带上),但可以在 app ready 之后(session 可用)。
 */
export function installDocumentCspHeaders(): void {
  session.defaultSession.webRequest.onHeadersReceived({ urls: DOCUMENT_URL_FILTER }, (details, callback) => {
    if (details.resourceType !== 'mainFrame') {
      callback({});
      return;
    }
    callback({ responseHeaders: buildDocumentHeaders(details.responseHeaders) });
  });
}
