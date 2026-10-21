// 工作台右侧主区:文献 Reader / NotesView(2026-09 V1.8,audit-r56 收尾,
//   audit-r70 补 EmptyState,audit-r71 恢复 library 分支,
//   2026-10-18 主区与左栏 Tab 解耦 + 双列)
//
// 形态:主区**不跟左栏 Tab 切换**,只跟两个模块各自的"打开"状态:
//   - 两模块都没打开 → 空态,文案身份跟随左栏 active(仅此时 active 起作用)
//   - 只开一个       → 该模块单列占满主区
//   - 两个都开       → 双列:文献 Reader 在左 ┃(可拖分隔条)NotesView 在右
//   ┌───────────── 双列 ─────────────┐
//   │ LibraryPanel │┃│ NotesPanel     │
//   └────────────────────────────────┘
//
// 2026-10-18 解耦改造(需求:「切文献/笔记 Tab 主界面不自动切换;两边都有
//   文件打开时双列显示」):
//   - 之前:`active === 'notes'` / `active === 'library'` 各自门控一路 panel
//     分支 —— 切 Tab = 整主区替换,文献开着时切到笔记 Tab,Reader 被顶掉。
//   - 现在:litFile(由 literature selectedId + items 派生)与 notes
//     selectedId 两个独立打开态驱动渲染;active 只剩"都未打开"时选空态身份。
//   - 列表行点击 / SearchPanel 直达 / ⌘1-⌘2 的 setActive 原样保留 —— 它们
//     切的是左栏列表;主区新增打开态时**不会顶掉另一模块**(双列由此而来)。
//   - 每列顶部 × 只清本模块 selectedId、不动 active(双列关一列另一列占满;
//     单列关列主区落空态,身份取当前 Tab)。
//   - 双列文献列宽走 useResizablePanel(storageKey
//     'workbench.readerColumn.width',px 持久化),分隔条复用
//     VerticalResizeHandle —— 与左栏 list panel 同款交互(拖拽 / 键盘 /
//     双击复位 / Esc 取消)。
//
// 历史背景(保留):
//   - audit-r56:三段式「列表 + Reader + NotesView 并排」曾整体下线 library;
//   - audit-r70:!selectedId 时主区是空白 <div>,补 NotesEmptyState;
//   - audit-r71:恢复 library 分支,Reader 由 literature selectedId 驱动;
//     litItems 冷挂载竞态(直达时 items 未 load 完)派生 null,load 完成后
//     重算自动出列 —— 已接受风险 #4,不加第 39 条 IPC 通道做 id 反解。
//   - 空态顺序契约:NotesEmptyState 必须仍是源码里第一个真正的 EmptyState
//     JSX(polite 播报)。测试 extractFirstEmptyState 按尖括号开标签字面取样,
//     注释区出现同样的「开标签 + polite 属性值」字面组合会把取样起点打偏到
//     注释(2026-10-18 本行初稿就踩中,故注释只写裸名字)。
import { lazy, Suspense, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { X, FileText, NotebookPen } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useWorkspaceStore } from '../../store/workspace';
import { useNotesStore } from '../../store/notes';
import { useLiteratureStore } from '../../store/literature';
import { useResizablePanel } from '../../hooks/useResizablePanel';
import { useResizeContentFreeze } from '../../hooks/use-resize-content-freeze';
import { extOf, filenameOf } from '../../utils/lit-path';
import type { ReaderFile } from '../reader/Reader';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/chrome';
import { VerticalResizeHandle } from './VerticalResizeHandle';

// perf (2026-09-14 同款,r71 沿用):Reader lazy —— 它内部再 lazy 6 个子阅读器
//   (highlight.js / markdown-it / PDF.js 全在子 chunk)。只有文献列打开才下载。
const Reader = lazy(() => import('../reader/Reader').then((m) => ({ default: m.Reader })));

// perf (2026-09-14):NotesView 改 lazy —— 它通过 StandaloneNoteEditorCore →
//   MarkdownEditor 拉 CodeMirror 6(~180KB;audit-r133 起笔记默认原始文本,
//   markdown-it 只在点开「渲染显示」才 lazy 拉)。仅在笔记打开时才下载,
//   首屏主 bundle 砍掉这块。NotesView 自身有 SkeletonLines 占位,
//   这里 Suspense fallback=null 即可。
const NotesView = lazy(() => import('../notes/NotesView').then((m) => ({ default: m.NotesView })));

// 双列模式下文献列宽(px)—— min 保证 Reader 可读(表格/PDF 最窄可用宽度),
// max 防止文献列把笔记列挤没(主区剩余 ≥ 笔记列最低可用宽度由 resize 重夹兜底:
// useResizablePanel 的 getMaxForWindow 默认「视口 60%」上限在窗口缩小时生效)。
const READER_COL_MIN = 320;
const READER_COL_MAX = 1600;
const READER_COL_DEFAULT = 640;

export function WorkbenchContentPanel() {
  const { t } = useTranslation();
  // active 仅参与「两模块都未打开」时的空态身份选择;开着的 panel 分支一律
  //   不看它(行为锁:tests/unit/renderer/layout/workbench-content-decoupled-columns.test.tsx
  //   (audit-r229 补齐 13 例)
  //   —— 有打开态时切 active,主区组件必须原样不动)。
  const active = useWorkspaceStore((s) => s.active);
  // 笔记打开态 = notes.selectedId(2026-09-07 修复注保留:!selectedId 不弹
  //   NotesPanel 空壳;与文献态互不顶掉)。
  const selectedId = useNotesStore((s) => s.selectedId);
  // 文献打开态 = literature.selectedId 在 items 里命中后派生的 ReaderFile。
  //   litItems 冷挂载竞态按未打开处理(见文件头 audit-r71 注)。
  const litItems = useLiteratureStore(useShallow((s) => s.items));
  const selectedLitId = useLiteratureStore((s) => s.selectedId);
  const litFile = useMemo<ReaderFile | null>(() => {
    if (!selectedLitId) return null;
    const r = litItems.find((x) => x.id === selectedLitId);
    if (!r) return null;
    return {
      id: r.id,
      extension: extOf(r.absPath),
      absPath: r.absPath,
      filename: filenameOf(r.absPath),
    };
  }, [litItems, selectedLitId]);

  // 双列文献列宽:与非双列单列占满共享同一份持久化宽度(切 Tab / 开关列不
  //   重置用户拖过的比例)。side='left' → 手柄在文献列右沿,向右拖 = 加宽。
  const readerCol = useResizablePanel({
    storageKey: 'workbench.readerColumn.width',
    defaultWidth: READER_COL_DEFAULT,
    min: READER_COL_MIN,
    max: READER_COL_MAX,
    side: 'left',
  });

  return (
    <div className="flex-1 flex flex-row min-w-0 min-h-0 overflow-hidden">
      {litFile !== null && selectedId ? (
        <>
          <div
            ref={readerCol.panelRef}
            // r230:overflow-hidden —— 拖拽期间文献列的**内容宽度被钉死**
            //   (useResizeContentFreeze),钉住的宽度可能大于当前列宽
            //   (拖窄时)⇒ 内容会溢出到右侧笔记列上。本列负责裁切。
            className="flex flex-col flex-shrink-0 min-w-0 min-h-0 overflow-hidden"
            style={{ width: readerCol.width }}
          >
            <LibraryPanel file={litFile} />
          </div>
          <VerticalResizeHandle
            api={readerCol}
            side="left"
            min={READER_COL_MIN}
            max={READER_COL_MAX}
            ariaLabel={t('workbench.readerColumnHandleAria')}
          />
          <div className="flex flex-col flex-1 min-w-0 min-h-0">
            <NotesPanel />
          </div>
        </>
      ) : litFile !== null ? (
        <div className="flex flex-col flex-1 min-w-0 min-h-0">
          <LibraryPanel file={litFile} />
        </div>
      ) : selectedId ? (
        <div className="flex flex-col flex-1 min-w-0 min-h-0">
          <NotesPanel />
        </div>
      ) : active === 'notes' ? (
        <NotesEmptyState />
      ) : (
        <LibraryEmptyState />
      )}
    </div>
  );
}

// === 笔记模块未选中态 ===
//
// audit-r70 (2026-10-16):本组件原本只渲染 `<NotesPanel>`,当 selectedId 为 null
//   时右主区是一片空白 <div> —— 用户看到左侧有笔记列表,右侧全黑,自然怀疑
//   「功能没了」。这里补 EmptyState,与 NotesList 的笔记模块空态(同样的
//   NotebookPen 图标 + accent="notes")视觉对齐,文案直接复用
//   notes.viewEmptyTitle/Desc。
//
// 2026-10-18 解耦后本空态只在「两模块都未打开 且 active==='notes'」时出现;
//   文献开着切到笔记 Tab 看到的是文献列,不是这里(主区不随 Tab 切换)。
//
// 设计:
//   - size="lg" + 撑满父容器(flex-1 h-full from EmptyState):与主区视觉密度
//     匹配,不被 closePanel 的小窄带压缩。
//   - liveRegion="polite":与 NotesList 空态 / NotesView stale 分支思路一致
//     —— 「未选中」是预期正常状态,polite 让 SR 听到「选中左侧笔记查看」
//     但不打断阅读。stale 是 race 用 assertive 抢播报。
//   - 无 action 按钮:description 文案「或者新建一篇开始」已 hint 此路径,
//     加按钮会让本组件多一处 useNotesStore 依赖(测试需 mock store),
//     收益 < 复杂度。NotesList 顶栏 `+` 与全局 ⌘N 仍可达。
function NotesEmptyState() {
  const { t } = useTranslation();
  return (
    <EmptyState
      size="lg"
      accent="notes"
      icon={<NotebookPen size={28} aria-hidden="true" />}
      title={t('notes.viewEmptyTitle')}
      description={t('notes.viewEmptyDesc')}
      liveRegion="polite"
    />
  );
}

// === 笔记列(单列占满 / 双列右列) ===
//
// 设计:
//   - 顶部关闭按钮条:NotesView 任何状态下都可见(空态 / 有笔记态都包含),
//     行为:只清 notes.selectedId —— 2026-10-18 解耦后**不再动 active**,
//     关笔记列不切左栏 Tab;双列时另一列(文献)自动占满,重开靠再点行。
function NotesPanel() {
  const { t } = useTranslation();
  // r230:拖拽期间冻结笔记列内容的宽度(见 hooks/use-resize-content-freeze)。
  //   笔记列内容有两种形态 —— 原始文本(CodeMirror)与「渲染显示」
  //   (MarkdownReader);后者是一整篇文档,宽度每帧变 ⇒ 每帧重新折行 +
  //   重新排版表格(实测 189KB 文档 50ms/帧,见该 hook 头注)。
  const contentRef = useRef<HTMLDivElement>(null);
  useResizeContentFreeze(contentRef);
  const closePanel = useCallback(() => {
    // 只关本列:清 selectedId → WorkbenchContentPanel 的笔记分支落空。
    //   active 不动(切左栏 Tab 不是关闭主区列的副作用)。
    useNotesStore.getState().select(null);
  }, []);
  return (
    <>
      <div className="flex justify-end px-3 py-1.5 border-b border-border-subtle bg-bg-raised flex-shrink-0">
        <Button
          variant="ghost"
          size="xs"
          onClick={closePanel}
          aria-label={t('notes.closePanelAria')}
          title={t('notes.closePanelAria')}
        >
          <X size={11} aria-hidden="true" />
        </Button>
      </div>
      <div ref={contentRef} className="flex-1 min-h-0 overflow-hidden">
        {/* perf (2026-09-14):NotesView 是 lazy —— NotesView 内部已有
            SkeletonLines 占位,这里 fallback=null 让 NotesView 自管的占位
            立即接管(避免双重骨架闪烁)。 */}
        <Suspense fallback={null}>
          <NotesView />
        </Suspense>
      </div>
    </>
  );
}

// === 文献模块未选中态(audit-r71)===
//
// 镜像 NotesEmptyState 的设计决策(size="lg" / liveRegion="polite" / 无 action
//   按钮 —— 入口在左列 LiteratureList 的导入按钮与拖放,不放这里免得多一处
//   store 依赖)。accent="library" 走 chrome.tsx 既有 MODULE_COLOR 双模块定义。
//
// 注意:本组件必须保持在文件里 NotesEmptyState 之后定义 ——
//   tests/unit/renderer/layout/workbench-content-empty-state.test.ts
//   (audit-r229 补齐 10 例)以
//   「源码中第一个 <EmptyState …liveRegion="polite"… />」锁定 notes 空态视觉
//   契约,顺序颠倒会把该锁打偏到 library 块上。
function LibraryEmptyState() {
  const { t } = useTranslation();
  return (
    <EmptyState
      size="lg"
      accent="library"
      icon={<FileText size={28} aria-hidden="true" />}
      title={t('literature.viewEmptyTitle')}
      description={t('literature.viewEmptyDesc')}
      liveRegion="polite"
    />
  );
}

// === 文献列(单列占满 / 双列左列)(audit-r71)===
//
// 设计:
//   - file prop 由 WorkbenchContentPanel 派生(LiteratureResource → ReaderFile),
//     本组件不再订阅 store items —— 单一派生点,防两处 find 逻辑漂移。
//   - 顶部关闭条与 NotesPanel 同构:setSelected(null),active 不动
//     (2026-10-18 同款解耦语义)。
//   - 文本类(md/code/plain)文件走 Reader 内部 readFileForReader(absPath);
//     PDF/图片走 rkms:// 协议直读 —— r71 修了 Reader 传 id 的裂缝后两路都真。
function LibraryPanel({ file }: { file: ReaderFile }) {
  const { t } = useTranslation();
  // r230:拖拽期间冻结文献列内容的宽度(见 hooks/use-resize-content-freeze)。
  //   markdown / 图片 / 代码类文献在此重排;PDF 由 PDFReader 自己冻结 iframe
  //   (r202),这里再钉一层不冲突(PDF 走同一套「宽度钉死」语义)。
  const contentRef = useRef<HTMLDivElement>(null);
  useResizeContentFreeze(contentRef);
  const select = useLiteratureStore((s) => s.select);
  const closePanel = useCallback(() => {
    select(null);
  }, [select]);
  return (
    <>
      <div className="flex justify-end px-3 py-1.5 border-b border-border-subtle bg-bg-raised flex-shrink-0">
        <Button
          variant="ghost"
          size="xs"
          onClick={closePanel}
          aria-label={t('literature.closePanelAria')}
          title={t('literature.closePanelAria')}
        >
          <X size={11} aria-hidden="true" />
        </Button>
      </div>
      {/* audit-r120:必须 flex flex-col —— 子 reader(PDF/Image/Markdown/Code/
          Plain)根节点高度全靠 flex-1 撑;块级父下 flex-1 失效,iframe 的
          h-full 百分比解析失败回退 UA 默认 300×150(PDF 塌成 150px 横条报障)。
          锁:tests/unit/renderer/layout/library-reader-flex-chain.test.tsx
          (audit-r229 补齐 5 例) */}
      <div ref={contentRef} className="flex-1 min-h-0 overflow-hidden flex flex-col">
        <Suspense fallback={null}>
          <Reader file={file} />
        </Suspense>
      </div>
    </>
  );
}
