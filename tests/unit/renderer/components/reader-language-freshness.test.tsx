// tests/unit/renderer/components/reader-language-freshness.test.tsx
//
// 守 audit 2026-10-21 (r252):Reader 的文案必须**跟着界面语言**走。
//
// 两处「烤死语言」的坑:
//   ① toast:「在系统应用打开」失败时的 toast 走 useCallback([file?.absPath])
//      —— react-i18next 的 t 是 `i18n.getFixedT(lng)`,身份跟着语言走;
//      deps 里没有 t ⇒ 用户在设置里换语言后回调**不重建** ⇒ 闭包里的 t
//      停在旧语言 ⇒ toast 用旧语言渲染(实测 getFixedT('zh-CN') 与
//      getFixedT('en-US') 是两个不同函数,身份不等)。
//   ② 错误描述:`t('reader.errorGeneric')` / `t('reader.errorFileFormatCorrupt')`
//      在**出错那一刻**翻译好、烤进 state ⇒ 换语言后描述还是旧语言,
//      而标题(渲染期翻译)是新语言 ⇒ **中英混排**。
//
// 本测用一份**可控语言**的 i18n mock(模拟 react-i18next 的真实语义:
// 语言不变 ⇒ t 身份稳定;语言变 ⇒ t 换新身份),锁:
//   ① 换语言后 toast 用新语言;
//   ② 换语言后错误描述用新语言(且标题/描述同语言,不混排)。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup, act } from '@testing-library/react';

// ── 可控语言的 i18n mock(行为对齐 react-i18next)────────────────────────────
//   t 的身份:每个语言一个固定函数 ⇒ 语言不变时稳定(不会导致无谓重建),
//   换语言 ⇒ 换新身份(依赖 t 的 useCallback 会重建)。
const i18nMock = vi.hoisted(() => {
  const state = { lang: 'zh-CN' };
  const dict: Record<string, Record<string, string>> = {
    'reader.errorGeneric': { 'zh-CN': '无法显示该文件', 'en-US': 'Cannot display this file' },
    'reader.errorFileFormatCorrupt': {
      'zh-CN': '文件内容格式异常',
      'en-US': 'File content format is invalid',
    },
    'reader.errorOpenExternal': {
      'zh-CN': '在系统应用打开',
      'en-US': 'Open in system app',
    },
    'reader.errorRetry': { 'zh-CN': '重试', 'en-US': 'Retry' },
    'toast.openFailed': { 'zh-CN': '打开失败: {msg}', 'en-US': 'Open failed: {msg}' },
  };
  const cache = new Map<string, (k: string, opts?: { msg?: string }) => string>();
  function makeT(lang: string) {
    let fn = cache.get(lang);
    if (!fn) {
      fn = (k: string, opts?: { msg?: string }) => {
        const s = dict[k]?.[lang] ?? k;
        return opts?.msg !== undefined ? s.replace('{msg}', opts.msg) : s;
      };
      cache.set(lang, fn);
    }
    return fn;
  }
  return { state, makeT };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: i18nMock.makeT(i18nMock.state.lang) }),
}));

const readFileForReader = vi.fn();
const openPath = vi.fn();
vi.mock('../../../../src/renderer/src/lib/api', () => ({
  api: {
    readFileForReader: (...args: unknown[]) => readFileForReader(...args),
    openPath: (...args: unknown[]) => openPath(...args),
  },
  unwrap: (r: unknown) => r,
  IpcError: class IpcError extends Error {},
  asIpcError: () => null,
  hasApi: () => true,
}));

import { Reader } from '../../../../src/renderer/src/components/reader/Reader';
import { useToast } from '../../../../src/renderer/src/lib/toast';

const FILE = {
  id: 'f1',
  extension: '.txt',
  absPath: '/tmp/rkms-lang/a.txt',
  filename: 'a.txt',
};

describe('Reader 文案必须跟着界面语言走(r252)', () => {
  beforeEach(() => {
    i18nMock.state.lang = 'zh-CN';
    readFileForReader.mockReset();
    openPath.mockReset();
    useToast.setState({ toasts: [] });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('换语言后,「在系统应用打开」失败的 toast 用新语言', async () => {
    readFileForReader.mockResolvedValue({ ok: false, error: { code: 'IO_ERROR', message: 'boom' } });
    openPath.mockRejectedValue(new Error('boom'));

    const { rerender } = render(<Reader file={{ ...FILE }} />);
    await waitFor(() => expect(screen.getByText('在系统应用打开')).toBeTruthy());

    // 中文:点一次 → toast 是中文
    await act(async () => {
      fireEvent.click(screen.getByText('在系统应用打开'));
    });
    expect(useToast.getState().toasts.at(-1)?.message).toBe('打开失败: boom');

    // 换语言(真实场景:设置里改「界面语言」⇒ i18n 触发整棵树重渲)
    i18nMock.state.lang = 'en-US';
    rerender(<Reader file={{ ...FILE }} />);
    await waitFor(() => expect(screen.getByText('Open in system app')).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByText('Open in system app'));
    });
    expect(
      useToast.getState().toasts.at(-1)?.message,
      '换语言后 toast 必须用新语言(旧实现:回调不重建 ⇒ 停在旧语言)',
    ).toBe('Open failed: boom');
  });

  it('换语言后,错误描述用新语言(标题与描述同语言,不混排)', async () => {
    // 走「文件内容格式异常」那条路径:返回的 data 不是 Uint8Array
    readFileForReader.mockResolvedValue({ ok: true, data: { data: 'not-bytes' } });

    const { rerender } = render(<Reader file={{ ...FILE }} />);
    await waitFor(() => expect(screen.getByText('文件内容格式异常')).toBeTruthy());
    expect(screen.getByText('无法显示该文件'), '标题此刻是中文').toBeTruthy();

    i18nMock.state.lang = 'en-US';
    rerender(<Reader file={{ ...FILE }} />);
    await waitFor(() => expect(screen.getByText('File content format is invalid')).toBeTruthy());
    expect(
      screen.queryByText('文件内容格式异常'),
      '旧语言的描述不得残留(旧实现:翻译结果被烤进 state)',
    ).toBeNull();
    expect(screen.getByText('Cannot display this file'), '标题也跟着换').toBeTruthy();
  });
});
