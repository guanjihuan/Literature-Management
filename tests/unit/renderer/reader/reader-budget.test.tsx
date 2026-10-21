// tests/unit/renderer/reader/reader-budget.test.tsx
//
// 守 perf r259「大文件阅读不许把渲染进程主线程堵死」这条契约 ——
//   阅读器的重管线(语法高亮 / markdown 渲染 + HTML 净化)是**同步**的,
//   跑在 renderer 主线程上。实测(2026-10-21):
//
//     代码文件 12.3MB → hljs.highlight 3191ms + 净化 592ms(净化后 HTML 57.8MB)
//     markdown  5.6MB → md.render 889ms + 净化 1943ms
//
//   main 侧阅读器上限 READER_MAX_SIZE_BYTES = 10MB ⇒ 这些量级用户真能碰到
//   ⇒ 窗口「未响应」数秒。修法 = **降级**而不是截断:超预算的部分不再走
//   重管线,但**内容一字不丢**(以纯文本呈现)。
//
// ── 本测锁五件事 ───────────────────────────────────────────────────
//   A. splitByBudget 的三条不变量:
//      ① head + tail === 原文(**内容零丢失**);
//      ② 未超预算 ⇒ tail 为空、truncated 为 false;
//      ③ 超预算 ⇒ 切点落在**行边界**(不把一行劈成两半)。
//   B. CodeReader:超大文件 ⇒ 只有预算内的一段被高亮(高亮 span 数有界),
//      但**尾部内容仍在 DOM 里**(用户看得见完整文件),且出现降级提示条。
//   C. MarkdownReader:超大文件 ⇒ 预算外的部分以 <pre> 纯文本呈现
//      (**不被 markdown 排版**),内容完整,并出现降级提示条。
//   D. 小文件**不受影响**:照常高亮 / 照常排版,且**没有**提示条。
//   E. 提示条上的「在系统应用打开」出口存在(想要完整高亮的用户有去处)。
//
// 变异思路(哪几处改动会红):
//   - splitByBudget 改成「截断丢弃尾巴」⇒ A① / B / C 红(内容丢);
//   - 预算调回 Infinity(不做降级)⇒ B / C 红(高亮 span 数无界 / 无提示条);
//   - 尾巴忘了接上(head+tail 少一段)⇒ B / C 红;
//   - 提示条不渲染 ⇒ B / C 红。
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { CodeReader } from '../../../../src/renderer/src/components/reader/CodeReader';
import { MarkdownReader } from '../../../../src/renderer/src/components/reader/MarkdownReader';
import {
  READER_HIGHLIGHT_BUDGET_CHARS,
  READER_MARKDOWN_BUDGET_CHARS,
  splitByBudget,
} from '../../../../src/renderer/src/lib/reader-budget';

afterEach(() => {
  cleanup();
});

/** 造一份「行数足够多、尾部有唯一标记」的源码。 */
function makeSource(totalChars: number, marker: string): string {
  const line = 'def f(x):\n    return x + 1  # comment\n';
  let s = '';
  while (s.length < totalChars) s += line;
  s += marker;
  return s;
}

describe('splitByBudget:内容零丢失的不变量', () => {
  it('A1 未超预算 ⇒ head 就是全文,tail 为空,truncated 为 false', () => {
    const text = 'abc\ndef\n';
    const r = splitByBudget(text, 1024);
    expect(r.truncated).toBe(false);
    expect(r.tail).toBe('');
    expect(r.head).toBe(text);
    expect(r.headChars).toBe(text.length);
  });

  it('A2 超预算 ⇒ head + tail 拼回原文(一个字符都不丢)', () => {
    const text = makeSource(5000, 'TAIL-MARKER\n');
    const r = splitByBudget(text, 1000);
    expect(r.truncated).toBe(true);
    expect(r.head.length).toBeLessThanOrEqual(1000);
    expect(r.head + r.tail).toBe(text);
    expect(r.tail).toContain('TAIL-MARKER');
  });

  it('A3 超预算 ⇒ 切点落在行边界(不把一行劈成两半)', () => {
    const text = makeSource(5000, 'TAIL-MARKER\n');
    const r = splitByBudget(text, 1000);
    expect(r.head.endsWith('\n')).toBe(true);
  });

  it('A4 整段没有换行的超长单行 ⇒ 硬切在预算处,内容仍零丢失', () => {
    const text = 'x'.repeat(5000);
    const r = splitByBudget(text, 1000);
    expect(r.truncated).toBe(true);
    expect(r.head.length).toBe(1000);
    expect(r.head + r.tail).toBe(text);
  });
});

describe('CodeReader:大文件降级(内容不丢,高亮有界)', () => {
  it('B1 超大文件 ⇒ 只有预算内的一段被高亮,尾部内容仍在 DOM 里', async () => {
    // 标记用「一定会被 hljs 包成 span」的形态(def = python 关键字):
    // 若整份文件都被高亮,这个标记的文本节点就会挂在 span 下面;
    // 降级后它是 <code> 的**直接文本子节点** ⇒ 断言文本节点的父元素。
    const marker = 'def zzz_tail_marker():\n    return 1\n';
    const source = makeSource(READER_HIGHLIGHT_BUDGET_CHARS + 20000, marker);
    const { container } = render(<CodeReader source={source} filename="big.py" />);

    // 等 hljs chunk 到位(动态 import)—— 高亮 span 出现即算到位。
    await waitFor(() => {
      expect(container.querySelectorAll('code span').length).toBeGreaterThan(0);
    });

    // ① 内容零丢失:尾部标记在 DOM 里(纯文本呈现)
    expect(container.textContent).toContain('zzz_tail_marker');
    // ② 尾部**没有被高亮**:标记所在的文本节点直接挂在 <code> 下
    const code = container.querySelector('code')!;
    const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    let parentTag = '';
    while (node) {
      if (node.textContent?.includes('zzz_tail_marker')) {
        parentTag = (node.parentElement?.tagName ?? '').toUpperCase();
        break;
      }
      node = walker.nextNode();
    }
    expect(
      parentTag,
      '尾部被高亮了 ⇒ 渲染预算没生效(整份文件仍在跑 hljs,主线程会卡数秒)',
    ).toBe('CODE');
  });

  it('B2 出现降级提示条(用户有权知道「后面那段没高亮」)', async () => {
    const source = makeSource(READER_HIGHLIGHT_BUDGET_CHARS + 20000, 'TAIL\n');
    render(<CodeReader source={source} filename="big.py" />);

    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
    expect(screen.getByRole('status').textContent).toContain('reader.largeCodeNotice');
  });

  it('B3 提示条带「在系统应用打开」出口(想要完整高亮有去处)', async () => {
    const source = makeSource(READER_HIGHLIGHT_BUDGET_CHARS + 20000, 'TAIL\n');
    const onOpenExternal = vi.fn();
    render(<CodeReader source={source} filename="big.py" onOpenExternal={onOpenExternal} />);

    const btn = await screen.findByRole('button', { name: 'reader.openExternal' });
    btn.click();
    expect(onOpenExternal).toHaveBeenCalledTimes(1);
  });

  it('D1 小文件 ⇒ 照常高亮,且**没有**降级提示条', async () => {
    const source = 'def f(x):\n    return x + 1\n';
    const { container } = render(<CodeReader source={source} filename="small.py" />);

    await waitFor(() => {
      expect(container.querySelectorAll('code span').length).toBeGreaterThan(0);
    });
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('MarkdownReader:大文件降级(排版有界,内容不丢)', () => {
  it('C1 超大文件 ⇒ 预算外的部分以纯文本呈现,不被 markdown 排版', async () => {
    const marker = 'TAIL-MARKER-MD **not-bold**';
    const head = '# Title\n\nsome **bold** text\n\n';
    let source = head;
    while (source.length < READER_MARKDOWN_BUDGET_CHARS + 20000) source += 'line of text\n\n';
    source += marker + '\n';

    const { container } = render(<MarkdownReader source={source} filename="big.md" />);

    await waitFor(() => {
      expect(container.querySelector('article > div')!.innerHTML.trim().length).toBeGreaterThan(0);
    });

    // ① 内容零丢失:尾部标记在 DOM 里(以 <pre> 纯文本呈现)
    expect(container.textContent).toContain('TAIL-MARKER-MD');
    // ② 预算外的部分**没有**进 markdown 渲染产物 —— 这是本测的关键断言:
    //    markdown 输出容器里不得出现尾部标记(否则说明整份文件仍在走
    //    md.render,主线程照样被堵数秒)。
    const mdOut = container.querySelector('article > div')!;
    expect(
      mdOut.textContent,
      '尾部被 markdown 渲染了 ⇒ 渲染预算没生效(整份文件仍在跑 md.render)',
    ).not.toContain('TAIL-MARKER-MD');
    // ③ 预算内的部分照常排版(只有一个 strong,来自正文)
    expect(mdOut.querySelectorAll('strong')).toHaveLength(1);
    expect(container.querySelector('article strong')!.textContent).toBe('bold');
    expect(container.textContent).toContain('**not-bold**');
  });

  it('C2 出现降级提示条', async () => {
    let source = '# Title\n\n';
    while (source.length < READER_MARKDOWN_BUDGET_CHARS + 20000) source += 'line of text\n\n';
    render(<MarkdownReader source={source} filename="big.md" />);

    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
    expect(screen.getByRole('status').textContent).toContain('reader.largeMarkdownNotice');
  });

  it('D2 小文件 ⇒ 照常排版,且没有降级提示条', async () => {
    const { container } = render(
      <MarkdownReader source={'# 标题\n\n正文**粗体**\n'} filename="small.md" />,
    );
    await waitFor(() => {
      expect(container.querySelector('article strong')!.textContent).toBe('粗体');
    });
    expect(screen.queryByRole('status')).toBeNull();
  });
});
