// PDF 阅读器：直接用 <iframe src="rkms://..."> 让 Chromium PDFium 渲染磁盘 PDF。
//
// 前两版都失败：
//   1. pdf.js v4 + Vite worker：worker 路径在 Electron file:// 渲染下踩坑
//   2. blob URL + URL.createObjectURL：Buffer 经 Electron IPC 序列化后，
//      Uint8Array 重建不可靠，PDFium 收到损坏字节，显示 "未能加载 PDF 文档"
//
// 这一版彻底跳过 IPC。用传入行的 absPath 拼 rkms:// URL 给 iframe
// (audit-r124 注:原文写「LibraryFile 上已经存在的 absPath」—— 该类型 r56 库
//  退役时已删,现入参就是 absPath/filename/onOpenExternal 三个 prop):
//   - 不读 Buffer、不建 Blob、不 revokeObjectURL
//   - PDF 在磁盘上，iframe 直接 stream 读
//   - rkms:// 是主进程注册的 privileged scheme(standard + secure +
//     supportFetchAPI + corsEnabled + stream),iframe/img/fetch 都像 http
//     一样走,绕过 Chromium 89+ 把 file:// 当 opaque origin 拦截跨父窗
//     origin 的问题。Handler 内部 net.fetch(pathToFileURL) 由 Chromium
//     内置 file fetcher 实际读盘 —— 跟直接 file:// 等价但不会卡。
//   - Windows / POSIX 路径都处理了，盘符 'D:' 不参与 encode
//   - 路径里的空格 / 中文 / '#' / '?' 等字符必须 percent-encode,
//     否则 '#' 被当作 fragment 分隔符,空格在某些 parser 里截断 URL
//   - 不加 sandbox 属性:之前用过 sandbox="" 想收紧安全,但空 sandbox 把 iframe
//     强制成 opaque origin,Chromium PDFium 在某些版本下不接管渲染 → 显示空白。
//     rkms:// handler 只把请求翻成本地 file fetcher,PDF 文件本身不可执行
//     JS,无远程攻击面,不需要 sandbox。
//
// ── r199:拖拽面板时 PDF 区域「卡」 ⇒ iframe 尺寸冻结 ──────────────────────
// 现象:打开 PDF 后拖分隔条改宽度,每拖一帧都卡(实测 60fps 掉到 ~30fps),
//   缩小 PDF 区域时最明显。
// 根因:iframe 原本写 `w-full h-full` —— 容器宽高每帧变 ⇒ Chromium 的 PDF
//   渲染器每帧都要重排 + 重新光栅化可见页面。实测(Chromium,本地 http 起的
//   多页 PDF):
//     不动                        → 16.3ms/帧(60fps 满帧)
//     改普通 HTML iframe 尺寸     → 16.4ms/帧(免费)
//     改 **PDF** iframe 尺寸       → 32.8ms/帧(掉到 ~30fps)
//     改容器尺寸但 **冻结** iframe 尺寸 → 16.4ms/帧(免费)
//   即「iframe 尺寸每帧变」本身就是那 ~16ms/帧的来源 —— 面板边缘只需要
//   跟手,PDF 页面**不需要**每帧重排。
// 修:iframe 尺寸改为**显式像素**,只在下列时刻更新:
//   1. 首次挂载;
//   2. 容器尺寸「落定」(连续 SETTLE_MS 没再变)—— 覆盖窗口缩放等非拖拽场景;
//   3. 面板拖拽**结束**的那一刻 —— 一次跟上最终尺寸。
//   拖拽进行中尺寸保持不变 ⇒ PDF 不重排 ⇒ 拖拽全程满帧。
//   冻结期间 iframe 按「居中 + 溢出裁剪」呈现(容器 overflow-hidden):
//   看到的是 PDF 页面中间那条,而不是左边一条 —— 缩小时不至于看到半张空白。
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { fileUrlOf } from '../../utils/file-url';
import { isResizeDragActive, subscribeResizeDrag } from '../../lib/resize-drag-registry';

// 尺寸「落定」判定窗口(ms):容器尺寸变化后,这么久没再变才认为落定。
// 取 150ms —— 短到用户感知不到(松手后 PDF 立刻跟上),长到拖拽期间
// (mousemove 每帧都改尺寸)不会误判成落定。
const SETTLE_MS = 150;

// audit 2026-09-08:从 export 改非 export —— 0 外部 caller,只本文件
//   PDFReader 引用。
interface PDFReaderProps {
  absPath: string;
  filename: string;
  onOpenExternal?: () => void;
}

interface FrameSize {
  w: number;
  h: number;
}

export function PDFReader({ absPath, filename, onOpenExternal }: PDFReaderProps) {
  // i18n:与 ImageReader 共用 reader.openExternal key,英文用户也能看到正确文案
  const { t } = useTranslation();
  // src 只在 absPath 变化时重算
  const src = useMemo(() => fileUrlOf(absPath), [absPath]);
  // r199:当前是否有面板分隔条正在被拖拽。全局登记簿(任意面板)—— 拖左栏
  //   列表时 PDF 区域宽度同样在变,只认「文献列自己在拖」会漏掉这一半。
  const dragActive = useSyncExternalStore(
    subscribeResizeDrag,
    isResizeDragActive,
    isResizeDragActive,
  );
  const wrapRef = useRef<HTMLDivElement>(null);
  // iframe 的显式像素尺寸;null = 还没量过(首帧用 100% 撑满)。
  const [size, setSize] = useState<FrameSize | null>(null);

  // 量容器当前尺寸并写进 state。容器尺寸为 0(未布局 / 不可见)时**不写** ——
  //   免得把 iframe 缩成 0×0(Chromium PDF 渲染器遇到 0 尺寸会走异常分支)。
  const measure = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const w = Math.round(rect.width);
    const h = Math.round(rect.height);
    if (w <= 0 || h <= 0) return;
    setSize((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
  }, []);

  // 容器尺寸变化 → 落定后更新 iframe 尺寸。
  //   拖拽中直接 return(冻结);非拖拽场景(窗口缩放)等 SETTLE_MS 落定。
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let timer: number | undefined;
    const ro = new ResizeObserver(() => {
      if (isResizeDragActive()) return;
      if (timer !== undefined) clearTimeout(timer);
      // audit 2026-10-21 (r252):落定定时器**到点时再查一次**拖拽状态。
      //   旧实现只在 ro 回调那一刻查 —— 可这 150ms(SETTLE_MS)窗口里用户
      //   可能**开始**了拖拽(例:窗口缩放落定前用户去拖分隔条)⇒ 排好的
      //   定时器照样到点执行 measure() ⇒ 在拖拽**中途**改 iframe 尺寸 ⇒
      //   Chromium 重排 + 重新光栅化 PDF(实测每帧 +16ms)⇒ 拖拽第一帧掉帧。
      //   拖拽结束后另有「dragActive 变 false → 立刻跟上最终尺寸」那条
      //   路径兜底 ⇒ 这里跳过不会丢更新。
      timer = window.setTimeout(() => {
        if (isResizeDragActive()) return;
        measure();
      }, SETTLE_MS);
    });
    ro.observe(el);
    measure();
    return () => {
      ro.disconnect();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [measure]);

  // 拖拽结束 → 立刻跟上最终尺寸(只重排一次)。挂载时也跑一次(幂等)。
  useEffect(() => {
    if (dragActive) return;
    measure();
  }, [dragActive, measure]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-bg-surface" aria-label={filename}>
      {/* 尺寸观察层:跟着面板走,自己不吃宽度 —— iframe 在里面绝对定位,
          尺寸由 size 显式给定(拖拽期间冻结)。 */}
      <div ref={wrapRef} className="relative flex-1 min-h-0 overflow-hidden">
        <iframe
          // #navpanes=0 关闭 Chromium PDFium 的左侧缩略图导航面板(默认约 200px,
          // 在窄面板里显得过宽)。工具栏里的页码输入框仍可用,跳页不受影响。
          src={`${src}#navpanes=0`}
          title={filename}
          className="absolute border-0"
          style={{
            // 居中:冻结期间容器可能比 iframe 窄,居中后露出的是 PDF 页面
            // 中间那条(而不是被切掉右半边的页面)。
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            width: size ? `${size.w}px` : '100%',
            height: size ? `${size.h}px` : '100%',
          }}
        />
      </div>
      <div className="px-4 py-2 border-t border-border-subtle bg-bg flex justify-end gap-2">
        <button
          type="button"
          onClick={onOpenExternal}
          aria-label={t('reader.openExternal')}
          className="px-3 py-1.5 text-sm rounded-md border border-border-subtle bg-bg-surface text-fg-secondary hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent active:scale-[0.97] transition-colors duration-120"
        >
          {t('reader.openExternal')}
        </button>
      </div>
    </div>
  );
}
