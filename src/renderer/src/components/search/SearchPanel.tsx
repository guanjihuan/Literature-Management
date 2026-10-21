// src/renderer/src/components/search/SearchPanel.tsx
//
// audit v2.0 Phase 3a (2026-09-17):全局搜索面板 —— ⌘⇧F 入口,横跨
//   notes(标题 / body)与 library(文件名 / 内容)的 SQLite FTS5 检索。
//
// 设计要点:
//   - **Modal-like overlay**:走 Overlay 原语拿 Portal / 滚动锁 / 焦点陷阱
//   - **300ms debounce**:输入即触发,但 IPC 走 trailing-edge,避免每按一键
//     打一次 SQLite(FTS5 30ms 量级,5000 文件库下打满 IPC 也吃不消)
//   - **分组渲染**:notes + library 各一组;点击 notes 项 → select +
//     requestFocusNote;点击 library 项 → select + setActive('library')
//   - **空态 3 件套**:query 为空(引导输入)/ 无结果(no hits)/ IPC 失败(错误 toast)
//
// 关键不变式:
//   - 渲染行(sections)== 键盘可达集(flatHits):sections 数据由 flatHits
//     派生(audit-r77),不依赖主进程 limit 数值与 MAX_VISIBLE_RESULTS 相等
//   - panel 内部不持有 IPC 缓存,每次 query 都是新 invoke,主进程 SQLite
//     是真权威源
//   - open/close 由 useUiModals.searchOpen 单点控制,键盘 shortcut 与
//     工具按钮(暂无)统一调 setSearchOpen
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search as SearchIcon, FileText, NotebookPen, X, RefreshCw } from 'lucide-react';
import type { IpcResult, SearchHit } from '@shared/types';
import { Overlay } from '../ui/Overlay';
import { CloseButton } from '../ui/Kbd';
// r194:高亮片段渲染(切分 <mark> 标记 → React 元素,不用 dangerouslySetInnerHTML)
import { SearchSnippet } from './SearchSnippet';
import { useNotesStore } from '../../store/notes';
// audit-r71:file 命中接回文献列表(store + id 重建)
import { useLiteratureStore } from '../../store/literature';
import { litResourceId } from '@shared/resource-id';
import { useWorkspaceStore } from '../../store/workspace';
import { formatShortcut } from '../../lib/shortcut';
import { clsx } from '../../lib/clsx';
import { useToast } from '../../lib/toast';
import { useLatestValue } from '../../hooks/useLatestValue';
import { t as translate } from 'i18next';
// audit r29 (2026-09-21):silent H6 — 捕获 err + log + 把 errMsg 注入 toast。
import { errMsg } from '../../lib/error';
import { createLogger } from '../../lib/logger-client';

const log = createLogger('search-panel');

const SEARCH_DEBOUNCE_MS = 300;
const MAX_VISIBLE_RESULTS = 50;

interface SearchPanelProps {
  open: boolean;
  onClose: () => void;
}

export function SearchPanel({ open, onClose }: SearchPanelProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  // IPC 节流:每次 query 变化 → 300ms debounce → invoke search.query。
  // trailing-edge:用户停下打字后只发一次,避免每键打 SQLite。
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [results, setResults] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  // audit r33 (2026-09-23):a11y —— 追踪「最近一次成功 resolve 的 query」,让
  //   listbox 在 `loading && currentQuery !== lastResolvedQuery` 时打 `aria-busy`。
  //   老实现 loading 用 sibling `aria-live` 提示但只在 `loading && results.length === 0`
  //   时显示;结果已经存在但用户继续打字 → IPC pending 期间 listbox 显示 stale,
  //   SR 用户无指示。`aria-busy` 直接挂在 listbox div 上,SR 跟随活跃 region 状态。
  const [lastResolvedQuery, setLastResolvedQuery] = useState('');
  const [activeIdx, setActiveIdx] = useState(0);
  const toast = useToast((s) => s.show);
  // audit r30 (2026-09-22):perf M1 — 之前 useEffect deps 含 t + toast,语言切换
  //   或 toast store 重建都会让 effect 重跑,触发同 debouncedQuery 的 IPC 复读。
  //   套 useLatestValue(沿用 r23 收敛 GC 模式)让 effect 只跟 debouncedQuery 走,
  //   内部消费 ref.current 永远是最新的 t / toast。
  const tRef = useLatestValue(t);
  const toastRef = useLatestValue(toast);

  // === debounce query ===
  useEffect(() => {
    if (!query.trim()) {
      setDebouncedQuery('');
      return;
    }
    const id = setTimeout(() => setDebouncedQuery(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query]);

  // === invoke search when debouncedQuery changes ===
  useEffect(() => {
    if (!debouncedQuery) {
      setResults([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void window.api
      .search(debouncedQuery)
      .then((r: IpcResult<SearchHit[]>) => {
        if (cancelled) return;
        if (r.ok) {
          setResults(r.data);
          // 标记本次 query 已成功 resolve —— listbox 在 `loading && query !== lastResolved`
          // 时打 aria-busy;r33 之前 listbox 没这个属性,sibling `aria-live` 只在
          // results.length===0 时显示,导致 stale 但非空态完全无声。
          setLastResolvedQuery(debouncedQuery);
        } else {
          toastRef.current({ type: 'error', message: tRef.current('search.toastFailed') });
          setResults([]);
        }
      })
      .catch((err: unknown) => {
        // audit r29 (2026-09-21):原 no-parameter arrow 吞掉 err —— IPC 桥断开 /
        //   handler throw 时只 toast 一句通用文案,用户看不到 renderer trace。
        //   与 App.tsx:237-240 + notes.ts:401 对齐,捕获 err + log + 把 errMsg 注入 toast。
        if (cancelled) return;
        log.warn('search IPC rejected', errMsg(err));
        toastRef.current({
          type: 'error',
          message: `${tRef.current('search.toastFailed')}: ${errMsg(err)}`,
        });
        setResults([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, tRef, toastRef]);

  // === 分组 + flat list 派生 ===
  const noteHits = useMemo(() => results.filter((h) => h.kind === 'note'), [results]);
  const fileHits = useMemo(() => results.filter((h) => h.kind === 'file'), [results]);
  const flatHits = useMemo(
    () => [...noteHits, ...fileHits].slice(0, MAX_VISIBLE_RESULTS),
    [noteHits, fileHits],
  );
  // audit-r77 (2026-10-17):sections 渲染集必须 == flatHits 可达集。旧实现把
  // **未 slice** 的 noteHits/fileHits 直接传给 SearchResultSections,当下靠 main
  // 侧 limit:50 兜底恰好相等;main limit 一旦调大就出现「鼠标能点、ArrowDown
  // 永远到不了」的行(flatHits.length clamp)+ section 头 count 虚报。
  // 由 flatHits 按 kind 过滤派生 —— 顺序天然保持 notes-first 拼接序,
  // section 内索引 → activeIdx 的偏移(isFileActive 用 noteHits.length)也随之
  // 对上(renderedNotes == flatHits 里的 notes 数)。行为锁见
  // tests/unit/renderer/components/search/search-panel-slice-consistency.test.tsx ——
  // 本轮补齐 5 例(渲染行数被截到上限 / section count 不虚报 /
  //  键盘可达集 == 渲染集 / activedescendant 不悬空 / 不足上限时不误截断)。
  const sectionNoteHits = useMemo(() => flatHits.filter((h) => h.kind === 'note'), [flatHits]);
  const sectionFileHits = useMemo(() => flatHits.filter((h) => h.kind === 'file'), [flatHits]);
  // active 索引越界保护 —— results 变化时(如新 query 命中更少)若 active 越界则重置
  useEffect(() => {
    if (activeIdx >= flatHits.length) setActiveIdx(0);
  }, [flatHits.length, activeIdx]);

  // === 关闭时 reset 状态,下次打开是干净面板 ===
  // audit-r137:删 `setTimeout focus` —— Overlay 已通过 initialFocusRef={inputRef}
  //   接管焦点(Overlay.tsx:131 的 setTimeout focus),本 effect 又重复一次,
  //   React 顺序不保证谁先 commit,IME/屏幕阅读器首字可能落空。
  //   reset 逻辑保留(open=false 时清状态)。
  // audit-r139:setLastResolvedQuery('') 必清 —— listbox aria-busy 谓词
  //   `loading && debouncedQuery !== lastResolvedQuery` 在 r33 设计下依
  //   赖 lastResolvedQuery 反映「最近一次成功 resolve 的 query」。reopen
  //   输**同** query 时(用户常复搜、点选后再次定位),若 lastResolvedQuery
  //   残留旧值,debouncedQuery === lastResolvedQuery,谓词恒 false → listbox
  //   在 IPC pending 期间 aria-busy=false,SR 完全感知不到 listbox 正在
  //   刷新,与 r33 引入 aria-busy 的 a11y 意图直接冲突。同 session 内 IPC
  //   完成会自动 setLastResolvedQuery(debouncedQuery)(line 104),无须
  //   在此重置;此处只清「跨 session 残留」。
  // setLoading(false) 不用显式清 —— debouncedQuery → '' 触发 effect at 87
  // 重跑,新 effect 早返分支 (line 90) 已经 setLoading(false),覆盖本场景
  // (mid-flight close:debouncedQuery 由 'abc' → '',触发新 effect;
  //  pre-debounce close:debouncedQuery 本就 '',无在飞 IPC,loading 初值 false)。
  useEffect(() => {
    if (!open) {
      setQuery('');
      setDebouncedQuery('');
      setResults([]);
      setActiveIdx(0);
      setLastResolvedQuery('');
    }
  }, [open]);

  // === 选中命中项 ===
  const handleSelectHit = useCallback(
    (hit: SearchHit) => {
      const notes = useNotesStore.getState();
      const ws = useWorkspaceStore.getState();
      if (hit.kind === 'note') {
        ws.setActive('notes');
        notes.select(hit.id);
        ws.requestFocusNote(hit.id);
      } else {
        // audit-r71 (2026-10-17):文献功能重建 —— file 命中接回文献列表。
        //   重建源用 **hit.id**(search.ts:20 —— 裸 DB id,剥 'lit:' 前缀):
        //   新行 = absPath 斜杠形、0005 迁移行 = 库文件名,与 store items 的
        //   key(同源 DB id)两代体系都恒等。不能用 hit.relPath ——
        //   search.ts:23 对 file 命中的 relPath 字段填的是 DB abs_path
        //   (win32 反斜杠 / 迁移行双重路径),与 id 后缀不等价。
        //   items 未 load 时右侧先闪 LibraryEmptyState,列表加载完成后
        //   自动出 Reader(已接受风险 #4)。
        useLiteratureStore.getState().select(litResourceId(hit.id));
        ws.setActive('library');
      }
      onClose();
    },
    [onClose],
  );

  // === 键盘导航:Up/Down/Enter ===
  // audit r33 (2026-09-23):HIGH — 旧 r32 split-callback 设计(<input> 上挂
  //   `handleInputKeyDown`,里面 `listboxRef.current?.focus()` 把焦点移到
  //   `<div role="listbox" tabIndex=-1>`,再让 listbox 上的另一份 handler 接管)
  //   看似遵循 a11y 模式,实际违反 WAI-ARIA combobox 规范:焦点应始终留在
  //   input,让 aria-activedescendant 跟踪 active 项。 副作用是用户打完 "react"
  //   按 ↓ 后再打字 "hooks" 时,字符无法进入 input —— div 不接受文字输入,
  //   用户体验断流。
  // 修法:合并成单一 `handleKeyDown` 挂在 input 上,Enter + Arrow + Escape
  // 全部就地处理,焦点全程不挪,listbox div 不再挂 onKeyDown。aria-activedescendant
  // 跟着焦点走 —— 移到 input(aria-controls="search-listbox" 标 listbox),
  // 用户→SR 链路恢复。r32 的 split-callback 测试同步重写到单一契约
  // (见 tests/unit/renderer/components/search/SearchPanel.test.tsx —— 本轮补齐 8 例:r33 修订)。
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // audit-r80 (2026-10-17) HIGH:IME composition 中按 Enter 是想上屏
      //   关键词,不是打开命中项 —— 无守卫会直接 handleSelectHit 跳转并
      //   关面板(误导航),关键词还停在 stale 状态。ArrowUp/Down 同理
      //   放行:候选窗内它们是选候选,不是移动 listbox active。
      if (e.nativeEvent.isComposing) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => Math.min(i + 1, flatHits.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter' && flatHits[activeIdx]) {
        e.preventDefault();
        handleSelectHit(flatHits[activeIdx]);
      }
    },
    [flatHits, activeIdx, handleSelectHit],
  );

  if (!open) return null;

  return (
    // audit-r124:命令面板遮罩降透(黑 40%)要压过 Overlay 根的默认
    //   bg-overlay-scrim/65 —— Tailwind 产物里自定义色 token 排在不透明
    //   核心色之后(实证 index-*.css 字节位 scrim>black),同特异性后者赢,
    //   无 `!` 前缀时本覆盖从 v2.0-phase-3a 写下起静默失效(面板一直用默认
    //   遮罩)。important 前缀让覆盖确定性生效;哨兵锁见
    //   overlay-scrim-override.test.tsx。
    <Overlay open={open} onClose={onClose} initialFocusRef={inputRef} className="!bg-black/40">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-bg-surface border border-border-subtle rounded-md shadow-modal w-full max-w-2xl mx-4 max-h-panel flex flex-col animate-in zoom-in-95 duration-150 overflow-hidden"
      >
        <h2 id={titleId} className="sr-only">
          {t('search.title')}
        </h2>
        {/* 输入区:search icon + input + clear + close */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border-subtle bg-bg-raised">
          <SearchIcon size={14} aria-hidden="true" className="text-fg-tertiary flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('search.placeholder')}
            aria-label={t('search.inputAria')}
            // audit r33 (2026-09-23):combobox a11y —— `role=combobox` +
            //   `aria-controls=search-listbox` 标 listbox,`aria-activedescendant`
            //   跟踪 active option。焦点全程留在 input,SR 通过 aria-activedescendant
            //   知道虚拟选中的 option。`aria-autocomplete=list` 让 SR 宣告"list"。
            role="combobox"
            aria-autocomplete="list"
            aria-controls="search-listbox"
            aria-expanded={flatHits.length > 0}
            aria-activedescendant={
              flatHits[activeIdx] ? `search-hit-${flatHits[activeIdx].id}` : undefined
            }
            className="flex-1 bg-transparent text-sm text-fg placeholder:text-fg-tertiary outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label={t('search.clearAria')}
              // audit-r143 (2026-10-19) MED:清空按钮触摸目标从 28px 提到 44px
              //   (WCAG 2.5.5 Target Size Level AAA)。视觉图标仍 12px 居中,
              //   padding 撑开至 44px,鼠标/触屏/键盘都更友好。
              className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded text-fg-tertiary hover:text-fg hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              <X size={12} aria-hidden="true" />
            </button>
          )}
          {/* audit-r143 MED:CloseButton 24px 也提到 44px;这里走 className
              透传不影响其他调用方(Modal / Drawer 的 24px 仍可保留 ——
              它们标题区高度固定,改全局会引视觉跳变,本面板按需 override)。 */}
          <CloseButton
            onClose={onClose}
            ariaLabel={t('common.close')}
            className="min-w-[44px] min-h-[44px]"
          />
        </div>

        {/* audit r52 (2026-10-16):loading 视觉反馈 —— 旧实现仅在 results.length === 0
            时(listbox 空态)展示「正在搜索…」,用户连续打字时(results 还显示上一轮
            命中,loading=true 新一轮 IPC 还在飞)没有任何视觉信号,只能看到旧结果
            短暂停留等新结果覆盖,体感「卡」。补一处 thin inline 状态条挂在
            listbox 上方,只要 loading=true 就显示 —— listbox 自带 aria-busy 给 SR,
            这里只补视觉信号,不与 listbox 嵌套(放 listbox 里违反 WAI-ARIA 1.2
            「listbox 仅含 option」约定,故放在 listbox 外的 dialog 内、紧邻位置)。
            i18n 复用 search.loading(已存在),不加新 key。 */}
        {loading && (
          <div
            className="flex items-center gap-1.5 px-4 py-1 text-2xs text-fg-tertiary border-b border-border-subtle bg-bg-raised/50"
            role="status"
            aria-live="polite"
          >
            <RefreshCw size={11} className="animate-spin flex-shrink-0" aria-hidden="true" />
            <span>{t('search.loading')}</span>
          </div>
        )}

        {/* 结果区 */}
        <div
          className="flex-1 overflow-y-auto p-2"
          role="listbox"
          aria-label={t('search.resultsAria')}
          // audit r33 (2026-09-23):listbox div 不再挂 onKeyDown + 不再有
          //   tabIndex=-1 —— 焦点全程留在 input,焦点不挪 listbox。aria-activedescendant
          //   移到 input(r32 在 listbox 上的位置当前已经没意义 —— listbox 不持
          //   focus,SR 跟着 input 的 aria-activedescendant 走)。
          // audit r33:a11y-busy —— listbox 进入 debouncePending(loading=true 且当前 query
          //   还没 resolve)时打 aria-busy=true,SR 知道 listbox 还在等刷新。
          // aria-busy + sibling aria-live 共存:aria-busy 标 listbox 整体状态,aria-live
          // 标「第一次 loading 时还没有内容」的初次空态。
          // audit 2026-09-21 audit-r24:fixed id 让 input 的 aria-controls
          //   锚点稳定。
          id="search-listbox"
          aria-busy={loading && debouncedQuery !== lastResolvedQuery}
        >
          {!debouncedQuery ? (
            <div className="px-4 py-8 text-center text-2xs text-fg-tertiary">
              {t('search.emptyHint')}
            </div>
          ) : loading && results.length === 0 ? (
            <div className="px-4 py-8 text-center text-2xs text-fg-tertiary" aria-live="polite">
              {t('search.loading')}
            </div>
          ) : results.length === 0 ? (
            <div className="px-4 py-8 text-center text-2xs text-fg-tertiary" aria-live="polite">
              {t('search.noResults', { query: debouncedQuery })}
            </div>
          ) : (
            <SearchResultSections
              noteHits={sectionNoteHits}
              fileHits={sectionFileHits}
              activeIdx={activeIdx}
              onSelect={handleSelectHit}
            />
          )}
        </div>

        {/* Footer:快捷键提示 */}
        <div className="px-4 py-1.5 border-t border-border-subtle bg-bg-raised text-2xs text-fg-tertiary flex items-center justify-between">
          <span>{t('search.footerHint')}</span>
          <span className="tabular-nums">{formatShortcut('mod+shift+F')}</span>
        </div>
      </div>
    </Overlay>
  );
}

function SearchResultSections({
  noteHits,
  fileHits,
  activeIdx,
  onSelect,
}: {
  noteHits: SearchHit[];
  fileHits: SearchHit[];
  activeIdx: number;
  onSelect: (h: SearchHit) => void;
}) {
  // 索引映射:flat 顺序 = [notes..., files...],用于 activeIdx → 行
  const isNoteActive = (i: number) => activeIdx === i;
  const isFileActive = (i: number) => activeIdx === noteHits.length + i;
  return (
    <div className="space-y-1">
      {noteHits.length > 0 && (
        <div>
          <div className="px-2 py-1 text-2xs uppercase tracking-wider text-fg-tertiary">
            {translate('search.sectionNotes', { count: noteHits.length })}
          </div>
          {noteHits.map((hit, i) => (
            <SearchResultRow
              key={`note-${hit.id}`}
              hit={hit}
              active={isNoteActive(i)}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
      {fileHits.length > 0 && (
        <div>
          <div className="px-2 py-1 text-2xs uppercase tracking-wider text-fg-tertiary">
            {translate('search.sectionLibrary', { count: fileHits.length })}
          </div>
          {fileHits.map((hit, i) => (
            <SearchResultRow
              key={`file-${hit.id}`}
              hit={hit}
              active={isFileActive(i)}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SearchResultRow({
  hit,
  active,
  onSelect,
}: {
  hit: SearchHit;
  active: boolean;
  onSelect: (h: SearchHit) => void;
}) {
  const Icon = hit.kind === 'note' ? NotebookPen : FileText;
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      // audit 2026-09-21 audit-r24:id 锚点让 listbox aria-activedescendant
      //   指向的 DOM 节点稳定存在。
      id={`search-hit-${hit.id}`}
      onClick={() => onSelect(hit)}
      className={clsx(
        // audit-r143 (2026-10-19) MED:命中行触摸目标 32px → 44px
        //   (WCAG 2.5.5)。py-1.5(6px)+ text-2xs 行高 20 = 32px;改 min-h-[44px]
        //   撑开。视觉与现 list 紧凑感保持一致(行间留白仍 1px space-y-1),
        //   鼠标命中范围变大,触屏用户也能准确点中。
        'w-full min-h-[44px] flex items-start gap-2 px-2 py-1.5 rounded text-left text-2xs',
        active ? 'bg-accent/15 text-fg' : 'text-fg-secondary hover:bg-bg-hover',
      )}
    >
      <Icon size={11} aria-hidden="true" className="mt-0.5 flex-shrink-0 text-fg-tertiary" />
      <div className="flex-1 min-w-0">
        <div className="truncate font-medium">{hit.title ?? hit.relPath}</div>
        {/* r194:snippet 带 <mark> 高亮标记 —— 必须走 SearchSnippet 切分渲染,
            直接渲染 {hit.snippet} 会把标签字面量显示给用户(旧行为)。 */}
        <SearchSnippet snippet={hit.snippet} className="truncate text-fg-tertiary" />
      </div>
    </button>
  );
}
