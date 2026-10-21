// 自定义协议 rkms:// — 让 <iframe> / <img> 在任何父窗 origin 下稳定加载磁盘文件。
//
// 背景:Chromium 把 file:// 当 opaque origin(Chrome 89+),父窗是 file:// /
// http://localhost:5173 都跨域,iframe 被拦 → PDF / 图片空白。rkms:// 是
// privileged scheme(同 http/https),走 scheme 自己的 origin,不参与 file://
// 跨域判断。主进程用 pathToFileURL + net.fetch 把 rkms://xxx 翻成 file://xxx
// 交给 Chromium file fetcher 读盘,不需要 webSecurity:false。
//
// 调用顺序(Electron 强约束):
//   1. registerRkmsSchemePrivileges() 必须在 app.whenReady() resolve 之前
//   2. registerRkmsProtocolHandler() 必须在 app ready 之后、首窗 URL 之前
// 接入点见 src/main/index.ts。

import { protocol, net } from 'electron';
import { pathToFileURL } from 'node:url';
import { createLogger } from './utils/logger';
import { errMsg, errnoCode } from './utils/error';
import { RKMS_SCHEME } from '../shared/protocol';
// 共享 ipc/paths.ts:assertInsideAllowedRoot 替代内联 predicate,杜绝
// protocol.ts / shell.ts / reader.ts 三处独立写「rel === '' || (!rel.startsWith('..')
// && !isAbsolute(rel))」的语义漂移
// r191 更正:上面这行注释里点名的 reader.ts **当时并没有**接这份 helper
//   (只有本文件与 shell.ts 接了)⇒ library:readFileForReader 这条 IPC 比
//   iframe 侧更松,renderer 能读工作区外的任意文件。r191 已把 reader 的
//   handler(ipc/library.ts)补上白名单 —— 三处现在口径一致。
import { assertInsideAllowedRoot } from './ipc/paths';
import { contentDispositionInline } from './utils/content-disposition';

const log = createLogger('protocol');

// 必须在 app.whenReady 之前调用。privileges 决定 scheme 能不能像 http 一样走
// fetch / fetch API / CORS / stream,这里全部按 http 同级开
export function registerRkmsSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: RKMS_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
        // 不开 bypassCSP:renderer 没设 CSP,开了反而留攻击面;PDF / 图片也不需要
        // 绕过 CSP 跑脚本,Chromium PDFium 走内部 renderer
        bypassCSP: false,
      },
    },
  ]);
}

// 必须在 app ready 之后、createWindow 之前调用。
// macOS app.on('activate') 重入 createWindow() 时不需要重注册 — protocol.handle
// 第二次调用会替换 handler 但闭包内 log/状态不变,等价浪费一次 setter 跳变
export function registerRkmsProtocolHandler(): void {
  protocol.handle(RKMS_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      // pathname 三种形态:
      //   Windows drive: rkms:///D:/My%20Papers/p.pdf  → "/D:/My%20Papers/p.pdf"
      //   Windows UNC:   rkms:////server/share/p.pdf  → "//server/share/p.pdf"
      //   POSIX:         rkms:///home/user/p.pdf      → "/home/user/p.pdf"
      let decoded: string;
      try {
        decoded = decodeURIComponent(url.pathname);
      } catch {
        // 不完整 % 序列会让 decodeURIComponent 抛 URIError,冒到下方 catch 走
        // 500 + errMsg body 变成「URI malformed」探测 oracle;本地吞,返 400
        log.warn('rkms: malformed uri encoding', request.url);
        return new Response('rkms: malformed uri encoding', { status: 400 });
      }
      // Windows drive 要去前导 '/',否则 pathToFileURL 把它当 root 下的字面量
      // "D:" 而非盘符;POSIX 路径前导 '/' 必须保留;UNC 要把正斜杠翻反斜杠
      let absPath = decoded;
      if (process.platform === 'win32') {
        if (/^\/[A-Z]:\//i.test(decoded)) {
          absPath = decoded.slice(1);
        } else if (decoded.startsWith('//')) {
          absPath = decoded.replace(/\//g, '\\');
        }
      }
      // 白名单校验 — 防止 renderer 拿到任意路径都能读(iframe 内 fetch().text()
      // 可外泄 ~/.ssh/id_rsa)。settings 未初始化同样拒绝(403),不降级放行。
      // audit-r124 分支语义校正:EINVAL 的真实来源是 paths.ts:132
      //   'path required'(空串/非字符串路径);「settings 未初始化」实际由
      //   getRootPath 抛 INTERNAL 发出,落进下方通用 deny 分支。两分支结果
      //   都是 403,仅 body/log 归因不同 —— 原注把 EINVAL 当成
      //   「settings not ready」的专属信号是误标,protocol.test.ts:219 用
      //   合成 {code:'EINVAL'} 锁的正是本分支的 deny 行为(不变)。
      try {
        assertInsideAllowedRoot(absPath);
      } catch (err: unknown) {
        if (errnoCode(err) === 'EINVAL') {
          log.warn('rkms: invalid/empty path, denying request', request.url, errMsg(err));
          return new Response('rkms: settings not initialized', { status: 403 });
        }
        log.warn('rkms: path outside allowed roots, denying', absPath);
        return new Response('rkms: path not allowed', { status: 403 });
      }
      // .html / .htm / .svg / .xml 一律拒 — 即使没 frame-ancestors,Chromium
      // 也会按这些类型执行内联脚本 / SVG animation。library 不收录 HTML / SVG
      // 笔记(走 MarkdownReader / CodeReader),这里 deny 是「零误伤」
      const lowerName = absPath.toLowerCase();
      if (
        lowerName.endsWith('.html') ||
        lowerName.endsWith('.htm') ||
        lowerName.endsWith('.svg') ||
        lowerName.endsWith('.xml')
      ) {
        log.warn('rkms: refusing to serve scriptable content type', absPath);
        return new Response('rkms: content type not served', { status: 403 });
      }
      const upstream = await net.fetch(pathToFileURL(absPath).toString());
      // 克隆 headers 后再 mutate,避免污染 upstream 缓存
      const headers = new Headers(upstream.headers);
      // nosniff 防 Chromium 把 .svg 按内容嗅探成 text/html 跑内联脚本 ——
      // assertInsideAllowedRoot 不防 mime sniffing
      headers.set('X-Content-Type-Options', 'nosniff');
      // 这里**不**下发 Content-Security-Policy: frame-ancestors。
      // 实测(2026-10-19,Electron 30 / Chromium 124):Chromium 只对 web 系
      // scheme 强制 frame-ancestors,对 rkms:// 这类自定义 scheme **不强制**
      // —— 加了也不生效(实测 <iframe src="rkms://…"> 照常 commit)。
      // 反过来,若哪天 Chromium 改为强制,PDFReader / ImageReader 的
      // <iframe src="rkms://…"> 会被自家 directive 打死 —— 收益为零、
      // 风险为正,故不加。
      // 点击劫持防护改由**应用自身文档**的响应头承担(那才是 directive 唯一
      // 生效且被强制执行的位置),见 src/main/document-csp.ts。
      const baseName = absPath.split(/[\\/]/).pop() ?? 'file';
      // 不能裸拼文件名:header value 必须是 ByteString(≤U+00FF),
      // U+2019(’)/ U+2013(–)/ 中文 等字符会让 Headers.set 当场 throw
      // TypeError「Cannot convert argument to a ByteString」⇒ 冒到外层
      // catch 返 500 ⇒ Reader 探测 fetch 拿 500 ⇒ 「打开失败」错误页
      // (2026-10-20 实证,见 utils/content-disposition.ts 头注)。
      headers.set('Content-Disposition', contentDispositionInline(baseName));
      // 显式补 Content-Type:file fetcher 在精简 OS(Windows / Linux 缺 mime-db)
      // 会回退 application/octet-stream,nosniff 下浏览器拒渲染(PDF 看不到内容)
      const explicitType = contentTypeFor(absPath);
      if (explicitType) {
        headers.set('Content-Type', explicitType);
      }
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers,
      });
    } catch (err: unknown) {
      // 不抛 — handler 抛错让 Electron 把请求视为失败,iframe/img 看到
      // src.onerror 而非更具体的 500。返 Response(500) 让上层能读 status / body
      const msg = errMsg(err);
      // audit-r119:「文件缺失」是 iframe/img navigate 最高频的失败形态
      // (0005 迁移行 PDF 实体丢失),原实现把裸错误串 text/plain 直接当页面
      // 渲染 = 用户全屏英文 debug。识别缺失态返回 404 + 自包含 HTML 错误页;
      // Reader 层已有探测主修(404 → ReaderError),这里是纵深兜底:任何没被
      // 路由到的 surface(外链 / 未来新 reader)也只看到排版过的双语页面。
      // 固定文案不回显路径/错误串 —— 404 语义已完备,避免探测 oracle。
      if (msg.includes('ERR_FILE_NOT_FOUND') || errnoCode(err) === 'ENOENT') {
        log.warn('rkms: file not found', request.url);
        return new Response(FILE_NOT_FOUND_HTML, {
          status: 404,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
      log.warn('rkms fetch failed', request.url, msg);
      return new Response(`Failed to load rkms resource: ${msg}`, {
        status: 500,
      });
    }
  });
}

// audit-r119:文件缺失时 iframe / img navigate 到这里的兜底页面。
// 自包含(无外链资源,协议 response body 一次性)、双语文案、跟随系统
// 深浅色;不放文件名 —— navigate 场景用户本来就知道「打开的是哪个」,
// 回显路径只扩大探测面。
const FILE_NOT_FOUND_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>文件未找到 · File not found</title>
<style>
  body { margin:0; height:100vh; display:flex; align-items:center; justify-content:center;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    background:#fafafa; color:#333; }
  .card { text-align:center; padding:32px; max-width:420px; }
  .icon { font-size:40px; line-height:1; margin-bottom:16px; }
  h1 { font-size:17px; font-weight:600; margin:0 0 8px; }
  p { font-size:13px; color:#666; margin:0; line-height:1.6; }
  @media (prefers-color-scheme: dark) {
    body { background:#111827; color:#e5e7eb; }
    p { color:#9ca3af; }
  }
</style>
</head>
<body>
  <div class="card">
    <div class="icon" aria-hidden="true">&#128196;</div>
    <h1>文件未找到</h1>
    <p>文件可能已被移动、删除或重命名。<br />
    File not found &mdash; it may have been moved, deleted, or renamed.</p>
  </div>
</body>
</html>`;

// 扩展名 → Content-Type 映射。覆盖 library / 笔记场景核心类型;
// 命中不到返 null(由 net.fetch upstream 自带 Content-Type 顶上)
// 内联而非引 mime-types:6 行表不值得 +30kB 依赖
const CONTENT_TYPE_BY_EXT: Readonly<Record<string, string>> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml', // 上面已 deny,这里只是兜底
  '.bmp': 'image/bmp',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.markdown': 'text/markdown; charset=utf-8',
};

function contentTypeFor(absPath: string): string | null {
  const lower = absPath.toLowerCase();
  for (const ext of Object.keys(CONTENT_TYPE_BY_EXT)) {
    if (lower.endsWith(ext)) return CONTENT_TYPE_BY_EXT[ext];
  }
  return null;
}
