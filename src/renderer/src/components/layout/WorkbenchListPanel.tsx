// 工作台左侧:文献 / 笔记 列表 Tab 切换(2026-09 V1.7;audit-r56 曾下线 Tabs,
// audit-r71 (2026-10-17) 恢复 —— 文献功能完整重建,列表走 literature: IPC 域)
//
// 形态:
//   ┌───────────────────────────────────────────────┐
//   │ [📚 文献] │ [📝 笔记]                          │  ← Tabs(复用 ui/Tabs,完整 ARIA)
//   ├───────────────────────────────────────────────┤
//   │                                               │
//   │ LiteratureList  或  NotesList                  │
//   │                                               │
//   └───────────────────────────────────────────────┘ ─ ┊ resize handle
//
// 设计:
//   - 唯一 source of truth = useWorkspaceStore.active(⌘1/⌘2 + 老 settings 兼容)。
//   - Tabs 切换调 setActive;命令面板 ⌘1/⌘2 也走同一条路径,免费复用 —— 这正是
//     r71 修「⌘1 白屏」的机制:两个面板恢复了 library 分支,active 不再落空。
//   - panel id `panel-${active}` + aria-labelledby `tab-${active}` 与 Tabs 按钮
//     配对(audit round 14 A11Y-004);r56 删 Tabs 后这里曾是写死的 'panel-notes'
//     悬空引用,本次一并治愈。
//   - 宽度由 useResizablePanel 管理,storageKey 见 layout/list-panel-width.ts
//     (r238 升版为 'workbench.listPanel.width.v3')。
//   - resize handle 渲染在 panel 右侧(side='left')—— 同一个 useResizablePanel 调用。
//   - r240:Tabs 行右侧加「恢复默认宽度」按钮(拖过分隔条后的一键回退;
//     双击分隔条也能复位,但那是隐藏手势,按钮是显式入口)。
//   - r242:整块可折叠 —— 标题栏左上角按钮 + ⌘B / Ctrl+B 切换。折叠时
//     本组件 return null(整个面板不进 DOM),主区自然占满整宽。
//   - Tabs 行用 `flex-shrink-0`,list body 走 `flex-1 min-h-0` —— LiteratureList /
//     NotesList 顶层 h-full 父容器必须能解析,否则下空滚动条带。
import { lazy, Suspense, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { BookOpen, Loader2, NotebookPen, RotateCcw } from 'lucide-react';
import { useWorkspaceStore } from '../../store/workspace';
import { useResizablePanel } from '../../hooks/useResizablePanel';
import { Tabs } from '../ui/Tabs';
import { VerticalResizeHandle } from './VerticalResizeHandle';
import * as listPanelWidth from './list-panel-width';
import { useToast } from '../../lib/toast';
import { createLogger } from '../../lib/logger-client';

// perf (2026-09-14,r71 沿用):两个 list 都 lazy —— 都依赖 react-virtuoso
//   (~30-40KB)+ lucide 图标 + drag/import handlers。同一时刻只挂一个(active
//   互斥),全部进首屏 chunk 是浪费;切 tab 时另一 chunk ~30-50ms 异步下载。
// audit-r71:LibraryList(r56 退役)由 LiteratureList 替代 —— 数据面换成
//   resources 表 lit 行 + literature: IPC 域,不再依赖 LibraryService。
const LiteratureList = lazy(() =>
  import('../literature/LiteratureList').then((m) => ({ default: m.LiteratureList })),
);
const NotesList = lazy(() => import('../notes/NotesList').then((m) => ({ default: m.NotesList })));

const log = createLogger('WorkbenchListPanel');

// audit 2026-09-07:tab id 联合类型校验 —— 之前 `id as 'library' | 'notes'` 强转
//   会让任意 string 通过。setActive 内部不再兜底,合法 id 落到 validIds 白名单,
//   非法 id 记 log + 保留当前 active 不切换(避免错误状态泄漏到下游分支)。
const VALID_TAB_IDS = ['library', 'notes'] as const;
type TabId = (typeof VALID_TAB_IDS)[number];

// audit-r175 (2026-10-19):默认宽度 320→240、最小宽度 300→200(用户报
//   「左侧栏最小宽度和默认宽度都偏大」),max=720 不动(保留「支持大范围手动
//   调节」的拖宽天花板)。与 r132 反向的那次调整不同 —— r132 靠「min 压在
//   旧默认之上」白嫖了一次存量迁移(min 调低后存量 280/320 仍落在新区间内,
//   会被当用户偏好原样保留,存量用户看不到新默认),本轮必须显式升版
//   storageKey 才能让新默认真正落地。max=720 与 hook 的 resize 重夹
//   (默认视口 60% 上限,1440 默认窗口 = 864)不冲突,主区不会被压死。
//   数值-机制耦合由 list-panel-width.ts + list-panel-width-policy.test.ts 锁住。
//
// audit-r238 (2026-10-21):默认宽度 240→280(用户报「左侧栏默认宽度可以稍微
//   宽一些」),min 200 / max 720 不动。同样必须升版 storageKey(v2→v3)——
//   默认值会在首次挂载时落盘,只改常量存量用户看不到变化。本轮比 r175 多做
//   一步:升版同时定向迁移 v2 里「用户真拖过」的宽度(等于旧默认 240 的那个
//   值视为自动落盘,不迁移),避免把用户手动设置也一起重置。
const {
  LIST_PANEL_MIN: PANEL_MIN,
  LIST_PANEL_MAX: PANEL_MAX,
  LIST_PANEL_DEFAULT: PANEL_DEFAULT,
  LIST_PANEL_WIDTH_KEY: PANEL_WIDTH_KEY,
  migrateLegacyListPanelWidth: MIGRATE_WIDTH_PREF,
} = listPanelWidth;

export function WorkbenchListPanel() {
  const { t } = useTranslation();
  const active = useWorkspaceStore((s) => s.active);
  const setActive = useWorkspaceStore((s) => s.setActive);
  // r242:折叠态。开关按钮在标题栏(常驻,折叠后也点得到)。
  const sidebarCollapsed = useWorkspaceStore((s) => s.sidebarCollapsed);

  // r238:迁移必须早于 useResizablePanel —— 它的 useState 初始化器只在挂载时
  //   读一次 localStorage,晚一步就来不及(读到的还是旧 key 的值)。
  //   放在渲染体里是刻意的(不是 useEffect):effect 跑在首次 commit 之后,
  //   而宽度 state 早已用旧值初始化。函数幂等(StrictMode 双调用无副作用)。
  MIGRATE_WIDTH_PREF();

  const panelApi = useResizablePanel({
    storageKey: PANEL_WIDTH_KEY,
    defaultWidth: PANEL_DEFAULT,
    min: PANEL_MIN,
    max: PANEL_MAX,
    side: 'left',
  });
  const { width, panelRef, onResizeReset } = panelApi;

  // r240:「恢复默认宽度」按钮 —— 用户拖过分隔条后想一键回到默认值。
  //   落盘走 hook 自己的 [width] effect(非拖拽态 ⇒ 会写 localStorage)⇒
  //   复位后的宽度**重启后依然生效**,不是一次性视觉回弹。
  //   toast 反馈:宽度本来就没变时(已在默认值)点按钮没有任何视觉变化,
  //   没有反馈会让人以为按钮坏了(同 toast.dataRestored 的用法惯例)。
  const toast = useToast((s) => s.show);
  const handleResetWidth = useCallback(() => {
    onResizeReset();
    toast({
      type: 'info',
      message: t('toast.listPanelWidthReset', { width: PANEL_DEFAULT }),
    });
  }, [onResizeReset, toast, t]);

  // audit-r124:ui/Tabs 的 memo(2026-09-04 perf 注)要求「调用方 useMemo
  //   tabs」才生效,但本文件是 Tabs 现存唯一 caller 且 tabs/onChange 全
  //   inline —— 拖宽分隔条每帧 setState,浅比较恒不等,memo 形同虚设
  //   (承诺从未生效家族)。tabDefs 依赖 [t] 仅切语言重建;handleTabChange
  //   依赖 store 恒稳定的 setActive。行为锁见 tabs-keyboard-nav.test.tsx。
  const tabDefs = useMemo(
    () => [
      { id: 'library', label: t('workbench.tabLibrary'), icon: <BookOpen size={12} aria-hidden="true" /> },
      { id: 'notes', label: t('workbench.tabNotes'), icon: <NotebookPen size={12} aria-hidden="true" /> },
    ],
    [t],
  );
  const handleTabChange = useCallback(
    (id: string) => {
      if ((VALID_TAB_IDS as readonly string[]).includes(id)) {
        setActive(id as TabId);
      } else {
        // audit 2026-09-07:runtime 校验 —— Tabs.onChange 是 `(id: string) => void`,
        //   强转前用白名单兜底。非法 id 走 log + 保留 active 不切换,让下游
        //   active 分支永远拿到合法状态。
        log.warn('Tabs.onChange: unknown tab id, ignored', { id });
      }
    },
    [setActive],
  );

  // r242:折叠 ⇒ 整个面板**不进 DOM**(返回 null)。
  //   为什么不是「宽度设成 0」:宽度 0 的 section 仍占着一个分隔条 +
  //   边框,主区左边会留一条永久死白条(r237 的 scrollbar-gutter 同款
  //   教训 —— 本 app 文档流不滚动,任何「预留空间」都看得见)。
  //   整个不渲染 ⇒ 主区(WorkbenchContentPanel,flex-1)自然占满整宽。
  //   放在**所有 hook 之后**:提前 return 不能少调 hook,否则折叠/展开
  //   来回切会打乱 hook 顺序(Rules of Hooks)。
  if (sidebarCollapsed) return null;

  return (
    <>
      {/* === 列表面板 ===
          audit round 17 (2026-09-15):A11Y-M8 — 包 <section aria-labelledby=
          "listpanel-heading"> + sr-only h2,把列表面板升级为命名 landmark
          (WAI-ARIA 1.2)。h2 文案跟着 active 切换 —— 「文献」/「笔记」与 Tabs
          label 同步,用户用 NVDA D 进入 landmark 时能直接听到当前 panel 是什么。 */}
      <section
        aria-labelledby="listpanel-heading"
        // r199:panelRef 必须绑在**真正承载视觉宽度**的元素上。
        //   之前绑在下面的 inner div,而宽度写在 outer section 的 style.width 上
        //   ⇒ 拖拽期间 hook 直写的是 inner div 的 width,outer section 不动
        //   ⇒ 面板在拖拽过程中根本不缩放,内容溢出压到分隔条上,分隔条也不
        //   跟鼠标走(实测:拖 100px 后 section 宽度纹丝不动)。
        //   改成绑 outer section 后:拖拽期间 hook 直写 section 的 width
        //   ⇒ 面板实时跟手,分隔条随之移动。
        ref={panelRef}
        className="flex-shrink-0 flex flex-col min-h-0"
        style={{ width }}
      >
        <h2 id="listpanel-heading" className="sr-only">
          {active === 'library' ? t('workbench.tabLibrary') : t('workbench.tabNotes')}
        </h2>
        <div className="flex-1 border-r border-border-subtle bg-bg overflow-hidden flex flex-col min-h-0">
          {/* Tabs 行:flex-shrink-0 保持固定高度,list body 撑满下方。
              r240:右侧加「恢复默认宽度」按钮 —— 拖过分隔条后的一键回退。
              按钮是 Tabs 的**兄弟**节点(不在 role="tablist" 里)⇒ 不污染
              tablist 的 a11y 结构,也不会被 Tabs 的 roving tabindex 吞掉
              (Tab 键能正常走到它)。 */}
          <div className="flex-shrink-0 border-b border-border-subtle bg-bg-raised flex items-center justify-between gap-1">
            <Tabs tabs={tabDefs} active={active} onChange={handleTabChange} ariaLabel={t('workbench.listPanelAria')} />
            <button
              type="button"
              onClick={handleResetWidth}
              aria-label={t('workbench.listPanelResetWidth')}
              title={t('workbench.listPanelResetWidth')}
              className="mr-1 flex-shrink-0 inline-flex items-center justify-center h-6 w-6 rounded text-fg-tertiary hover:text-fg hover:bg-bg-hover transition-colors duration-120 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent"
            >
              <RotateCcw size={12} aria-hidden="true" />
            </button>
          </div>
          {/* body:按 active 渲染对应列表。两 list 各自管自己的 store / 空态。
              同一时刻只挂一个,切换时旧组件卸载(搜索框草稿等丢失是预期 —— 跨 tab 不保留草稿)。
              a11y (2026-09-15,r71 恢复):role="tabpanel" + id/aria-labelledby 跟随
              active,与 Tabs 按钮的 tab-{id}/panel-{id} 双向配对。 */}
          <div
            role="tabpanel"
            id={`panel-${active}`}
            aria-labelledby={`tab-${active}`}
            className="flex-1 min-h-0 overflow-hidden"
          >
            <Suspense fallback={<ListSkeleton />}>
              {active === 'library' ? <LiteratureList /> : <NotesList />}
            </Suspense>
          </div>
        </div>
      </section>
      {/* === 分隔条 ===
          side='left' → handle 在 panel 右沿;← 缩窄 / → 加宽(shift = 大步),
          Home/End 跳到 min/max。整 panelApi 直传 —— VerticalResizeHandle 内部
          按需解构,这里不再挑字段(避免漏传 panelRef / bumpWidth 让 TS 报 TS2739)。 */}
      <VerticalResizeHandle
        api={panelApi}
        side="left"
        min={PANEL_MIN}
        max={PANEL_MAX}
        ariaLabel={t('workbench.listPanelHandleAria')}
      />
    </>
  );
}

// perf (2026-09-14):最小骨架 —— list lazy 加载期间的占位。
//   不复用 EmptyState(它依赖 i18n key + 大图标 + 主区背景),这里只用一个
//   转圈的 Loader2 + 极简文案,符合"刚打开时不要加载太多东西"的设计。
// audit round 8 (2026-09-14):「…」走 i18n —— 之前硬编码字面量,英文用户
//   不至于看不懂(三个点很通用)但与项目其它 i18n 文案不一致。
function ListSkeleton() {
  const { t } = useTranslation();
  return (
    <div
      className="h-full flex flex-col items-center justify-center gap-2 text-2xs text-fg-tertiary"
      aria-busy="true"
      aria-live="polite"
    >
      <Loader2 size={14} className="animate-spin text-fg-tertiary" aria-hidden="true" />
      <span>{t('common.loadingDots')}</span>
    </div>
  );
}
