// 全局 ErrorBoundary — 防止单个组件抛错导致整个渲染进程白屏
// audit-r112:onError 吞抛/reset 重挂载/fallback 优先三契约首补行为锁
// tests/unit/renderer/components/system/error-boundary-fallback.test.tsx(audit-r112,本轮补齐)
//
// 用法:
//   <ErrorBoundary name="LibraryReader" onError={reportError}>
//     <Reader />
//   </ErrorBoundary>
//
// 设计决策:
//   1. 用 class component(React 唯一支持 componentDidCatch 的形态)
//   2. 提供 reset() — 用户可点击"重试"重新挂载子树
//   3. 提供 name prop — ErrorFallback 显示"哪里出错了"
//   4. onError 回调 — 接入未来的 Sentry / 自家上报
//   5. 顶层不包装自己(避免自己抛错时白屏) — App.tsx 顶层直接挂
//      <ErrorBoundary name="App">,顶层 boundary 也炸时由 Electron 主进程兜底。
import { Component, type ReactNode } from 'react';
import { ErrorFallback, type ErrorFallbackProps } from './ErrorFallback';
// audit C3R89 (2026-08-22):走 createLogger 统一前缀
import { createLogger } from '../../lib/logger-client';

const log = createLogger('ErrorBoundary');

interface ErrorBoundaryProps {
  /** 区域名,显示在 fallback 里帮助定位问题(如 "LibraryReader") */
  name?: string;
  /** 自定义 fallback UI(高级用例) */
  fallback?: (props: ErrorFallbackProps) => ReactNode;
  /** 错误回调(上报 / 日志) */
  onError?: (error: Error, info: { componentStack?: string | null }) => void;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    if (this.props.onError) {
      try {
        this.props.onError(error, info);
      } catch {
        // 上报回调自身失败不能再次触发 boundary
      }
    }
    // 开发者控制台:仍然打印,便于调试
    log.error(`[${this.props.name ?? 'root'}]`, error, info.componentStack);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const fbProps: ErrorFallbackProps = {
      error,
      reset: this.reset,
      name: this.props.name,
    };
    if (this.props.fallback) return this.props.fallback(fbProps);
    return <ErrorFallback {...fbProps} />;
  }
}
