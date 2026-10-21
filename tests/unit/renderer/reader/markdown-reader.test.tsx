// tests/unit/renderer/reader/markdown-reader.test.tsx
//
// 守 MarkdownReader 的行为契约
// (src/renderer/src/components/reader/MarkdownReader.tsx 头注指向本文件,
//  原先标 🔒(守卫缺失);其中「安全前置」一条是源码注释**点名**要守的)。
//
// 组件做什么:markdown-it 渲染 → 字符串层净化 → dangerouslySetInnerHTML。
// 用户可见的结果分三块:
//   1. 渲染 —— 标题 / 列表 / 粗体 / 代码块 / 表格都变成真的 HTML 元素;
//      文档第一行的 # 标题额外给 SR 一个隐藏 h1;容器带 filename 的 aria-label。
//   2. 【安全前置】—— markdown-it 实例必须带 `html: false`:
//        正文里的原始 HTML **不被解析**(只作为文本显示),
//        否则 <script> 会经 dangerouslySetInnerHTML 直接进 DOM;
//      这一层之上还有字符串净化(markdown-html-sanitize):
//        危险 scheme(javascript: / data: / vbscript:)的链接一律被中和。
//      退化后果:用户笔记里的 `<script>` 或 `javascript:` 链接在 renderer
//      进程里可执行 ⇒ 经 window.api 间接调用所有 IPC ⇒ 用户数据 RCE。
//      (实测:markdown-it 自己的 validateLink 已经先挡掉 markdown 链接里的
//       javascript:,本测锁的是**端到端用户可见**的结果 —— 渲染结果里
//       永远没有危险 scheme 的可点链接,且原文不被静默吞掉。)
//   3. 空态 / 失败态 —— 空正文给明确空态提示(而不是空 <p>);
//      markdown-it chunk 加载失败给错误态(而不是永久白屏)。
//
// 变异思路(哪几处改动会红):
//   - markdown-it 选项 html: false → true ⇒ 「正文里的 <script> 是文本」红;
//   - 去掉 sanitizeMarkdownHtml 调用(或放宽 scheme 白名单)⇒ 危险链接红;
//   - linkify: true → false ⇒ 裸 URL 自动成链红;
//   - 去掉 fence/code_block 的尾换行裁剪 ⇒ 代码块文本多一个 \n 红;
//   - 空内容分支改成渲染空 article ⇒ 空态红;
//   - 动态 import 的 catch 分支去掉 ⇒ 加载失败变白屏红。
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { MarkdownReader } from '../../../../src/renderer/src/components/reader/MarkdownReader';

/**
 * markdown-it 是**动态 import** —— 等它真正渲染完。
 * 注意:article 元素在 markdown-it 到位**之前**就已挂载(正文区是空的),
 * 且组件还会额外渲染一个给 SR 用的隐藏 h1 —— 所以「article 里有字」并不代表
 * markdown 渲染完了。真正的判据是 markdown 输出容器(article > div)非空。
 */
async function waitForRendered(container: HTMLElement) {
  await waitFor(
    () => {
      const md = container.querySelector('article > div');
      expect(md).not.toBeNull();
      expect(md!.innerHTML.trim().length).toBeGreaterThan(0);
    },
    { timeout: 3000 },
  );
}

afterEach(() => {
  cleanup();
});

describe('MarkdownReader:markdown 渲染', () => {
  it('标题 / 列表 / 粗体 / 行内代码都变成真的 HTML 元素', async () => {
    const { container } = render(
      <MarkdownReader
        source={'# 一级标题\n\n- 甲\n- 乙\n\n这是**粗体**与 `code`\n'}
        filename="a.md"
      />,
    );
    await waitForRendered(container);

    expect(container.querySelector('article h1')!.textContent).toBe('一级标题');
    expect(container.querySelectorAll('article li')).toHaveLength(2);
    expect(container.querySelector('article strong')!.textContent).toBe('粗体');
    expect(container.querySelector('article code')!.textContent).toBe('code');
  });

  it('代码块内容末尾没有多余换行', async () => {
    const { container } = render(
      <MarkdownReader source={'```js\nconst a = 1;\n```\n'} filename="a.md" />,
    );
    await waitForRendered(container);

    const code = container.querySelector('article pre code')!;
    expect(code.textContent).toBe('const a = 1;');
    expect(code.textContent!.endsWith('\n')).toBe(false);
  });

  it('文档第一行的 # 标题额外给 SR 一个隐藏 h1;容器带 filename 的 aria-label', async () => {
    const { container } = render(
      <MarkdownReader source={'# 主题\n\n正文\n'} filename="研究笔记.md" />,
    );
    await waitForRendered(container);

    const srHeading = container.querySelector('article h1.sr-only');
    expect(srHeading).not.toBeNull();
    expect(srHeading!.textContent).toBe('主题');
    // 容器对外暴露可访问名
    expect(container.querySelector('[aria-label="研究笔记.md"]')).not.toBeNull();
  });

  it('[[wiki 链接]] 渲染为纯文本,不是可点锚点', async () => {
    const { container } = render(
      <MarkdownReader source={'参见 [[另一篇笔记]] 的说明'} filename="a.md" />,
    );
    await waitForRendered(container);

    expect(container.querySelector('article')!.textContent).toContain('[[另一篇笔记]]');
    expect(container.querySelector('article a')).toBeNull();
  });
});

describe('MarkdownReader:安全前置(html:false + scheme 白名单)', () => {
  it('正文里的原始 HTML 只作为文本显示,不进 DOM', async () => {
    const { container } = render(
      <MarkdownReader
        source={'<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">\n'}
        filename="a.md"
      />,
    );
    await waitForRendered(container);

    // DOM 里不得出现脚本 / 图片元素
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    // 字面量以文本形式完整保留(用户能看见自己写的东西)
    expect(container.textContent).toContain('<script>alert(1)</script>');
    expect(container.textContent).toContain('onerror');
  });

  it('危险 scheme 不会变成可点链接,原文仍可见', async () => {
    const { container } = render(
      <MarkdownReader
        source={
          '[点我](javascript:alert(1))\n\n访问 https://example.com\n\n裸的 javascript:alert(2) 也在正文里\n'
        }
        filename="a.md"
      />,
    );
    await waitForRendered(container);

    // 渲染结果里只有**安全**的那个链接(markdown-it 的 validateLink 先挡一道,
    // 字符串净化再兜一道 —— 两道都在 ⇒ 用户笔记里的危险链接永远点不动)
    const hrefs = Array.from(container.querySelectorAll('article a')).map((a) =>
      (a.getAttribute('href') ?? '').toLowerCase(),
    );
    expect(hrefs).toEqual(['https://example.com']);
    for (const href of hrefs) {
      expect(href).not.toMatch(/^(javascript|vbscript|data|file):/);
    }
    // 且原文没有被静默吞掉(用户能看到自己写了什么)
    expect(container.textContent).toContain('javascript:alert(1)');
    expect(container.textContent).toContain('javascript:alert(2)');
  });

  it('裸 URL 被自动链接化,http(s) 链接保持原样', async () => {
    const { container } = render(
      <MarkdownReader source={'访问 https://example.com 看看'} filename="a.md" />,
    );
    await waitForRendered(container);

    const anchor = container.querySelector('article a')!;
    expect(anchor.getAttribute('href')).toBe('https://example.com');
  });
});

describe('MarkdownReader:空态与失败态', () => {
  it('空白正文 → 明确空态提示,而不是一个空 article', async () => {
    const { container } = render(<MarkdownReader source={'   \n\n'} filename="空.md" />);

    await waitFor(() => expect(screen.getByText('reader.emptyDoc')).toBeTruthy());
    expect(container.querySelector('article')).toBeNull();
  });

  it('markdown-it 初始化失败 → 错误态提示,不是永久白屏', async () => {
    // 真实故障形态:chunk 到了但实例化炸了(asar hash 不符 / 沙盒环境)。
    // 工厂返回「构造即抛」的类,错误信息能原样传到 UI 上。
    vi.doMock('markdown-it', () => ({
      default: class {
        constructor() {
          throw new Error('chunk load failed');
        }
      },
    }));

    const { container } = render(<MarkdownReader source={'# 标题'} filename="a.md" />);

    await waitFor(() =>
      expect(screen.getByText('reader.errorMarkdownLoaderReaderTitle')).toBeTruthy(),
    );
    expect(container.querySelector('article')).toBeNull();
    // 错误原因对用户可见(可截图报障),不是空壳
    expect(container.textContent).toContain('chunk load failed');

    vi.doUnmock('markdown-it');
  });
});
