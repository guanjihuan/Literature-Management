// 代码阅读器：highlight.js 按语言高亮
//
// perf(2026-08-21):highlight.js core + 8 个语言全部改为动态 import。CodeReader
// 模块本身是 React.lazy,仅在用户打开代码文件时才下载;CSS 仍走静态副作用 import,
// 它会随 CodeReader chunk 一起加载,不影响首屏。
//
// 整体收益:首屏 chunk 不带 highlight.js (~80KB JS + ~30KB CSS)。
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileCode } from 'lucide-react';
// github-dark 主题 — 模块级副作用 import,与 CodeReader chunk 一起被打包,
// 只在 CodeReader 渲染时才下载。
import 'highlight.js/styles/github-dark.css';
import type { HLJSApi } from 'highlight.js';
// audit round 9 (2026-09-15):highlight.js 历史上有过 `<svg onload=...>` 这类
//   tokenizer 输出(也包括 plugin / 自语言模块的边界 case)。source 是用户从
//   库拖入的任意文件 — 一旦有 regression, dangerouslySetInnerHTML 直接执行
//   注入的 JS → window.api 全 IPC 暴露 RCE on user data。走现有的
//   sanitizeMarkdownHtml(剥 on* 事件 + <a href> scheme 白名单)兜底,
//   与 MarkdownReader 同款 defense-in-depth 链。
import { sanitizeMarkdownHtml } from '../../lib/markdown-html-sanitize';
// perf r259:大文件降级渲染 —— 超出预算的部分不再走高亮管线(但内容不丢,
//   见 lib/reader-budget.ts 的头注:12MB 代码文件原本要把主线程堵 3~5 秒)。
import {
  READER_HIGHLIGHT_BUDGET_CHARS,
  splitByBudget,
} from '../../lib/reader-budget';
import { ReaderBudgetNotice } from './ReaderBudgetNotice';
// audit 2026-09-16 r21:H11 — chunk-load 失败时与 MarkdownReader 同款 EmptyState,
//   旧实现 Promise.all 不接 catch → setHljs 永远不调,用户看到 escapeHtml 原文
//   配 fallback 样式,以为是高亮没生效。
import { EmptyState } from '../ui/chrome';
import { createLogger } from '../../lib/logger-client';

const EXT_LANG: Record<string, string> = {
  '.py': 'python',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.json': 'json',
  '.css': 'css',
  '.html': 'html',
  '.htm': 'html',
  '.xml': 'xml',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.sh': 'bash',
  '.bash': 'bash',
};

function detectLanguage(filename: string): string | undefined {
  const idx = filename.lastIndexOf('.');
  if (idx < 0) return undefined;
  return EXT_LANG[filename.slice(idx).toLowerCase()];
}

// audit 2026-09-08:从 export 改非 export —— ReaderProps 0 外部 caller,
//   只本文件 CodeReader 引用,grep 全 src/ + tests/ 只 hit reader/ 内
//   自身。原本 export 是为"未来 caller 显式标 props 类型" 留,至今未出现。
interface CodeReaderProps {
  source: string;
  filename: string;
  language?: string;
  /** 「在系统应用打开」—— 大文件降级提示条上的兜底出口(想要完整高亮)。 */
  onOpenExternal?: () => void;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
}

export function CodeReader({ source, filename, language, onOpenExternal }: CodeReaderProps) {
  const { t } = useTranslation();
  // hljs 实例:异步加载核心 + 语言后填充;加载完前 source 原样 escape 展示。
  const [hljs, setHljs] = useState<HLJSApi | null>(null);
  // audit 2026-09-16 r21:H11 — chunk load 失败显式落地,渲染 EmptyState。
  const [loadError, setLoadError] = useState<Error | null>(null);
  const log = useMemo(() => createLogger('reader-code'), []);

  useEffect(() => {
    let disposed = false;
    (async () => {
      // audit 2026-09-16 r21:H11 — try/catch + setLoadError 镜像 MarkdownReader,
      //   Promise.all 中任一 dynamic import 拒绝(asar hash / 沙盒 build 错配)
      //   都落到 catch,不再 setHljs 永久不调。
      try {
        const [coreMod, pyMod, jsMod, tsMod, jsonMod, cssMod, xmlMod, yamlMod, bashMod] =
          await Promise.all([
            import('highlight.js/lib/core'),
            import('highlight.js/lib/languages/python'),
            import('highlight.js/lib/languages/javascript'),
            import('highlight.js/lib/languages/typescript'),
            import('highlight.js/lib/languages/json'),
            import('highlight.js/lib/languages/css'),
            import('highlight.js/lib/languages/xml'),
            import('highlight.js/lib/languages/yaml'),
            import('highlight.js/lib/languages/bash'),
          ]);
        if (disposed) return;
        const hljs = coreMod.default;
        hljs.registerLanguage('python', pyMod.default);
        hljs.registerLanguage('javascript', jsMod.default);
        hljs.registerLanguage('typescript', tsMod.default);
        hljs.registerLanguage('json', jsonMod.default);
        hljs.registerLanguage('css', cssMod.default);
        hljs.registerLanguage('html', xmlMod.default);
        hljs.registerLanguage('xml', xmlMod.default);
        hljs.registerLanguage('yaml', yamlMod.default);
        hljs.registerLanguage('yml', yamlMod.default);
        hljs.registerLanguage('bash', bashMod.default);
        hljs.registerLanguage('sh', bashMod.default);
        setHljs(hljs);
      } catch (err: unknown) {
        if (disposed) return;
        log.error('highlight.js chunk load failed', err);
        setLoadError(err instanceof Error ? err : new Error(String(err)));
      }
    })();
    return () => {
      disposed = true;
    };
  }, [log]);

  // 在一次渲染中确定 lang,同时用于高亮和 className,避免重复调用
  const lang = language ?? detectLanguage(filename) ?? 'plaintext';
  // perf r259:预算切分 —— 超预算的部分不再走高亮管线(但**内容不丢**,
  //   只是没有高亮)。实测 12MB 代码文件原本要 3191ms 高亮 + 57.8MB HTML
  //   入 DOM ⇒ 窗口「未响应」数秒;现在这段是 ~60ms。
  const budgeted = useMemo(() => splitByBudget(source, READER_HIGHLIGHT_BUDGET_CHARS), [source]);
  const html = useMemo(() => {
    if (!hljs) return escapeHtml(source);
    try {
      // audit round 9 (2026-09-15):hljs 输出经 sanitizeMarkdownHtml 兜底 —
      //   hljs 自带 sanitizer 不挡 `<svg onload=...>` / `<img onerror=javascript:...>`,
      //   也不挡 hljs plugin 注入的 attribute。defense-in-depth:剥 on* 事件 +
      //   <a href> scheme 白名单,与 MarkdownReader 一致。
      const raw =
        lang === 'plaintext'
          ? escapeHtml(budgeted.head)
          : hljs.highlight(budgeted.head, { language: lang, ignoreIllegals: true }).value;
      // 超预算的尾巴:HTML 转义后**原样接上**(内容完整,只是没有高亮)。
      // escapeHtml 已把 & < > 全转义 ⇒ 尾巴不可能带进标签 ⇒ 不需要
      // (也不该)再过一遍 sanitize(那是给标签用的)。
      return budgeted.truncated
        ? sanitizeMarkdownHtml(raw) + escapeHtml(budgeted.tail)
        : sanitizeMarkdownHtml(raw);
    } catch {
      // 高亮失败(罕见,如语言描述损坏)退回原文 + HTML escape
      return escapeHtml(source);
    }
  }, [hljs, source, lang, budgeted]);

  return (
    // perf r259:外层改成 flex 列 —— 降级提示条固定在顶部,不随正文滚动。
    <div className="flex-1 flex flex-col overflow-hidden" aria-label={filename}>
      {budgeted.truncated && !loadError && (
        <ReaderBudgetNotice
          message={t('reader.largeCodeNotice', {
            size: Math.round(READER_HIGHLIGHT_BUDGET_CHARS / 1024),
          })}
          onOpenExternal={onOpenExternal}
        />
      )}
      <div className="flex-1 overflow-auto p-8">
        {loadError ? (
          // audit 2026-09-16 r21:H11 — 与 MarkdownReader 同款 chunk-load 兜底 EmptyState,
          //   复用 reader.errorMarkdownLoaderReader{Title,Desc} 让两 reader 风格一致。
          <EmptyState
            icon={<FileCode size={24} aria-hidden="true" />}
            title={t('reader.errorMarkdownLoaderReaderTitle')}
            description={t('reader.errorMarkdownLoaderReaderDesc', { filename })}
            size="md"
            hint={<span className="text-xs opacity-60">{loadError.message}</span>}
          />
        ) : source.length === 0 ? (
          // audit-r143 (2026-10-19) MED:空内容不再静默出空白 <pre>(用户分不清
          //   「文件真没东西」还是「reader 坏了」),给一个 EmptyState 提示。
          //   复用 reader.emptyDoc{Desc},与 MarkdownReader 同节奏。
          <EmptyState
            icon={<FileCode size={24} aria-hidden="true" />}
            title={t('reader.emptyDoc')}
            description={t('reader.emptyDocDesc', { filename })}
            size="md"
          />
        ) : (
          <pre className="max-w-4xl mx-auto rounded-md border border-border-subtle bg-bg-surface overflow-auto">
            <code
              className={`hljs language-${lang} font-mono text-sm leading-6 block p-4`}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </pre>
        )}
      </div>
    </div>
  );
}
