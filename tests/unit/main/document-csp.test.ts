// tests/unit/main/document-csp.test.ts
//
// 守卫:`frame-ancestors` 只能、也只该出现在**应用主文档的响应头**里。
//
// 为什么要有这个守卫(audit r169,2026-10-19):
//   1. 该 directive 只在响应头生效 —— 放 <meta> 里 Chromium 忽略并每次
//      启动打一条 error(实测:启动 console 有
//      "directive 'frame-ancestors' is ignored when delivered via a
//      <meta> element")。历史上 renderer/index.html 的 meta CSP 里就挂着
//      一份,防护是空操作,却一直刷错。
//   2. 加在 **rkms:// 资源**上也不对 —— 实测 Chromium 只对 web 系 scheme
//      强制 frame-ancestors,自定义 scheme 不强制(加了也不生效);而一旦
//      Chromium 改为强制,PDFReader / ImageReader 的 <iframe src="rkms://…">
//      会被自家 directive 打死。
//   → 正确位置:主进程给主文档注入 CSP 响应头(src/main/document-csp.ts)。
//
// 本测守三件事:
//   A. buildDocumentHeaders 纯函数行为(补头 / 覆盖大小写不同的旧 CSP /
//      保留其它响应头)。
//   B. installDocumentCspHeaders 真的注册了 onHeadersReceived,且只对
//      mainFrame 注入(subFrame 放行 —— 否则会误伤 rkms:// iframe)。
//   C. source-text 锁:meta CSP 里不再有 frame-ancestors、protocol.ts 里
//      不再下发 Content-Security-Policy(防止回退到错误位置)。
import { readFileSync } from 'fs';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock 工厂会被提升到 import 之前,必须用 vi.hoisted 拿到 mock 函数引用
const { onHeadersReceived } = vi.hoisted(() => ({ onHeadersReceived: vi.fn() }));

vi.mock('electron', () => ({
  session: {
    defaultSession: {
      webRequest: { onHeadersReceived },
    },
  },
}));

const ROOT = process.cwd();

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

describe('document-csp', () => {
  beforeEach(() => {
    onHeadersReceived.mockReset();
  });

  it('A1 buildDocumentHeaders 补上 CSP 且保留其它响应头', async () => {
    const { buildDocumentHeaders, APP_DOCUMENT_CSP } = await import('../../../src/main/document-csp');
    const out = buildDocumentHeaders({ 'Content-Type': 'text/html', 'X-Test': '1' });
    expect(out['Content-Security-Policy']).toBe(APP_DOCUMENT_CSP);
    expect(out['Content-Type']).toBe('text/html');
    expect(out['X-Test']).toBe('1');
  });

  it('A2 buildDocumentHeaders 大小写不敏感地覆盖旧 CSP,不产生重复键', async () => {
    const { buildDocumentHeaders, APP_DOCUMENT_CSP } = await import('../../../src/main/document-csp');
    const out = buildDocumentHeaders({ 'content-security-policy': "default-src 'none'", 'X-Keep': 'y' });
    const cspKeys = Object.keys(out).filter((k) => k.toLowerCase() === 'content-security-policy');
    expect(cspKeys).toEqual(['Content-Security-Policy']);
    expect(out['Content-Security-Policy']).toBe(APP_DOCUMENT_CSP);
    expect(out['X-Keep']).toBe('y');
  });

  it('A3 buildDocumentHeaders 接受 undefined 入参', async () => {
    const { buildDocumentHeaders, APP_DOCUMENT_CSP } = await import('../../../src/main/document-csp');
    expect(buildDocumentHeaders(undefined)['Content-Security-Policy']).toBe(APP_DOCUMENT_CSP);
  });

  it('B1 installDocumentCspHeaders 注册 onHeadersReceived 且只对 mainFrame 注入', async () => {
    const { installDocumentCspHeaders, APP_DOCUMENT_CSP } = await import('../../../src/main/document-csp');
    installDocumentCspHeaders();
    expect(onHeadersReceived).toHaveBeenCalledTimes(1);
    const [filter, listener] = onHeadersReceived.mock.calls[0] as unknown as [
      { urls: string[] },
      (
        details: { resourceType: string; responseHeaders?: Record<string, string> },
        cb: (r: { responseHeaders?: Record<string, string> }) => void
      ) => void,
    ];
    // 过滤必须覆盖 prod(file://)与 dev(localhost)两种文档来源
    expect(filter.urls).toContain('file://*/*');
    expect(filter.urls.some((u) => u.includes('localhost'))).toBe(true);

    // mainFrame → 注入
    const mainCb = vi.fn();
    listener({ resourceType: 'mainFrame', responseHeaders: { 'X-A': '1' } }, mainCb);
    expect(mainCb).toHaveBeenCalledTimes(1);
    expect(mainCb.mock.calls[0][0].responseHeaders?.['Content-Security-Policy']).toBe(APP_DOCUMENT_CSP);

    // subFrame → 不注入(rkms:// iframe 等子帧不能被误伤)
    const subCb = vi.fn();
    listener({ resourceType: 'subFrame', responseHeaders: { 'X-A': '1' } }, subCb);
    expect(subCb).toHaveBeenCalledTimes(1);
    expect(subCb.mock.calls[0][0].responseHeaders).toBeUndefined();
  });

  it('C1 meta CSP 里不再有 frame-ancestors(Chromium 忽略 + 每次启动报错)', () => {
    const html = read('src/renderer/index.html');
    const metaTag = html.match(/http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]*)"/);
    expect(metaTag).not.toBeNull();
    expect(metaTag![1]).not.toContain('frame-ancestors');
    // 其余 directive 必须在(meta CSP 仍然有效,别把防护整体删掉)
    expect(metaTag![1]).toContain("script-src 'self'");
    expect(metaTag![1]).toContain("object-src 'none'");
  });

  it('C2 protocol.ts 不再下发 Content-Security-Policy(自定义 scheme 上不生效且有风险)', () => {
    const src = read('src/main/protocol.ts');
    expect(src).not.toMatch(/headers\.set\(\s*['"]Content-Security-Policy['"]/);
  });
});
