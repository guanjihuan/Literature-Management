// 阅读器分发器:按扩展名路由;file == null 时显示 ReaderEmpty
// 错误一律进 ReaderError
//
// perf(2026-08-21):5 个子阅读器改为 React.lazy + Suspense。
//   - CodeReader 依赖 highlight.js 核心 + 8 个语言 + github-dark.css(~160KB)
//   - MarkdownReader 依赖 markdown-it + wiki_link inline ruler(~80KB)
//   - PDFReader/ImageReader/PlainReader/UnsupportedReader 各 ~5-10KB
// 它们只在用户打开对应类型文件时才下载,Reader 主 chunk 不再带这些依赖。
// Suspense fallback 用 ReaderLoading(局部"加载中…")。
//
// audit-r56:LibraryFile 类型 import 删 —— 库退役,「库扫描聚合对象」不存在。
//   Reader 仍按 absPath 路由(打开 PDF 来读 = 用户从外部选 PDF 文件 / OS 关联
//   唤起),但 file 入参形态由「LibraryFile(id/extension/absPath/filename)」
//   改成 ReaderFile 直定义 —— 缩小到本组件实际消费的 4 字段(id 留作
//   readerLoadedIdRef key,后续如统一从外部传入可重用)。
import { Suspense, lazy, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { IpcErrorCode } from '@shared/types';
import { api } from '../../lib/api';
import { useToast } from '../../lib/toast';
// audit C3R48 (2026-08-22):errMsg 替代 verbose 错误格式化
// audit C3R75 (2026-08-22):硬编码中文 '打开失败:' → t('toast.openFailed', { msg })
import { errMsg } from '../../lib/error';
import { fileUrlOf } from '../../utils/file-url';
import { ReaderEmpty } from './ReaderEmpty';
import { ReaderError } from './ReaderError';
import { ReaderLoading } from './ReaderLoading';
// audit-r143:共享文件名 chrome —— 每个 reader variant 顶部统一显示
//   「正在阅读 X」(有视用户),SR 走 variant 自带 aria-label,不重复。
import { ReaderChrome } from './ReaderChrome';

// audit 2026-09-07 (NIT #14):6 个 lazy reader —— 每个直接 import().then(),
//   不抽 helper。helper 写法要么丢 props 类型(component 变成 <unknown>),
//   要么每个调用点显式写泛型,行数不比 inline 短。inline 由 TS 自动按
//   m.X 推断 reader 类型,JSX 调用侧能看到完整 props(absPath/source/text…)。
const PDFReader = lazy(() => import('./PDFReader').then((m) => ({ default: m.PDFReader })));
const ImageReader = lazy(() => import('./ImageReader').then((m) => ({ default: m.ImageReader })));
const MarkdownReader = lazy(() =>
  import('./MarkdownReader').then((m) => ({ default: m.MarkdownReader })),
);
const CodeReader = lazy(() => import('./CodeReader').then((m) => ({ default: m.CodeReader })));
const PlainReader = lazy(() => import('./PlainReader').then((m) => ({ default: m.PlainReader })));
const UnsupportedReader = lazy(() =>
  import('./UnsupportedReader').then((m) => ({ default: m.UnsupportedReader })),
);

// (lazy reader 声明见上方,抽不到 helper 里 — 见上方 helper 注释)

// audit-r63:恢复 export —— reader-dispatch.test.tsx 的 ReaderFileFixture 曾是
//   本接口的手工复制品,双份 shape 会静默漂移;test 改为 import type 复用。
export interface ReaderFile {
  id: string;
  extension: string;
  absPath: string;
  filename: string;
}
// audit-r63:删 onRescan —— library 退役后 rescan 链路全断,无任何 caller
//   传该 prop,纯死 prop 钻层(ReaderError 同步删)。
interface ReaderProps {
  file: ReaderFile | null;
}

const CODE_EXTS = new Set([
  '.py',
  '.js',
  '.ts',
  '.tsx',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.css',
  '.html',
  '.htm',
  '.xml',
  '.yaml',
  '.yml',
  '.sh',
  '.bash',
]);

const PLAIN_EXTS = new Set(['.txt', '.log', '.csv', '.toml', '.ini', '.conf', '.env']);

const IMAGE_EXTS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.svg',
  '.bmp',
  '.ico',
  '.tiff',
  '.tif',
  '.avif',
]);

// TextDecoder 是无状态的;模块级只创建一次,避免每次渲染 new 实例。
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });

// 'error' 子类型精确列出 ReaderFailure 的 4 个码,而不是用 string,
// 让 TOO_LARGE 等可以携带 size 不再需要 `as any`。
// audit v2.0 Phase 0c (2026-09-17):用 Extract<IpcErrorCode, ...> 从 canonical
//   union 派生,新 IPC 错误码自动同步可见;type-level 验证 4 个码都在 union 内。
type ErrorStateCode = Extract<IpcErrorCode, 'NOT_FOUND' | 'EACCES' | 'TOO_LARGE' | 'IO_ERROR'>;
type ErrorState = {
  code: ErrorStateCode;
  message: string;
  size?: number;
  /**
   * audit 2026-10-21 (r252):错误描述的 **i18n key**(可选)。
   *
   * 旧实现把 `t('reader.errorGeneric')` / `t('reader.errorFileFormatCorrupt')`
   * 在**出错那一刻**就翻译好、烤进 state ⇒ 用户随后在设置里换语言 ⇒
   * 描述还是旧语言,而标题(渲染期翻译)是新语言 ⇒ **中英混排**。
   * 改法:state 里存 key,渲染期再翻译 ⇒ 语言永远跟当前设置一致。
   * 原始错误文本(IPC 的 message / errMsg(err))不是 i18n 文案,仍走 message。
   */
  messageKey?: string;
};
// audit round 8 (2026-09-14):把 ErrorStateCode 抽出来单独命名,KNOWN_CODES
//   用 `satisfies ErrorStateCode[]` 强制与上面 union 同步 —— 新增 ErrorStateCode
//   成员时(比如 'EBUSY' / 'TIMEOUT'),编译期会因 satisfies 失败而报红,提示
//   同步白名单。避免"union 加了但 Set 漏写 → 后端返该码时落到 IO_ERROR 兜底
//   + 原文 message"这类静默退化。

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; data: Uint8Array }
  | { kind: 'error'; error: ErrorState };

function normalizeExt(extension: string): string {
  return '.' + (extension || '').replace(/^\./, '').toLowerCase();
}

// 派发到的 reader 是否需要 buffer 内容 —— PDF/Image/Unsupported 只需 absPath+filename
// 不读字节。这样做的理由:
//   - 节省一次 IPC readFileForReader(unsupported 文件大概率很大,读出来立刻被扔)
//   - dispatch 测试(.djvu 等)不再 race "IPC 完成 + lazy Suspense 解析",Suspense
//     fallback 显示时间变长容易让 waitFor 超时
// 与下方 dispatch 分支保持单一可信源;两者都用同一个判断,新加 reader 时改一处即可。
function needsFileData(ext: string): boolean {
  if (ext === '.pdf') return false;
  if (IMAGE_EXTS.has(ext)) return false;
  // Markdown / Code / Plain 要解码成字符串;Unsupported 不需要任何 buffer。
  if (ext === '.md') return true;
  if (CODE_EXTS.has(ext)) return true;
  if (PLAIN_EXTS.has(ext)) return true;
  return false;
}

// audit-r119:「不读 buffer 且子组件会把 absPath 变成可加载 URL」的类型 ——
// 只有这两类需要 rkms 探测。UnsupportedReader(其它扩展名)只渲染文件名文案,
// 不引用 URL,探测纯属浪费。与 needsFileData 共享 IMAGE_EXTS/.pdf 单一可信源。
function isStreamSrcType(ext: string): boolean {
  return ext === '.pdf' || IMAGE_EXTS.has(ext);
}

export const Reader = memo(function Reader({ file }: ReaderProps) {
  const [state, setState] = useState<LoadState>({ kind: 'idle' });
  // 用户手动点「重试」时递增,触发读取 effect 重新跑。原 bug:effect 仅依赖
  // file?.id / ext,retry 时两者不变,loading 永远卡住。
  const [retryNonce, setRetryNonce] = useState(0);
  // C3R75: 用于 onOpenExternal 错误 toast — 走 i18n key,不硬编码中文
  const { t } = useTranslation();

  // 派生:扩展名和稳定 id 都要 memo,避免 dispatch 路径里重复算
  const ext = useMemo(() => (file ? normalizeExt(file.extension) : ''), [file]);

  // audit 2026-09-10:记 effect 跑完时 state.data 属于哪个 file.id ——
  //   切文件时父组件传新 file prop → render 先发生(此时 state 还是旧
  //   ready + 旧 data),effect 后跑才把 state 切到 loading。中间有一帧
  //   MarkdownReader/CodeReader/PlainReader 拿到旧 source + 新 filename,
  //   用户看到"A 内容 + B 名字"再切到 loading。readerLoadedIdRef 让 render
  //   路径检查"state 已 ready 但 loadedId !== file.id" → 直接走 loading,
  //   不暴露脏 frame。ImageReader/PDFReader/UnsupportedReader 不走 source,
  //   这条路径不影响它们。
  const readerLoadedIdRef = useRef<string | null>(null);
  // 把 effect 内对 state 的写入与 file.id 关联起来需要保留 effect 内部读取的
  // file.id —— 闭包外提一份。effect 内 setState 前 setLoadedId(file.id),
  // 渲染路径再 check。

  useEffect(() => {
    if (!file) {
      readerLoadedIdRef.current = null;
      setState({ kind: 'idle' });
      return;
    }
    // 不需要 buffer 的扩展名(PDF/Image/Unsupported):跳过 IPC read,直接 ready。
    // 减少一次 IPC(unsupported 文件可能很大,完全没必要读),并消除 UnsupportedReader
    // 测试里 IPC 完成 vs Suspense 解析的 race。
    if (!needsFileData(ext)) {
      // audit-r119:PDF/Image 由 iframe/img 直接 navigate 到 rkms:// URL,此前
      // 「零探测」—— 文件缺失时 protocol handler 的 text/plain 错误体被 Chromium
      // 当页面渲染,用户看到全屏英文 debug 串(报障实证)。流式类型先 fetch 探测
      // 同一 rkms URL(与 iframe 同源 oracle,白名单/404/403 语义一致),失败
      // 路由到既有 ReaderError;非流式兜底类型(UnsupportedReader)不探测 ——
      // 它不引用任何 URL,探测无意义。
      // fetch 本身 throw(协议未注册 / 测试环境无 fetch)→ 保守放行 ready,
      // 保持原行为,绝不让探测本身变成新的白屏来源。
      if (!isStreamSrcType(ext)) {
        readerLoadedIdRef.current = file.id;
        setState({ kind: 'ready', data: new Uint8Array(0) });
        return;
      }
      let probeCancelled = false;
      setState({ kind: 'loading' });
      (async () => {
        const res = await fetch(fileUrlOf(file.absPath));
        // 立即放弃响应体,只消费 status —— 不读字节
        res.body?.cancel();
        if (probeCancelled) return;
        if (res.ok) {
          readerLoadedIdRef.current = file.id;
          setState({ kind: 'ready', data: new Uint8Array(0) });
        } else if (res.status === 404) {
          setState({ kind: 'error', error: { code: 'NOT_FOUND', message: '' } });
        } else if (res.status === 403) {
          setState({ kind: 'error', error: { code: 'EACCES', message: '' } });
        } else {
          setState({
            kind: 'error',
            error: { code: 'IO_ERROR', message: '', messageKey: 'reader.errorGeneric' },
          });
        }
      })().catch(() => {
        if (probeCancelled) return;
        readerLoadedIdRef.current = file.id;
        setState({ kind: 'ready', data: new Uint8Array(0) });
      });
      return () => {
        probeCancelled = true;
      };
    }
    let cancelled = false;
    setState({ kind: 'loading' });
    (async () => {
      // audit-r71:r56 起该通道语义是「按绝对路径读 bytes」,之前这里还传
      //   file.id(品牌 ResourceId,'lit:...' 形态)→ 文本类文献(md/code/txt)
      //   必然 NOT_FOUND。absPath 才是 fs 调用唯一的真相源(见 store/literature
      //   头注「fs 调用一律用 absPath,不要用 id」)。
      const r = await api.readFileForReader(file.absPath);
      if (cancelled) return;
      if (!r.ok) {
        // audit 2026-09-07:白名单 r.code —— 之前 `(r.code as ErrorState['code'])
        //   || 'IO_ERROR'` 永远不会落到 IO_ERROR:任何非空字符串都是 truthy,
        //   类型断言也吞掉类型系统保护;后端返 'EBUSY' / 'ENOSPC' 等未映射码
        //   会直接进入 error 渲染路径变成 errorGeneric + 原文 message。改成
        //   在白名单里再 cast,未知码走 IO_ERROR 兜底。
        const KNOWN_CODES: ReadonlySet<ErrorStateCode> = new Set([
          'NOT_FOUND',
          'EACCES',
          'TOO_LARGE',
          'IO_ERROR',
          // audit round 8 (2026-09-14):satisfies 强制白名单与 ErrorStateCode
          //   union 同步,新增 code 时漏写在这里 TS 会报错。
        ] satisfies ErrorStateCode[]);
        const code: ErrorStateCode = KNOWN_CODES.has(r.code as ErrorStateCode)
          ? (r.code as ErrorStateCode)
          : 'IO_ERROR';
        setState({
          kind: 'error',
          error: {
            code,
            message: r.message,
            size: r.size,
          },
        });
        return;
      }
      const payload = r.data;
      // 验证 payload.data 是 TypedArray 或 ArrayBuffer — 其它形状(string /
      // object / null)交给 Uint8Array 构造时会抛 "input must be a TypedArray
      // or ArrayBuffer"。先在边界收窄,让错误状态走 error.kind 而不是
      // 整 reader 树 unmount。ReadFileForReaderResult 契约里 data 一定是
      // Uint8Array,所以 Uint8Array 路径是常规;ArrayBuffer 是后向兼容的兜底。
      // r.data 已被 typed 收窄为 {data: Uint8Array},通过 unknown 中转让
      // ArrayBuffer 运行时检查变得可表达。
      const rawData = payload.data as unknown;
      let data: Uint8Array;
      if (rawData instanceof Uint8Array) {
        data = rawData;
      } else if (rawData instanceof ArrayBuffer) {
        data = new Uint8Array(rawData);
      } else {
        setState({
          kind: 'error',
          // audit 2026-08-28:走 i18n key — 旧硬编码中文,英文用户看到中文错误
          // audit 2026-10-21 (r252):存 **key** 而不是翻译结果 —— 翻译结果
          //   会被烤进 state,用户换语言后描述停留在旧语言(标题却是新的)。
          error: {
            code: 'IO_ERROR',
            message: '',
            messageKey: 'reader.errorFileFormatCorrupt',
          },
        });
        return;
      }
      readerLoadedIdRef.current = file.id;
      setState({ kind: 'ready', data });
    })().catch((err: unknown) => {
      // audit-r80 (2026-10-17):IIFE 裸调用之前没有 .catch ——
      //   readFileForReader 的 promise reject(IPC 通道断 / preload 抛 /
      //   主进程 handler 未注册)时,异常成 unhandled rejection,且 state
      //   永久卡在 'loading'(用户看到 spinner 死转,无错误反馈)。统一
      //   走 error 态,与 !r.ok 分支同语义。
      if (cancelled) return;
      setState({
        kind: 'error',
        error: { code: 'IO_ERROR', message: errMsg(err) },
      });
    });
    return () => {
      cancelled = true;
    };
    // effect 只关心文件身份(id + ext),file 对象其它字段变化不应重读 buffer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.id, ext, retryNonce]);

  // 文件切换时常被父组件重渲染,onOpenExternal 是稳定引用 → 子组件不会无谓 rerender
  const onOpenExternal = useCallback(
    () => {
      if (!file) return;
      // audit-r56:api.openFile(file.id) → api.openPath(file.absPath) ——
      //   库下线后没有「库文件 id」可调,OS 级打开走 shell:open-path 通用通道。
      // 必须 .catch:openPath IPC 失败时(主进程 throw / 通道断),fire-and-forget
      // 会变成 unhandled promise rejection,而 ctx-menu.ts / CollectionItemRow.tsx
      // 的同款调用都走 .then + .catch,这里保持一致给用户错误反馈。
      // C3R75: 走 i18n key 'toast.openFailed',不硬编码 '打开失败:' 模板字符串
      api
        .openPath(file.absPath)
        .then((r) => {
          if (!r.ok)
            useToast
              .getState()
              .show({ type: 'error', message: t('toast.openFailed', { msg: r.message }) });
        })
        .catch((err: unknown) => {
          useToast
            .getState()
            .show({ type: 'error', message: t('toast.openFailed', { msg: errMsg(err) }) });
        });
    },
    // api.openPath 只用 file.absPath;file 其它字段变化无需重建回调。
    // audit 2026-10-21 (r252):**必须带上 t**。
    //   react-i18next 的 useTranslation 返回的 t 是 `i18n.getFixedT(lng)` ——
    //   身份**跟着语言走**(语言不变时稳定,变了就换新函数)。旧 deps 只有
    //   [file?.absPath] ⇒ 用户在设置里换语言后,这个回调**不重建** ⇒ 闭包
    //   里的 t 停在旧语言 ⇒ 「在系统应用打开」失败时的 toast 用**旧语言**
    //   渲染(实测 getFixedT('zh-CN') 与 getFixedT('en-US') 是两个不同函数)。
    //   带上 t 后:语言变 ⇒ 回调重建 ⇒ toast 用新语言;语言不变 ⇒ t 身份
    //   稳定 ⇒ 不会多重建。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [file?.absPath, t],
  );

  // perf r247:useMemo 化 —— 旧实现在**每次 render** 都 decode 一遍整个文件
  //   (TEXT_DECODER.decode(state.data) 是 O(字节数) 的 UTF-8 解码 + 新字符串
  //   分配)。state.data 本身是稳定的引用,内容没变却在每次重渲时重解一遍:
  //   1MB 的 txt/md = 每次 render 造一个 1M 字符的字符串。
  //   Reader 会在窗口 resize / retry nonce / 主题切换等场合重渲 ⇒
  //   「拖着窗口边缘抖一下」就能把主线程塞满解码。
  //   memo 后只在 data 真的变了才重解。
  //
  //   ⚠ 位置铁律:这个 useMemo 必须在**所有 early return 之前** ——
  //   本组件后面有 `if (!file) return` / `state.kind==='loading' return` /
  //   error 分支 return 四个早退,hook 放在它们之后就是**条件调用 hook**
  //   ⇒ React 抛「Rendered more hooks than during the previous render」。
  //   (实测踩过:本轮第一版就踩了。)
  //
  //   readyData 的判据 = 「state 已 ready **且** 这份 data 属于当前这个 file」
  //   (readerLoadedIdRef 在 effect 里 setState 之前写 ⇒ ready 帧必然匹配;
  //    切文件的那一帧 loadedId 还是旧 file ⇒ readyData=null ⇒ 不白解一遍
  //    旧文件)。旧实现在这一帧压根不解码,这里保持同样的「不多解」。
  const readyData =
    state.kind === 'ready' && readerLoadedIdRef.current === file?.id ? state.data : null;
  const text = useMemo(
    () => (needsFileData(ext) && readyData ? TEXT_DECODER.decode(readyData) : ''),
    [ext, readyData],
  );

  if (!file) return <ReaderEmpty />;

  // audit 2026-09-10:一帧 stale text 防御 —— state.ready 但 loadedId 不是当前
  //   file(切文件瞬间) → 走 ReaderLoading。MarkdownReader / CodeReader /
  //   PlainReader 拿到旧 source + 新 filename 会闪一帧旧内容。PDF/Image/
  //   Unsupported 不走 source text,走这条也不影响。
  if (state.kind === 'ready' && needsFileData(ext) && readerLoadedIdRef.current !== file.id) {
    return <ReaderLoading />;
  }

  if (state.kind === 'idle' || state.kind === 'loading') {
    return <ReaderLoading />;
  }

  if (state.kind === 'error') {
    // audit C3R80 (2026-08-22):6 处硬编码中文错误状态走 i18n key —
    // 跟 C3R75 toast.openFailed 同模式,UI 文案统一锁在 locales/,改文案/扩语言只动 JSON
    const { code, message, size, messageKey } = state.error;
    if (code === 'TOO_LARGE') {
      return (
        <ReaderError
          title={t('reader.errorTooLarge')}
          description={
            size
              ? t('reader.errorTooLargeDesc', {
                  size: (size / 1024 / 1024).toFixed(1),
                })
              : undefined
          }
          onOpenExternal={onOpenExternal}
        />
      );
    }
    if (code === 'NOT_FOUND') {
      return (
        <ReaderError
          title={t('reader.errorNotFound')}
          description={t('reader.errorNotFoundDesc')}
          onOpenExternal={onOpenExternal}
        />
      );
    }
    if (code === 'EACCES') {
      return <ReaderError title={t('reader.errorEacces')} onOpenExternal={onOpenExternal} />;
    }
    return (
      <ReaderError
        title={t('reader.errorGeneric')}
        description={messageKey ? t(messageKey) : message}
        onRetry={() => setRetryNonce((n) => n + 1)}
        onOpenExternal={onOpenExternal}
      />
    );
  }

  // ready:按扩展名分发到对应的 lazy 阅读器,统一包 Suspense 触发 chunk 加载。
  // fallback 用 ReaderLoading — 跟 loading / idle 状态视觉一致(用户感知的
  // "文件读取中"延展到"阅读器下载中")。
  // 仅对需要 buffer 的 reader 解码 — PDF/Image/Unsupported 的 state.data 是空
  // Uint8Array,decode() 是空字符串,直接传 '' 跳过无谓的 UTF-8 解码。
  // (text 的 useMemo 在**上面**、所有 early return 之前 —— 见那里的位置铁律。)
  let readerNode: React.ReactNode;
  // audit-r143:每个 variant 外套 ReaderChrome 共享文件名标题条。
  //   variant 内部的 aria-label={filename} 不动(等同 SR anchor),
  //   chrome 用 aria-hidden 避免 SR 重复念。
  const chrome = <ReaderChrome filename={file.filename} />;
  if (ext === '.pdf') {
    readerNode = (
      <>
        {chrome}
        <PDFReader
          absPath={file.absPath}
          filename={file.filename}
          onOpenExternal={onOpenExternal}
        />
      </>
    );
  } else if (IMAGE_EXTS.has(ext)) {
    readerNode = (
      <>
        {chrome}
        <ImageReader
          absPath={file.absPath}
          filename={file.filename}
          onOpenExternal={onOpenExternal}
        />
      </>
    );
  } else if (ext === '.md') {
    readerNode = (
      <>
        {chrome}
        <MarkdownReader
          source={text}
          filename={file.filename}
          onOpenExternal={onOpenExternal}
        />
      </>
    );
  } else if (CODE_EXTS.has(ext)) {
    readerNode = (
      <>
        {chrome}
        <CodeReader source={text} filename={file.filename} onOpenExternal={onOpenExternal} />
      </>
    );
  } else if (PLAIN_EXTS.has(ext)) {
    readerNode = (
      <>
        {chrome}
        <PlainReader text={text} filename={file.filename} />
      </>
    );
  } else {
    readerNode = (
      <>
        {chrome}
        <UnsupportedReader filename={file.filename} onOpenExternal={onOpenExternal} />
      </>
    );
  }
  return <Suspense fallback={<ReaderLoading />}>{readerNode}</Suspense>;
});
