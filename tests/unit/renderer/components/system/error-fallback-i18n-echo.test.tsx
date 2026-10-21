// tests/unit/renderer/components/system/error-fallback-i18n-echo.test.tsx
//
// 守 ErrorFallback 的 **i18n 回声兜底 + 插值 + 剪贴板** 三案契约
// (src/renderer/src/components/system/ErrorFallback.tsx 头注指向本文件,
// audit-r112 登记,本轮补齐 —— 原先标 🔒(守卫缺失))。
//
// 为什么这条重要:错误界面是**兜底界面** —— 它出现的时刻往往正是应用
// 已经不正常的时刻。若此时 useTranslation 还没就绪,t() 会回声 key 本身,
// 用户看到的不是「出错了」而是 `errorBoundary.title` / `errorBoundary.regionLabel`
// 这种裸 key,比白屏还让人困惑(而且这恰好是「出错时还想给用户一个清楚
// 的解释」这件事被自己搞砸的典型)。
//
// 三案各自钉住:
//   回声(interp):t() 返回 key 形态 ⇒ 走 zh-CN 直接 import 的 FALLBACK 兜底,
//     屏幕上**不能**出现裸 key;
//   插值:兜底串里的 {name} 必须被替换成真实区域名(且缺失变量保留字面量);
//   剪贴板:复制成功/失败各弹一条**已本地化**的 toast(不是 key)。
//
// 变异思路:把 t() 改成永远回声 / 永远就绪 / 把 FALLBACK 换成 en / 去掉
// interpolate 替换 —— 本文件逐条会红。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

// i18n 状态开关 —— 'echo' 模拟 i18n 未就绪(t 回声 key);
// 'ready' 模拟 i18n 已就绪(t 返回带前缀的真实值)。
const i18nState = { mode: 'echo' as 'echo' | 'ready' };

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => (i18nState.mode === 'echo' ? key : `T:${key}`),
  }),
}));

// toast —— 只记录调用,不引入 zustand store。
const toastCalls: { type: string; message: string }[] = [];
vi.mock('../../../../../src/renderer/src/lib/toast', () => ({
  useToast: () => (opts: { type: string; message: string }) => {
    toastCalls.push(opts);
  },
}));

import { ErrorFallback } from '../../../../../src/renderer/src/components/system/ErrorFallback';

const ZH = {
  title: '出错了',
  description: '应用遇到了一个意外错误，可以重试或复制堆栈上报。',
  errorInfoLabel: '错误信息',
  noMessage: '(无错误信息)',
  collapseStack: '收起堆栈',
  expandStack: '展开堆栈',
  retry: '重试',
  copyStack: '复制堆栈',
  regionLabel: '区域: {name}',
  topLevelError: '顶层错误',
};

function makeError(message = 'boom', stack = 'Error: boom\n    at x.ts:1:1') {
  const e = new Error(message);
  e.stack = stack;
  return e;
}

describe('ErrorFallback 的 i18n 回声兜底(audit-r112 补齐)', () => {
  beforeEach(() => {
    i18nState.mode = 'echo';
    toastCalls.length = 0;
  });
  afterEach(() => {
    cleanup();
  });

  it('i18n 未就绪(t 回声 key)⇒ 渲染 zh-CN 兜底文案,屏幕上不出现裸 key', () => {
    render(<ErrorFallback error={makeError()} reset={() => {}} name="LibraryReader" />);
    const text = document.body.textContent ?? '';
    expect(text).toContain(ZH.title);
    expect(text).toContain(ZH.description);
    expect(text).toContain(ZH.retry);
    // 裸 key 绝不能出现在用户可见文本里
    expect(text).not.toContain('errorBoundary.');
    expect(text).not.toContain('toast.');
  });

  it('区域名走 regionLabel 插值:显示真实 name,不留 {name} 占位符', () => {
    render(<ErrorFallback error={makeError()} reset={() => {}} name="LibraryReader" />);
    const text = document.body.textContent ?? '';
    expect(text).toContain('LibraryReader');
    expect(text).not.toContain('{name}');
    expect(text).toContain('区域:');
  });

  it('没有 name ⇒ 走 topLevelError(不是 regionLabel 的空插值)', () => {
    render(<ErrorFallback error={makeError()} reset={() => {}} />);
    const text = document.body.textContent ?? '';
    expect(text).toContain(ZH.topLevelError);
    expect(text).not.toContain('{name}');
  });

  it('i18n 已就绪 ⇒ 用 i18n 的值,不回退到 zh-CN 兜底', () => {
    i18nState.mode = 'ready';
    render(<ErrorFallback error={makeError()} reset={() => {}} name="X" />);
    const text = document.body.textContent ?? '';
    expect(text).toContain('T:errorBoundary.title');
    expect(text).not.toContain(ZH.title);
  });

  it('error.message 为空 ⇒ 显示 noMessage 兜底(不显示空白)', () => {
    render(<ErrorFallback error={makeError('')} reset={() => {}} />);
    expect(document.body.textContent ?? '').toContain(ZH.noMessage);
  });

  it('堆栈默认折叠(aria-expanded=false);点击后展开 <pre> 并可再收起', () => {
    render(<ErrorFallback error={makeError()} reset={() => {}} />);
    const toggle = screen.getByRole('button', { name: new RegExp(ZH.expandStack) });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('pre')).toBeNull();

    fireEvent.click(toggle);
    const collapse = screen.getByRole('button', { name: new RegExp(ZH.collapseStack) });
    expect(collapse.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('pre')?.textContent).toContain('at x.ts:1:1');

    fireEvent.click(collapse);
    expect(document.querySelector('pre')).toBeNull();
  });

  it('无 stack ⇒ 不渲染折叠按钮(不给用户一个点不开的开关)', () => {
    const e = new Error('boom');
    e.stack = '';
    render(<ErrorFallback error={e} reset={() => {}} />);
    expect(screen.queryByRole('button', { name: new RegExp(ZH.expandStack) })).toBeNull();
  });

  it('复制堆栈成功 ⇒ 弹 success toast,消息是**已本地化**的文案(不是 key)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    render(<ErrorFallback error={makeError()} reset={() => {}} name="R" />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(ZH.copyStack) }));
    await vi.waitFor(() => expect(toastCalls).toHaveLength(1));
    expect(toastCalls[0].type).toBe('success');
    expect(toastCalls[0].message).toBe('堆栈已复制到剪贴板');
    expect(toastCalls[0].message).not.toContain('toast.');
    // 复制内容含区域名 + 错误消息
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(String(writeText.mock.calls[0][0])).toContain('R');
    expect(String(writeText.mock.calls[0][0])).toContain('boom');
  });

  it('复制堆栈失败 ⇒ 弹 error toast(已本地化文案),不吞异常', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    render(<ErrorFallback error={makeError()} reset={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(ZH.copyStack) }));
    await vi.waitFor(() => expect(toastCalls).toHaveLength(1));
    expect(toastCalls[0].type).toBe('error');
    expect(toastCalls[0].message).toBe('复制失败,请手动选择');
  });

  it('「重试」按钮调用 reset(ErrorBoundary 用它重挂载子树)', () => {
    const reset = vi.fn();
    render(<ErrorFallback error={makeError()} reset={reset} />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(ZH.retry) }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('错误区是 role="alert"(SR 立即播报,不等用户去逛)', () => {
    render(<ErrorFallback error={makeError()} reset={() => {}} />);
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});
