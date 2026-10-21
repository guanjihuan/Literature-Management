// ErrorBoundary fallback UI — 出错时不白屏,而是给出"哪里 + 为什么 + 怎么办"
//
// 设计:
//   - 模块语义色块表示出错的区域(name)
//   - 折叠的 stack trace,避免默认展示一大片英文吓到用户
//   - 三个动作:重试 / 复制堆栈 / 反馈
//   - 视觉与 Linear 风格对齐:panel 容器 + module 色块
//
// i18n 兜底 (2026-09-06):错误 UI 不能依赖 useTranslation() —
//   useTranslation 在 i18n 引擎 init 完成前返回 key 本身,会让"出错时本想给
//   用户一个清楚的解释"反而暴露一串 raw key (errorBoundary.title / regionLabel / ...)。
//   改用直接 import zh-CN locale 作为权威来源:zh-CN 是 fallbackLng,任何用户
//   的"出错兜底语言"都给中文是合理选择(i18n 就绪后用户正常态仍走 useTranslation
//   拿到自己的语言,但兜底先保证不出错)。回声/interpolate/clipboard 三案
//   行为锁 tests/unit/renderer/components/system/error-fallback-i18n-echo.test.tsx(audit-r112,本轮补齐)。
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Copy, RotateCcw, ChevronDown, ChevronRight } from 'lucide-react';
import zhCN from '../../i18n/locales/zh-CN.json';
import { Button } from '../ui/Button';
import { useToast } from '../../lib/toast';
import { clsx } from '../../lib/clsx';

// 兜底字符串从 zh-CN JSON 直接取,避免 useTranslation 在 i18n 未就绪时
// 返回 key 导致兜底界面也"出错"。
const FALLBACK = zhCN.errorBoundary;
const FALLBACK_TOAST = zhCN.toast;

export interface ErrorFallbackProps {
  error: Error;
  reset: () => void;
  /** 出错区域名(如 "LibraryReader") */
  name?: string;
}

export function ErrorFallback({ error, reset, name }: ErrorFallbackProps) {
  // 正常态走 useTranslation (跟随用户设置的语言);i18n 未就绪时 t() 会回
  // 到 notReadyT 返回 key —— 这种情况我们用 FALLBACK(从 zh-CN 直接 import)
  // 兜底,所以实际效果是:i18n 就绪后跟用户语言,i18n 未就绪时给中文兜底。
  const { t } = useTranslation();
  const [showStack, setShowStack] = useState(false);
  const toast = useToast((s) => s.show);

  // i18n 未就绪 / key 缺失 → t() 返回 key 本身(以 "namespace." 开头);
  // 遇到这种"回声"就用对应 fallback map 的值兜底。fallback 也走 i18next
  // 同款 {var} 替换 —— regionLabel / toast.{msg} 等带占位符的 key 在兜底
  // 时仍能给用户看到具体值,而非裸 "{msg}"。闭包捕获 t —— 钩子顺序保证
  // 这一定义在 useTranslation 之后,无前置条件 hook 调用风险。
  //
  // ⚠️ 调用形态不变式(audit-r124 校正:原注描述的「switch 分支各写一行
  //   字面量」形态不存在,本组件从未有过 switch —— 真实守卫是下面两条,
  //   破坏任一都会让静态扫描丢线索):
  //   1) tWithFallback('errorBoundary'|'toast', ...) 第一参必须是命名空间
  //      **字面量** —— i18n-dead-keys.test 的 tWithFallback pattern 按
  //      `ns.*` 前缀整体视同 used;改成变量传 ns 则 errorBoundary.* /
  //      toast.stackCopied 等全数误判 dead。
  //   2) helper 内部保持 t(`${namespace}.${key}`) 模板字面量直调 —— 命中
  //      PATTERNS[6] /\bt\(\s*[`"']([\w]+)\.\$\{[\w]+\}[`'"]/g(prefix 模式)。
  //      若改成先拼完整 key 字符串再 t(resolved) 传入,两条 pattern 都
  //      抓不到,同样批量误判。
  //
  // interpolate 闭包 —— 用一个独立的命名函数(而非内联 split-join),方便
  // 复用 + 测试时单独 import 验证。
  const interpolate = (
    template: string,
    values: Readonly<Record<string, string | number>>,
  ): string => template.replace(/\{(\w+)\}/g, (_, k) => String(values[k] ?? `{${k}}`));

  const tWithFallback = (
    namespace: 'errorBoundary' | 'toast',
    key: string,
    fallback: Readonly<Record<string, string>>,
    values?: Readonly<Record<string, string | number>>,
  ): string => {
    // i18next 拿到 values 时自己会做 {var} 替换,没拿到就直接返回字面量。
    // 默认行为下 t() 找不到 key 会回声 key 字符串(namespace.key 形态),
    // 我们用这个特征判断"是否走 fallback"。
    const resolved = values ? t(`${namespace}.${key}`, values) : t(`${namespace}.${key}`);
    if (!resolved.startsWith(`${namespace}.`)) return resolved;
    const fb = fallback[key];
    return values ? interpolate(fb, values) : fb;
  };

  const stack = error.stack ?? '';
  const copyStack = async () => {
    try {
      await navigator.clipboard.writeText(`${name ?? 'unknown'}\n${error.message}\n\n${stack}`);
      toast({
        type: 'success',
        message: tWithFallback('toast', 'stackCopied', FALLBACK_TOAST),
      });
    } catch {
      toast({
        type: 'error',
        message: tWithFallback('toast', 'copyStackFailed', FALLBACK_TOAST),
      });
    }
  };

  return (
    <div role="alert" className="flex-1 flex items-center justify-center p-8 bg-canvas">
      <div className="panel max-w-lg w-full p-6">
        {/* 区域标识 */}
        <div className="flex items-start gap-3 mb-4">
          {/* audit (2026-09-03):徽章色原硬编码 module-library ——
              ErrorBoundary 是跨模块通用的(library/notes/全局都触发),
              之前 notes 模块崩了也显示青色,误导用户去查文献。改为
              danger(红色)+ AlertTriangle,语义与状态色对齐。 */}
          <div className="flex-shrink-0 w-10 h-10 rounded flex items-center justify-center bg-danger/15 text-danger">
            <AlertTriangle size={20} aria-hidden="true" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-2xs text-fg-tertiary tabular-nums">
              {name
                ? tWithFallback('errorBoundary', 'regionLabel', FALLBACK, { name })
                : tWithFallback('errorBoundary', 'topLevelError', FALLBACK)}
            </div>
            {/* audit (2026-09-03 #21):补 uppercase tracking-wider,跟 Modal/Drawer
                面板标题节奏一致。 */}
            <h2 className="text-sm font-semibold uppercase tracking-wider text-fg mt-0.5">
              {tWithFallback('errorBoundary', 'title', FALLBACK)}
            </h2>
            <p className="text-xs text-fg-secondary mt-1">
              {tWithFallback('errorBoundary', 'description', FALLBACK)}
            </p>
          </div>
        </div>

        {/* 错误消息 */}
        <div className="bg-bg-surface border border-border-subtle rounded-md p-3 mb-4">
          <div className="text-2xs text-fg-tertiary mb-1">
            {tWithFallback('errorBoundary', 'errorInfoLabel', FALLBACK)}
          </div>
          <div className="text-sm text-fg font-mono break-words">
            {error.message || tWithFallback('errorBoundary', 'noMessage', FALLBACK)}
          </div>
        </div>

        {/* 堆栈(可折叠) */}
        {stack && (
          <div className="mb-4">
            <button
              type="button"
              onClick={() => setShowStack((s) => !s)}
              aria-expanded={showStack}
              className={clsx(
                'flex items-center gap-1.5 text-2xs text-fg-tertiary hover:text-fg-secondary transition-colors duration-120',
              )}
            >
              {showStack ? (
                <ChevronDown size={11} aria-hidden="true" />
              ) : (
                <ChevronRight size={11} aria-hidden="true" />
              )}
              {showStack
                ? tWithFallback('errorBoundary', 'collapseStack', FALLBACK)
                : tWithFallback('errorBoundary', 'expandStack', FALLBACK)}
            </button>
            {showStack && (
              <pre className="mt-2 text-2xs text-fg-tertiary bg-bg-surface border border-border-subtle rounded-md p-2 max-h-40 overflow-auto font-mono whitespace-pre-wrap break-all">
                {stack}
              </pre>
            )}
          </div>
        )}

        {/* 动作 */}
        <div className="flex items-center gap-2">
          <Button variant="primary" size="lg" onClick={reset}>
            <RotateCcw size={12} aria-hidden="true" />{' '}
            {tWithFallback('errorBoundary', 'retry', FALLBACK)}
          </Button>
          <Button variant="secondary" size="lg" onClick={copyStack}>
            <Copy size={12} aria-hidden="true" />{' '}
            {tWithFallback('errorBoundary', 'copyStack', FALLBACK)}
          </Button>
        </div>
      </div>
    </div>
  );
}
