// 图片阅读器：用 <img src="rkms://..."> 直读磁盘图片
// 复用 PDFReader 的 rkms:// URL 策略(rkms scheme 由主进程注册,
// net.fetch → Chromium file fetcher 实际读盘),不经过 IPC/Buffer/Blob
//
// 注:为什么不用 file:// —— Chromium 89 起 file:// 全部 opaque origin,
// <img> 在父窗非 file:// origin 下加载会被跨域拦截;rkms:// 是带
// standard + secure + corsEnabled 的 privileged scheme,行为类似 http,
// 不参与 file:// 跨域判断。详见 src/main/protocol.ts 与 src/shared/protocol.ts。
import {
  useMemo,
  useState,
  useCallback,
  useRef,
  useEffect,
  type SyntheticEvent,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fileUrlOf } from '../../utils/file-url';
import { ReaderError } from './ReaderError';

// audit 2026-09-08:从 export 改非 export —— 0 外部 caller,只本文件
//   ImageReader 引用。原本 export 是为"未来 caller 显式标 props 类型" 留。
interface ImageReaderProps {
  absPath: string;
  filename: string;
  onOpenExternal?: () => void;
}

// 缩放步进
const ZOOM_STEP = 0.25;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 5;

const ZOOM_BUTTON =
  'px-2 py-1 text-xs rounded-md border border-border-subtle bg-bg-surface text-fg-secondary hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-40 disabled:cursor-not-allowed transition-colors duration-120 active:scale-[0.97]';

export function ImageReader({ absPath, filename, onOpenExternal }: ImageReaderProps) {
  // audit C3R80 (2026-08-22):硬编码中文错误文案 → i18n key,跟 Reader.tsx C3R80 同模式
  // 2026-08-28:同样覆盖 "加载中…" → t('common.loading'),避免英文用户看到中文
  // audit round 15 (2026-09-15):i18n H2 — i18n 解构出来供 Intl.NumberFormat 用 language
  const { t, i18n } = useTranslation();
  const src = useMemo(() => fileUrlOf(absPath), [absPath]);
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState(true);
  // audit round 8 (2026-09-14):把 loading/error/naturalWidth 搬到 ImageDisplay
  //   子组件,用 key={src} 在 src 变时 reset。error 状态需要上抬以便父
  //   在加载失败时隐藏工具栏(避免「在系统应用打开」按钮出现两次 —— 一次在
  //   工具栏,一次在 ReaderError)。
  const [imageError, setImageError] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // 拖拽平移 —— 非 fit 模式下光标是 grab,得让它真的能拖
  const [panning, setPanning] = useState(false);
  const panOrigin = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  const onPanStart = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const el = containerRef.current;
      if (fit || !el || e.button !== 0) return;
      // 没有可滚动的余量就没什么可拖的
      if (el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight) return;
      panOrigin.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
      setPanning(true);
      el.setPointerCapture(e.pointerId);
    },
    [fit],
  );

  const onPanMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const el = containerRef.current;
    const origin = panOrigin.current;
    if (!el || !origin) return;
    el.scrollLeft = origin.left - (e.clientX - origin.x);
    el.scrollTop = origin.top - (e.clientY - origin.y);
  }, []);

  const onPanEnd = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!panOrigin.current) return;
    panOrigin.current = null;
    setPanning(false);
    containerRef.current?.releasePointerCapture(e.pointerId);
  }, []);

  // 适应宽度：计算图片宽度与容器宽度的比例
  const handleFit = useCallback(() => {
    setFit(true);
    setZoom(1);
  }, []);

  // 实际大小：1:1 原始像素 — 同时也是 Ctrl+0 的标准语义(图像浏览器通用约定)
  const handleActualSize = useCallback(() => {
    setFit(false);
    setZoom(1);
  }, []);

  // 放大
  const handleZoomIn = useCallback(() => {
    setFit(false);
    setZoom((z) => Math.min(z + ZOOM_STEP, ZOOM_MAX));
  }, []);

  // 缩小
  const handleZoomOut = useCallback(() => {
    setFit(false);
    setZoom((z) => Math.max(z - ZOOM_STEP, ZOOM_MIN));
  }, []);

  // Ctrl + 滚轮缩放
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setFit(false);
      setZoom((z) => {
        const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
        return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z + delta));
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // 全屏
  const handleFullscreen = useCallback(() => {
    containerRef.current?.requestFullscreen?.();
  }, []);

  // 键盘缩放 —— 与工具栏按钮对齐,不用鼠标也能操作
  // audit C3R9 (2026-08-22):Ctrl+0 改为调 handleActualSize 而不是 handleReset —
  // 图像浏览器通用约定(Photoshop / Preview / 各种图片查看器)Ctrl+0 都是 "实际大小",
  // 旧实现 handleReset 与 handleFit 重复(setFit(true); setZoom(1)),违反用户预期。
  // audit 2026-09-16 r18:F5 — 键盘平移(非 fit 模式下用箭头键滚动)。
  //   拖拽平移(grab/grabbing 光标 + Pointer 事件)只覆盖鼠标用户,SR 用户
  //   / 运动障碍用户没法移动图片。fit 时不需要(整图自适应容器,无溢出);
  //   仅在非 fit + 容器有溢出时生效,Ctrl/Cmd + 方向键仍是缩放等通用语义。
  const PAN_KEY_DELTA = 48; // 每次按键滚动像素数,约 3 行文字
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      // Ctrl/Cmd 修饰键归缩放分支
      if (e.ctrlKey || e.metaKey) {
        if (e.key === '=' || e.key === '+') {
          e.preventDefault();
          handleZoomIn();
        } else if (e.key === '-') {
          e.preventDefault();
          handleZoomOut();
        } else if (e.key === '0') {
          e.preventDefault();
          handleActualSize();
        }
        return;
      }
      // 纯方向键:非 fit 模式 + 容器有溢出才生效
      if (fit) return;
      const el = containerRef.current;
      if (!el) return;
      const hasOverflowX = el.scrollWidth > el.clientWidth;
      const hasOverflowY = el.scrollHeight > el.clientHeight;
      switch (e.key) {
        case 'ArrowLeft':
          if (hasOverflowX) {
            e.preventDefault();
            el.scrollLeft -= PAN_KEY_DELTA;
          }
          break;
        case 'ArrowRight':
          if (hasOverflowX) {
            e.preventDefault();
            el.scrollLeft += PAN_KEY_DELTA;
          }
          break;
        case 'ArrowUp':
          if (hasOverflowY) {
            e.preventDefault();
            el.scrollTop -= PAN_KEY_DELTA;
          }
          break;
        case 'ArrowDown':
          if (hasOverflowY) {
            e.preventDefault();
            el.scrollTop += PAN_KEY_DELTA;
          }
          break;
      }
    },
    [handleZoomIn, handleZoomOut, handleActualSize, fit],
  );

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-bg-surface" aria-label={filename}>
      {/* 工具栏 —— 加载失败时隐藏,避免和 ReaderError 的"在系统应用打开"按钮重复 */}
      {!imageError && (
        <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border-subtle bg-bg flex-shrink-0">
          <button
            type="button"
            onClick={handleZoomOut}
            disabled={zoom <= ZOOM_MIN}
            className={ZOOM_BUTTON}
            title={t('reader.zoomOut')}
            aria-label={t('reader.zoomOut')}
          >
            −
          </button>
          <span className="text-xs text-fg-secondary min-w-[4ch] text-center select-none">
            {/* audit round 15 (2026-09-15):i18n H2 — 之前硬编码 `${round(zoom*100)}%`
                加 LTR-embedded `%`,RTL locale 视觉错位。改 Intl.NumberFormat
                percent style,locale-aware 分隔符与符号位置,自动跟 dir 走。 */}
            {new Intl.NumberFormat(i18n.language, {
              style: 'percent',
              maximumFractionDigits: 0,
            }).format(zoom)}
          </span>
          <button
            type="button"
            onClick={handleZoomIn}
            disabled={zoom >= ZOOM_MAX}
            className={ZOOM_BUTTON}
            title={t('reader.zoomIn')}
            aria-label={t('reader.zoomIn')}
          >
            +
          </button>
          <div className="w-px h-4 mx-1 bg-border" />
          {/* 按钮文本用简短字面量(测试已固化,且 width 受限);
           语义走 i18n title / aria-label —— a11y 完整,i18n 仍生效 */}
          <button
            type="button"
            onClick={handleFit}
            className={ZOOM_BUTTON}
            title={t('reader.zoomFit')}
            aria-label={t('reader.zoomFit')}
          >
            {t('reader.imageZoomFitShort')}
          </button>
          <button
            type="button"
            onClick={handleActualSize}
            className={ZOOM_BUTTON}
            title={t('reader.zoomActual')}
            aria-label={t('reader.zoomActual')}
          >
            {t('reader.imageZoomActualShort')}
          </button>
          <div className="w-px h-4 mx-1 bg-border" />
          <button
            type="button"
            onClick={handleFullscreen}
            className={ZOOM_BUTTON}
            title={t('reader.zoomFullscreen')}
            aria-label={t('reader.zoomFullscreen')}
          >
            {t('reader.imageZoomFullscreenShort')}
          </button>
          <div className="flex-1" />
          {onOpenExternal && (
            <button
              type="button"
              onClick={onOpenExternal}
              aria-label={t('reader.openExternal')}
              className="px-2 py-1 text-xs rounded-md border border-border-subtle bg-bg-surface text-fg-secondary hover:bg-bg-hover active:scale-[0.97] transition-colors duration-120"
            >
              {t('reader.openExternal')}
            </button>
          )}
        </div>
      )}

      {/* 图片容器 */}
      <div
        ref={containerRef}
        tabIndex={0}
        role="group"
        // audit round 14 (2026-09-15):A11Y-003 — 之前外层 div aria-label={filename},
        //   内层 role="group" aria-label={imageShortcutHint} — AT 在 focus 落到
        //   group 时只念 inner label,听不到 filename + 键盘提示的复合信息。
        //   改 inner 为 aria-describedby 引用 hint ID(描述关系不替换 name);
        //   外层 filename 仍是 accessible name,inner 提示作为描述附加。
        aria-describedby="image-reader-hint"
        className="flex-1 overflow-auto flex items-start justify-center relative focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent focus-visible:ring-inset"
        style={{ cursor: fit ? 'default' : panning ? 'grabbing' : 'grab' }}
        onKeyDown={onKeyDown}
        onPointerDown={onPanStart}
        onPointerMove={onPanMove}
        onPointerUp={onPanEnd}
        onPointerCancel={onPanEnd}
      >
        {/* audit round 8 (2026-09-14):用 key prop reset ImageDisplay 子组件
            —— 之前 render 阶段 setLoading/setError/setNaturalWidth 派生
            state 来"同步"重置加载态,React 文档允许但语义隐式。
            改成:把 loading/error/naturalWidth 状态搬到 <ImageDisplay> 子组件,
            父用 key={src} 让 src 变时 React 自动 unmount + 重新 mount,子组件
            初始 useState(true) / useState(false) / useState(null) 跑一遍,
            不用手写 setState。父组件保留 zoom/fit/pan —— 它们不应因 src 变而
            重置(用户缩放状态被保留)。
            onErrorStateChange 上抬 error 状态:加载失败时父把工具栏隐掉,
            避免 ReaderError 的"在系统应用打开"按钮和工具栏按钮重复。 */}
        <ImageDisplay
          key={src}
          src={src}
          filename={filename}
          zoom={zoom}
          fit={fit}
          onErrorExternal={onOpenExternal}
          onErrorStateChange={setImageError}
        />
        {/* audit round 14 (2026-09-15):A11Y-003 — 屏幕阅读器读出的
            键盘提示(outer div 的 aria-describedby 引用此 ID)。sr-only
            类把元素视觉隐藏但保留 AT 读出。 */}
        <span id="image-reader-hint" className="sr-only">
          {t('reader.imageShortcutHint', { filename })}
        </span>
      </div>
    </div>
  );
}

// 图片加载 + 错误渲染子组件 —— 状态独立于 zoom/fit,父用 key={src}
// reset。src 变 → React unmount + 重 mount → loading/error/naturalWidth
// 全部回到初始态,无 render-phase setState。
interface ImageDisplayProps {
  src: string;
  filename: string;
  zoom: number;
  fit: boolean;
  onErrorExternal?: () => void;
  // audit round 8 (2026-09-14):error 上抬 —— 加载失败时让父把工具栏
  //   隐掉,避免"在系统应用打开"按钮重复。
  onErrorStateChange?: (err: boolean) => void;
}

function ImageDisplay({
  src,
  filename,
  zoom,
  fit,
  onErrorExternal,
  onErrorStateChange,
}: ImageDisplayProps) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [naturalWidth, setNaturalWidth] = useState<number | null>(null);

  // 加载失败 —— 比对 currentTarget.src 与当前 src,旧图晚到的 onerror 直接吞掉,
  // 否则会把新图的 loading 误标 false(配套 handleLoad 守卫)。
  const handleError = useCallback(
    (e: SyntheticEvent<HTMLImageElement>) => {
      if (e.currentTarget.src !== src) return;
      setError(true);
      setLoading(false);
      onErrorStateChange?.(true);
    },
    [src, onErrorStateChange],
  );

  // 加载成功 —— 同样比对 src,旧图晚到的 onload 不能覆盖新图的 loading=true。
  const handleLoad = useCallback(
    (e: SyntheticEvent<HTMLImageElement>) => {
      if (e.currentTarget.src !== src) return;
      setNaturalWidth(e.currentTarget.naturalWidth || null);
      setLoading(false);
      setError(false);
      onErrorStateChange?.(false);
    },
    [src, onErrorStateChange],
  );

  if (error) {
    return (
      <ReaderError
        title={t('reader.errorImageTitle')}
        description={t('reader.errorImageDesc', { filename })}
        onOpenExternal={onErrorExternal}
      />
    );
  }

  return (
    <>
      {loading && (
        <div
          className="absolute inset-0 flex items-center justify-center text-fg-tertiary gap-2 text-sm"
          aria-busy="true"
        >
          <Loader2 size={14} className="animate-spin text-accent" aria-hidden="true" />
          {t('common.loading')}…
        </div>
      )}
      <img
        src={src}
        // audit 2026-09-07:strip 扩展名给 alt —— 原始文件名 "paper1.pdf"
        //   被屏幕阅读器读出来带扩展名无意义;扩展名由 type/role 推断更友好。
        // audit round 17 (2026-09-15):A11Y-L2 — 防御空 alt —— strip 后如果
        //   filename 是 "image.png" 或纯 ".png" 等边缘情况,trim 后空字符串会让
        //   SR 读「image」(空白),违反 WCAG 1.1.1(非装饰 img 必须有可读 alt)。
        //   这里 trim 后空 → 降级为空 alt(装饰图);非空 → 用 stripped filename。
        alt={(() => {
          const stripped = filename.replace(/\.[^.]+$/, '').trim();
          return stripped ? stripped : '';
        })()}
        onLoad={handleLoad}
        onError={handleError}
        className="block"
        draggable={false}
        style={{
          maxWidth: fit ? '100%' : undefined,
          maxHeight: fit ? '100%' : undefined,
          // 缩放走布局宽度而不是 transform:transform 不参与布局,
          // 放大后容器不会产生滚动区域,图片边缘就再也够不着了。
          width: fit ? 'auto' : naturalWidth ? `${naturalWidth * zoom}px` : 'auto',
          height: 'auto',
          visibility: loading ? 'hidden' : 'visible',
        }}
      />
    </>
  );
}
