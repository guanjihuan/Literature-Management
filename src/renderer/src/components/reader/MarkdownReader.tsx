// Markdown 阅读器:复用 markdown-it,保留 wiki 链接渲染
// 学术风格(2026-08-20):接 .prose-academic 全局类(衬线字体 + 1.75 行距 +
// h2 底边 + blockquote 左竖条 + table 头底色 + code 行内样式),
// 删 inline [&_xxx]:xxx 链,避免与 globals.css 互相打架。
//
// perf(2026-08-21):markdown-it 改为动态 import — 阅读器主 chunk 不再带
// markdown-it + rules。md 实例在 mount 时异步初始化一次;卸载时 dispose 释放。
// Suspense 由父 Reader 提供(audit-r124:括号原句「LibraryModuleLayout 也提供
// 兜底边界」已腐 —— 该组件随 r56 库退役整体删除,src 现零命中,只剩本注释)。
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type MarkdownItType from 'markdown-it';
import { FileText } from 'lucide-react';
import { sanitizeMarkdownHtml } from '../../lib/markdown-html-sanitize';
// perf r259:大文件降级渲染 —— 超出预算的部分不再走 markdown 渲染管线
//   (但**内容不丢**,以 <pre> 纯文本呈现;见 lib/reader-budget.ts 头注:
//   5.6MB markdown 原本要 889ms 渲染 + 1943ms 净化,窗口「未响应」数秒)。
import { READER_MARKDOWN_BUDGET_CHARS, splitByBudget } from '../../lib/reader-budget';
import { ReaderBudgetNotice } from './ReaderBudgetNotice';
import { EmptyState } from '../ui/chrome';
// audit C3R89 (2026-08-22):走 createLogger 统一前缀
import { createLogger } from '../../lib/logger-client';

const log = createLogger('MarkdownReader');

// 仅用作类型 — 运行时实例异步从 markdown-it 加载。
type MarkdownItInstance = MarkdownItType;

// audit 2026-09-08:从 export 改非 export —— 0 外部 caller,只本文件
//   MarkdownReader 引用。
interface MarkdownReaderProps {
  source: string;
  filename: string;
  /** 「在系统应用打开」—— 大文件降级提示条上的兜底出口(想要完整排版)。 */
  onOpenExternal?: () => void;
}

export function MarkdownReader({ source, filename, onOpenExternal }: MarkdownReaderProps) {
  // audit C3R80 (2026-08-22):硬编码中文错误文案 → i18n key,跟 Reader.tsx C3R80 同模式
  const { t } = useTranslation();
  // md 实例:异步加载后填充;加载完成前 source 渲染空字符串占位,
  // 父 Suspense fallback=null 兜底,用户视觉上就是一次 ~50-100ms 的白屏过渡。
  const [md, setMd] = useState<MarkdownItInstance | null>(null);
  // audit C3R36 (2026-08-22):动态 import('markdown-it') 失败时(Electron asar hash
  // 不匹配 / 沙盒 build / 网络隔离环境)给用户看 EmptyState + 日志,不再静默白屏。
  const [loadError, setLoadError] = useState<Error | null>(null);

  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const { default: MarkdownIt } = await import('markdown-it');
        if (disposed) return;
        const instance = new MarkdownIt({
          // audit-r99:此 flag 是 markdown-html-sanitize 字符串层净化的安全前置
          // (实体编码 scheme 在字符串层放行靠它兜底),行为锁见
          // tests/unit/renderer/reader/markdown-reader.test.tsx —— 本轮补齐 9 例
          // (含上面点名的「安全前置」describe:原始 HTML 只作文本 / 危险 scheme
          //  链接不落地 / linkify 保留 http 链接)。
          html: false, // 安全：不渲染原始 HTML
          linkify: true,
          breaks: false,
        });

        // 重构 (2026-09):wiki 链接 ruler 已下线 —— core-scope refactor 砍掉反向连接 / 知识图谱,
        //   [[wiki-link]] 渲染为纯文本(markdown-it 默认行为)而不是 wiki 锚链接。

        // 去除 fenced/indented code block 末尾的换行，保持渲染输出与测试断言一致
        // 用 guard 防御 markdown-it 未来版本移除某个 rule 的可能
        const defaultFence = instance.renderer.rules.fence;
        if (defaultFence) {
          instance.renderer.rules.fence = (tokens, idx, options, env, self) => {
            tokens[idx].content = tokens[idx].content.replace(/\n$/, '');
            return defaultFence(tokens, idx, options, env, self);
          };
        }
        const defaultCodeBlock = instance.renderer.rules.code_block;
        if (defaultCodeBlock) {
          instance.renderer.rules.code_block = (tokens, idx, options, env, self) => {
            tokens[idx].content = tokens[idx].content.replace(/\n$/, '');
            return defaultCodeBlock(tokens, idx, options, env, self);
          };
        }
        if (!disposed) setMd(instance);
      } catch (err: unknown) {
        // chunk-load 失败 / 沙盒环境阻止 / asar hash mismatch 都进这里
        // 不让 unhandled rejection 静默吞掉 —— 用户看到 EmptyState + DevTools 日志,
        // 比永久白屏好
        const e = err instanceof Error ? err : new Error(String(err));
        log.error('failed to load markdown-it', e);
        if (!disposed) setLoadError(e);
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  // perf r259:预算切分 —— 超预算的部分不再走 markdown 渲染管线(内容不丢,
  //   以 <pre> 纯文本呈现)。实测 5.6MB markdown 原本 889ms 渲染 + 1943ms
  //   净化 ⇒ 窗口「未响应」数秒;现在这段 ~150ms。
  const budgeted = useMemo(() => splitByBudget(source, READER_MARKDOWN_BUDGET_CHARS), [source]);
  const html = useMemo(
    () => (md ? sanitizeMarkdownHtml(md.render(budgeted.head)) : ''),
    [md, budgeted],
  );
  const isEmpty = !source.trim();
  // audit round 17 (2026-09-15):A11Y-M9 — 从 source 抓第一行 # heading 给 SR。
  //   markdown body 已经渲染 h1 视觉,但 SR heading nav 看到的「第一级
  //   heading」是浏览器解析 HTML 后的 h1,这没问题;问题是 reader 外层
  //   是 <div aria-label=filename>,SR landmark rotor 只能跳到 div,
  //   没有内容标题。现在加一个 sr-only h1(NVDA/VO 在 article 内第一
  //   个可见 heading 之前),让 SR 用户用 H 直接跳到「本笔记主题」。
  //   多行匹配(m flag):抓源文件第一个 # 起始行;trim() 去多余空白。
  const firstHeading = useMemo(() => {
    const m = source.match(/^#\s+(.+)$/m);
    return m ? m[1].trim() : null;
  }, [source]);
  return (
    // perf r259:外层改成 flex 列 —— 降级提示条固定在顶部,不随正文滚动。
    // audit-r143 (2026-10-19) MED:padding 统一到 p-8 —— CodeReader / PlainReader
    //   都用 p-8 (32px),MarkdownReader 之前用 p-6 (24px)。三种 reader 切换
    //   时主区边距"跳"8px,视觉不齐。统一后跨 reader 切换边距不动。
    <div className="flex-1 flex flex-col overflow-hidden" aria-label={filename}>
      {budgeted.truncated && !loadError && !isEmpty && (
        <ReaderBudgetNotice
          message={t('reader.largeMarkdownNotice', {
            size: Math.round(READER_MARKDOWN_BUDGET_CHARS / 1024),
          })}
          onOpenExternal={onOpenExternal}
        />
      )}
      <div className="flex-1 overflow-auto p-8">
        {loadError ? (
          // audit C3R36 (2026-08-22):chunk load 失败时给用户明确反馈,不再静默白屏
          <EmptyState
            icon={<FileText size={24} aria-hidden="true" />}
            title={t('reader.errorMarkdownLoaderReaderTitle')}
            description={t('reader.errorMarkdownLoaderReaderDesc', { filename })}
            size="md"
            hint={<span className="text-xs opacity-60">{loadError.message}</span>}
          />
        ) : isEmpty ? (
          // 空内容不要塞个空 <p>:视觉上 reader 是"坏了"还是"空"分不清,
          // 直接复用 chrome.tsx 的 EmptyState 给一个明确提示
          <EmptyState
            icon={<FileText size={24} aria-hidden="true" />}
            title={t('reader.emptyDoc')}
            description={t('reader.emptyDocDesc', { filename })}
            size="md"
          />
        ) : (
          <article className="prose-academic max-w-[68ch] mx-auto">
            {/* sr-only 视觉不变(markdown 自身已渲染 h1),SR 多一个 heading 锚点 */}
            {firstHeading && <h1 className="sr-only">{firstHeading}</h1>}
            <div dangerouslySetInnerHTML={{ __html: html }} />
            {/* perf r259:超预算的尾巴 —— 纯文本呈现(React 文本子节点自动转义,
                不经 dangerouslySetInnerHTML ⇒ 无 XSS 面)。内容完整,只是没有排版。 */}
            {budgeted.truncated && (
              <pre className="mt-4 whitespace-pre-wrap break-words font-mono text-sm leading-6 text-fg-secondary">
                {budgeted.tail}
              </pre>
            )}
          </article>
        )}
      </div>
    </div>
  );
}
