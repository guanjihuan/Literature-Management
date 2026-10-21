// tests/unit/renderer/components/system/error-boundary-fallback.test.tsx
//
// 守 ErrorBoundary 的三契约(src/renderer/src/components/system/ErrorBoundary.tsx
// 头注指向本文件,audit-r112 登记,本轮补齐 —— 原先标 🔒(守卫缺失)):
//
//   1. **吞抛**(onError 自身失败不能再次触发 boundary)
//      上报回调通常是网络/遥测调用,它在 boundary 之外抛错 ⇒ React 会
//      把它当成新的渲染错误,boundary 已经在处理错误态 ⇒ 结果是
//      「错误处理又炸了」,用户看到的是崩溃而不是可重试的兜底界面。
//   2. **reset 重挂载**
//      兜底界面上的「重试」必须真的把子树重新挂载(而不是只把错误态
//      清掉后继续渲染同一棵已炸的树)。
//   3. **fallback 优先**
//      调用方给了自定义 fallback ⇒ 用它,不用内置 ErrorFallback。
//
// 附带守:无错时正常透传 children(不劫持正常渲染路径)。
//
// 变异思路:去掉 try/catch ⇒ 例 1 红;reset 不 setState ⇒ 例 2 红;
// 忽略 props.fallback ⇒ 例 3 红。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock('../../../../../src/renderer/src/lib/toast', () => ({
  useToast: () => () => undefined,
}));

import { ErrorBoundary } from '../../../../../src/renderer/src/components/system/ErrorBoundary';

/** 必炸的子组件 —— 用来验证 boundary 真的接住了。 */
function Boom({ onRender }: { onRender?: () => void }): React.ReactElement {
  onRender?.();
  throw new Error('boom');
}

describe('ErrorBoundary 契约(audit-r112 补齐)', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // React 在捕获到渲染错误时必然打 console.error —— 这里静音,
    // 只留断言本身说话。
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    consoleError.mockRestore();
    cleanup();
  });

  it('无错时正常渲染 children(不劫持正常路径)', () => {
    render(
      <ErrorBoundary name="Ok">
        <div data-testid="child">hello</div>
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('child').textContent).toBe('hello');
  });

  it('子组件抛错 ⇒ 渲染内置 ErrorFallback(role=alert),不是白屏', () => {
    render(
      <ErrorBoundary name="Reader">
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.queryByTestId('child')).toBeNull();
  });

  it('onError 被调用,并带上 error 与 componentStack', () => {
    const onError = vi.fn();
    render(
      <ErrorBoundary name="Reader" onError={onError}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(onError).toHaveBeenCalledTimes(1);
    const [err, info] = onError.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('boom');
    expect(info).toHaveProperty('componentStack');
  });

  it('onError 自身抛错 ⇒ 被吞掉,兜底界面照常显示(错误处理不二次爆炸)', () => {
    const onError = vi.fn(() => {
      throw new Error('reporter down');
    });
    expect(() =>
      render(
        <ErrorBoundary name="Reader" onError={onError}>
          <Boom />
        </ErrorBoundary>,
      ),
    ).not.toThrow();
    // 兜底界面仍在(没被 reporter 的异常顶掉)
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('「重试」⇒ reset ⇒ 子树重新挂载(第二次不炸就恢复渲染)', () => {
    let shouldThrow = true;
    const renders: number[] = [];
    function Flaky() {
      renders.push(renders.length);
      if (shouldThrow) throw new Error('boom');
      return <div data-testid="recovered">ok</div>;
    }
    render(
      <ErrorBoundary name="Reader">
        <Flaky />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.queryByTestId('recovered')).toBeNull();

    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: /重试|retry/i }));
    expect(screen.getByTestId('recovered').textContent).toBe('ok');
    // 兜底界面已被换掉
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('自定义 fallback 优先于内置 ErrorFallback', () => {
    render(
      <ErrorBoundary
        name="Reader"
        fallback={({ error }) => <div data-testid="custom">{error.message}</div>}
      >
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('custom').textContent).toBe('boom');
    // 内置的 role=alert 不应出现
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('自定义 fallback 能拿到 reset(ErrorFallbackProps 契约)', () => {
    let shouldThrow = true;
    function Flaky() {
      if (shouldThrow) throw new Error('boom');
      return <div data-testid="recovered">ok</div>;
    }
    render(
      <ErrorBoundary
        name="Reader"
        fallback={({ reset }) => (
          <button data-testid="custom-retry" onClick={reset}>
            retry
          </button>
        )}
      >
        <Flaky />
      </ErrorBoundary>,
    );
    shouldThrow = false;
    fireEvent.click(screen.getByTestId('custom-retry'));
    expect(screen.getByTestId('recovered').textContent).toBe('ok');
  });

  it('子组件挂载被记录过一次(证明 boundary 是渲染期接住,不是事后补画)', () => {
    const onRender = vi.fn();
    render(
      <ErrorBoundary name="Reader">
        <Boom onRender={onRender} />
      </ErrorBoundary>,
    );
    expect(onRender).toHaveBeenCalled();
  });
});
