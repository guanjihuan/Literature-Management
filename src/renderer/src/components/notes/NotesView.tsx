// 笔记查看 — 主从布局右侧
//
// 形态:
//   ┌─────────────────────────────────────────────────────┐
//   │ [✎ 重命名] [🗑 删除]    relPath: ...                │
//   ├─────────────────────────────────────────────────────┤
//   │ [标题]                              [保存状态] [保存]│
//   │ ┌──────────────────────────────────────────────┐    │
//   │ │ MarkdownEditor(原始文本)/ 渲染显示 toggle   │    │
//   │ │ (来自 StandaloneNoteEditorCore)              │    │
//   └─────────────────────────────────────────────────────┘
//
// 设计:
//   - 重命名 / 删除按钮在 header;新建走 NotesList 顶部的 Modal
//   - 编辑器主体复用 StandaloneNoteEditorCore(title editable + save row + 单栏编辑器;
//     audit-r133 起默认原始文本,头栏 toggle 切只读「渲染显示」,无分屏)
//   - 空状态分两类:无 selectedId / selectedId 在 list 中找不到(外部删除 / 重命名 race)——
//     后者提示让用户清掉 selectedId,否则下次进 view 又卡在 selectedId 上找不到 summary
//     (audit 2026-09-07:之前静默 empty 没任何反馈,用户连发生了什么都不知道)。
//
// 重构 (2026-09 V1.4):笔记查看 + AI inline 工具栏合并到本组件。
// 重构 (2026-09 V1.9):AI inline 工具栏 + AITab 已下线 —— AI 模块整体移除,
//   summarize / keypoints / ask / expand 四个按钮、stableCtx、handleAIUpdate、
//   getAI 流式订阅、aiPane / aiNote 状态全部清掉。chrome 从 4 行收到 2 行。
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles, Trash2, FilePen } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useNotesStore } from '../../store/notes';
import { useWorkspaceStore } from '../../store/workspace';
import { useToast } from '../../lib/toast';
import { errMsg } from '../../lib/error';
import { StandaloneNoteEditorCore } from './StandaloneNoteEditorCore';
import { Modal } from '../ui/Modal';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { confirm } from '../../lib/confirm';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { EmptyState } from '../ui/chrome';
import { SkeletonLines } from '../ui/Skeleton';
import { stripExt } from '@shared/path-utils';

export function NotesView() {
  const { t } = useTranslation();
  // v2.0 Phase 4a:大数组 selector 改 useShallow 浅比 — save 后 `[...notes]`
  //   新引用但 elements 浅比较相同时父级不重渲;本组件 notes 只用于
  //   `notes.find((n) => n.id === selectedId)` 拿当前 summary,useMemo
  //   依赖 [notes, selectedId],useShallow 让 selectedId 变化以外的
  //   notes 引用变化(mtime-only 更新等)直接 short-circuit。
  const notes = useNotesStore(useShallow((s) => s.notes));
  const selectedId = useNotesStore((s) => s.selectedId);
  // perf (2026-09-06):activeNoteFull —— body 的唯一权威来源。listNotes 不再
  //   返 body 后,NotesView 通过 loadFullNote(id) 按需拉;save() 内部乐观
  //   更新 activeNoteFull(避免每击键重读盘)。loadingFull 留给未来"加载中
  //   spinner"用,目前 chrome 走 summary 已经即时可见,editor 走 null → body
  //   到位后 setBody,不需要 loading 占位。
  const activeNoteFull = useNotesStore((s) => s.activeNoteFull);
  const loadFullNote = useNotesStore((s) => s.loadFullNote);
  const save = useNotesStore((s) => s.save);
  const trash = useNotesStore((s) => s.trash);
  const renameFile = useNotesStore((s) => s.renameFile);
  const toast = useToast((s) => s.show);

  // selectedId 变化 → 拉全量(notes 是 summary,不含 body)。
  // 用 notes 里的 summary 做 fallback 显示(标题 / relPath),让"刚切到
  // 笔记但 full 还没拉回来"的中间帧 UI 不空(标题/路径已可见)。
  const summary = useMemo(
    () => (selectedId ? (notes.find((n) => n.id === selectedId) ?? null) : null),
    [notes, selectedId],
  );
  const note = activeNoteFull && activeNoteFull.id === selectedId ? activeNoteFull : null;

  // perf (2026-09-06):selectedId 变化触发懒加载 —— 仅在 id 切换时拉 1 次,
  //   后续 save 走 store 内置乐观更新(详见 useNotesStore.save 注释)。
  useEffect(() => {
    if (selectedId) void loadFullNote(selectedId);
  }, [selectedId, loadFullNote]);

  // === 跨组件「focus body」请求(audit-r22 2026-09-16,r24 重写 2026-09-21)===
  // NotesList.handleCreate / 拖入 import 完成后 → requestFocusNote(id) 把 id
  // 塞进 workspace store.pendingFocusNote。本 effect 校验
  // activeNoteFull?.id === id 才往下传 initialFocus='body' 给 Core。
  //
  // 历史 bug(r24):旧实现 consume + requestFocusNote 重挂在 IPC 永不返回
  //   时(IPC 失败 / 死循环)让 pendingFocusNote.version 单调递增,撞 React
  //   nested-update limit(~50)→ "Maximum update depth exceeded"。即使 IPC
  //   最终返回,中间也会浪费几十次 reconcile。
  // 修法(r24 落地):effect 只读 flag(hasPending + payload),curFullId 不
  //   匹配时保持 flag armed —— 不消费、不重挂。activeNoteFullId 这个 dep
  //   自己变化(loadFullNote IPC 返回)时 effect 再跑 → 匹配即消费 +
  //   setBodyFocusRequest。
  // 不能照搬 pendingRenameNote 的「id !== selectedId 直接 return 不重挂」
  //   模式 —— rename 丢一次用户可重命名,focus 丢用户完全无反馈(光标卡在
  //   list 不知道为什么「新建完了打字打不上」)。这里走「armed 等匹配」分支。
  // audit 2026-09-17 r23:订阅 pendingFocusVersion 而非 pendingFocusNoteId ——
  //   zustand 默认浅比较 short-circuit 同 id 重设,后者不变时订阅者不重渲。
  // 重构 (2026-09-17 v2.0 Phase 1a):pendingFocusNote.version 替代散落的
  //   pendingFocusNoteId + pendingFocusVersion 双字段,见 store/pendingCommand.ts。
  const _pendingFocusTick = useWorkspaceStore((s) => s.pendingFocusNote.version);
  const activeNoteFullId = useNotesStore((s) => s.activeNoteFull?.id ?? null);
  const [bodyFocusRequest, setBodyFocusRequest] = useState<string | null>(null);
  useEffect(() => {
    // 只读 flag —— 不消费、不重挂,避免 IPC 永不返回时的 re-arm 死循环。
    // peek helper 只读 payload 不动 version(走 store/pendingCommand.ts:pendingPeek),
    // 与 consume 配对成「先 peek 后条件 consume」的访问模式。
    const id = useWorkspaceStore.getState().peekFocusNoteRequest();
    if (id === null) return;
    const curFullId = useNotesStore.getState().activeNoteFull?.id ?? null;
    if (curFullId !== id) {
      // activeNoteFull 还没到(loadFullNote IPC 中间帧)或 selectedId 已切走
      //   —— armed 等下一次 activeNoteFullId dep 触发 effect 重跑。
      return;
    }
    // 匹配:原子 consume + 透传给 Core(initialFocus='body')
    useWorkspaceStore.getState().consumeFocusNoteRequest();
    setBodyFocusRequest(id);
  }, [_pendingFocusTick, activeNoteFullId]);
  // audit 2026-09-17 audit-r23:笔记切走时(bodyFocusRequest 仍记着上次 focus 的
  //   id)显式清零,避免「切到别的笔记 → 切回原笔记」时 NotesView 把过期的
  //   bodyFocusRequest 重新当作 current,误透传 initialFocus='body' 给 Core,
  //   Core 内部 setBodyAutoFocusToken(prev+1) 触发 CodeMirror contentDOM.focus(),
  //   扰乱 SR / 键盘用户的阅读流。注:仅清「已不匹配当前笔记」的旧请求,正在
  //   匹配的那一次由本 effect 走到 setBodyFocusRequest 后下次切换时再清。
  useEffect(() => {
    if (bodyFocusRequest !== null && bodyFocusRequest !== activeNoteFullId) {
      setBodyFocusRequest(null);
    }
  }, [activeNoteFullId, bodyFocusRequest]);

  // 重命名 / 删除 modal 状态
  const [renameOpen, setRenameOpen] = useState(false);
  // audit-r124:rename 输入框定向焦点 —— Overlay 进面板后 setTimeout(0)
  //   focus 兜底会把 React autoFocus 刚放好的光标从 input 偷到 panel
  //   (tabIndex=-1 div)。Overlay 的 initialFocusRef 优先级最高,指向此
  //   ref 后两条焦点路径收敛到同一节点。
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  // audit 2026-09-10:re-entry guard —— modal 内「确认」按钮的
  //   disabled={busy} 由 setBusy(true) 控制,但 setState 是异步的,两次
  //   Enter / 双击会在 setBusy 真正生效前都进 handler,导致并发跑两个
  //   renameFile IPC,第二条触发 'duplicate name' 错误。NotesList 已用
  //   creatingInFlightRef 同款修法(2026-09-10),这里对齐。
  // audit 2026-09-10 (react-hooks/rules-of-hooks 修复):所有 Hook 必须在
  //   任何 early-return 之前调用 —— React 在每次 render 按相同顺序 invoke
  //   hooks,如果本次 render 在 if (!selectedId) { return <Empty/> } 处早返回
  //   没有调 useRef,而下次 render selectedId 存在时调了 useRef,React 内部
  //   hook 索引错位 → 抛 "Rendered more hooks than during the previous render"。
  //   把所有 useRef 提到 top,与 setState 同组(其他 useState 也已在 top)。
  const renameInFlightRef = useRef(false);
  // audit 2026-09-10:同款 re-entry guard for delete —— 来自删除 confirm 弹窗
  //   的「确认」按钮,虽然 confirm 弹窗通常在第一次 click 后关闭,但快速双击
  //   仍可能在 setConfirmDelete(false) 真正生效前让两次 await remove 排队,
  //   第二条返回 NOT_FOUND,触发「文件已不在」toast 误导用户。
  const deleteInFlightRef = useRef(false);

  // === 跨组件「重命名」请求(audit 2026-09-07)===
  // NotesList 右键菜单选「重命名」时通过 store flag 触发(跨 tab 兜底 —
  // library tab 时右键笔记也会切到 notes + 弹 Modal)。NotesView 挂载或
  // pendingRenameNoteId 变化时 consume 一次,弹既有 rename Modal。
  // 只在 id === selectedId 时弹 —— store flag 可能落在其他 note 上,
  // 让 NotesList 那边自己 setSelected 再 consume;若 selectedId 不一致,
  // 当前 view 的 Modal 弹出来也对应不上用户右键的那条,这里静默丢掉,
  // 等 NotesList 重渲时 selectedId 同步后再次触发(下一次 store.set
  // 会让 pendingRenameNoteId 不变但 selectedId 变 → 不会重跑;接受这一次丢弃)。
  // 实际场景中 NotesList 已经在 setMenu → handleRenameFromMenu 里先
  // select(menu.note.id),再 requestRenameNote(id),所以 id === selectedId
  // 几乎总是成立。
  // 重构 (2026-09-17 v2.0 Phase 1a):订阅 pendingRenameNote.version 而非
  //   pendingRenameNoteId —— 同款 shape 统一,version tick 每次 request 必触发 effect。
  const _pendingRenameTick = useWorkspaceStore((s) => s.pendingRenameNote.version);
  useEffect(() => {
    // audit-r148 (2026-10-19) HIGH:peek 后条件 consume。
    //   之前在 id 匹配检查之前直接 consume,若 id !== selectedId
    //   (NotesList 几乎总是先 setSelected 再 requestRename,但 React 18
    //   批处理 + 异步状态更新下顺序不保证)请求被静默丢,用户右键重命名
    //   无 modal。peek 只读不重置,armed 等下次 effect 重跑(此处把
    //   selectedId 也加进 deps,让 setSelected 追上时 effect 再次触发)。
    const id = useWorkspaceStore.getState().peekRenameNoteRequest();
    if (!id) return;
    // audit 2026-09-10:从 useNotesStore.getState() 读最新 selectedId,而不是
    //   闭包里的 selectedId —— 后者在 effect 设置后才变的场景下会拿到旧值,
    //   让 id !== selectedId 误判成"丢弃",用户右键重命名没有任何反应。
    //   NotesList 几乎总是先 setSelected 再 requestRename,但 React 18 批处理
    //   + 异步状态更新下顺序不保证,显式 getState 兜底最稳。
    if (id !== useNotesStore.getState().selectedId) return;
    // 匹配:原子 consume + 透传给 Core(initialFocus='body')
    useWorkspaceStore.getState().consumeRenameNoteRequest();
    // summary 取最新一次:NotesView 在 selectedId 变化后 summary 闭包可能
    // 还在旧值(getState 读最新 store 数据)。
    const latestSummary = useNotesStore.getState().notes.find((n) => n.id === id);
    setRenameDraft(stripExt(latestSummary?.filename ?? ''));
    setRenameError(null);
    setRenameOpen(true);
    // selectedId 入 deps:不匹配时不动,setSelected 追上后 effect 再次跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [_pendingRenameTick, useNotesStore((s) => s.selectedId)]);

  // V1.8:关闭按钮已上移到 NotesPanel wrapper(WorkbenchContentPanel),这样
  //   空状态下(刚删完笔记 / 还没选笔记)用户也能一键收起右侧面板。NotesView
  //   自己不持有 setActive —— 由父层渲染关闭按钮并直接调 store。

  // === 空状态:无选中笔记 / 笔记已不在列表里(被外部删 / 重命名 race) ===
  // perf (2026-09-06):用 summary 判断 —— body 未加载但 summary 在,UI 不应
  //   切到 empty state;body 未到时 Editor 的 useEffect 会等 note 出现再 setBody,
  //   渲染期间把 note 当 null 传即可,Editor 自己处理。
  // audit 2026-09-07:分两类空态 —— 「没选过」与「选了但列表里没了」语义不同:
  //   后者是外部删除 / 重命名 race 的产物,提示要让用户清掉 selectedId 才能继续,
  //   否则下次进 view 又卡在 selectedId 上找不到 summary(目前 case 静默走到 empty
  //   state 没任何反馈,用户连发生了什么都不知道)。
  // audit-r70 (2026-10-16):`!selectedId` 这一支已挪到 WorkbenchContentPanel
  //   的 NotesEmptyState 接管(右主区不再白空一片),NotesView 自身只在收到
  //   selectedId 后渲染,所以这里只剩「选了但列表里没了」的 stale race 支。
  if (!summary) {
    return (
      // audit 2026-09-16 r18:M2 — stale 状态走 assertive:race 触发的「
      //   选中笔记被删 / 改」应立即告知 SR 用户,不能等 5s 默认 polite 延迟。
      <EmptyState
        size="lg"
        accent="notes"
        icon={<Sparkles size={28} aria-hidden="true" />}
        title={t('notes.viewStaleTitle')}
        description={t('notes.viewStaleDesc')}
        liveRegion="assertive"
        action={
          <Button
            variant="primary"
            size="sm"
            onClick={() => useNotesStore.getState().select(null)}
            aria-label={t('notes.viewStaleAction')}
          >
            {t('notes.viewStaleAction')}
          </Button>
        }
      />
    );
  }

  // === Header action handlers ===
  // perf (2026-09-06):chrome 字段(title / filename / relPath)从 summary 取,
  //   body 走 note(全量);rename/delete 入参用 summary.id / filename —— 这些
  //   操作不依赖 body,让 note 还在加载时 header 按钮也能响应。
  const handleSave = async (id: string, body: string, title: string): Promise<void> => {
    // audit 2026-09-07:单点处理 —— 之前 Core 自己 log + setSaveState('error'),
    // 这里再 log + toast,导致同一次失败在 renderer log 出现两条,且 saveState
    // 指示符与 toast 同时显示给用户(双反馈)。修:Core 只设 saveState 指示
    // + re-throw,这里 catch 后只 toast —— 用户层反馈归一处,详细错误归 Core 日志。
    //
    // audit 2026-10-04 (P0 数据丢失):上面的「单点处理」写法有个致命副作用 ——
    //   onSave **就是** 本函数。Core 的 doSave(StandaloneNoteEditorCore.tsx:240)
    //   依赖 onSave 的 reject 才走 setSaveState('error');这里把错误吞掉后,
    //   Core await 的 promise 永远 resolve → 落到 :249 setSaveState('saved')
    //   → UI 显示绿勾「已保存」(实际没落盘),且 :430 的保存按钮因
    //   disabled={saveState === 'saved'} 变灰,用户连手动重试都点不了。
    //   接着切笔记时,两处 flush 守卫看到的既不是 dirty 也不是 saving
    //   (是 saved / error)⇒ 不补落盘 ⇒ 编辑器里的文字随卸载消失。
    //
    //   修法:toast 之后**必须 rethrow**。这不违反「单点处理」——toast 仍只有
    //   一条(只在这里弹),Core 的 catch 只 log + 置态、不弹 toast。
    //   doSave 的所有调用点(autosave ×2 / ⌘S / note-switch flush / unmount
    //   flush / 手动保存按钮)都已挂 .catch,rethrow 不会变成 unhandledRejection。
    try {
      await save(id, body, title);
    } catch (err: unknown) {
      toast({ type: 'error', message: t('toast.saveNoteFailed', { msg: errMsg(err) }) });
      throw err;
    }
  };
  const openRename = () => {
    setRenameDraft(stripExt(summary.filename));
    setRenameError(null);
    setRenameOpen(true);
  };
  // audit-r154 (2026-10-19) UX HIGH #5:rename modal 关闭路径吞 draft 修复。
  //   原 onClose={() => setRenameOpen(false)} + cancel Button onClick 同款
  //   直关:用户改到一半按 Esc / 点 X / 点取消,draft 静默丢失,rename 是
  //   难复现的破坏性丢失。改 dirty-guarded closeRename:仅当 draft ===
  //   原始文件名时静默关(用户没改),否则走命令式 confirm(discardRename*)
  //   让用户显式选择。doRename 内部失败 reset 时也走 closeRename(true)
  //   跳过 confirm(语义 = 用户已表达"放弃",与 prompt 重复)。
  const closeRename = async (skipConfirm = false) => {
    if (
      !skipConfirm &&
      renameDraft.trim() !== '' &&
      renameDraft.trim() !== stripExt(summary.filename)
    ) {
      const ok = await confirm({
        title: t('notes.discardRenameTitle'),
        description: t('notes.discardRenameDesc', { name: renameDraft.trim() }),
        confirmLabel: t('notes.discardRenameConfirm'),
        danger: true,
      });
      if (!ok) return;
    }
    setRenameOpen(false);
  };
  const doRename = async () => {
    if (renameInFlightRef.current) return;
    const trimmed = renameDraft.trim();
    if (!trimmed || trimmed === stripExt(summary.filename)) {
      setRenameOpen(false);
      return;
    }
    renameInFlightRef.current = true;
    setBusy(true);
    setRenameError(null);
    try {
      const updated = await renameFile(summary.id, trimmed);
      toast({ type: 'success', message: t('toast.renameNoteSuccess', { name: updated.filename }) });
      setRenameOpen(false);
    } catch (err: unknown) {
      // audit 2026-09-07:把 inline 错误塞进 modal 内的 input 下方,而不是
      //   只 toast —— toast 一闪而过,用户记不清"为啥没改成",modal 重开
      //   又得重新输。modal 内显示错误 + 保留 modal + 重置焦点 → 用户
      //   改完再次 Enter 重试,失败原因就地可见。
      setRenameError(t('notes.renameErrorGeneral', { msg: errMsg(err) }));
    } finally {
      setBusy(false);
      renameInFlightRef.current = false;
    }
  };
  const doDelete = async () => {
    if (deleteInFlightRef.current) return;
    deleteInFlightRef.current = true;
    // audit 2026-09-16 r18:M7 — delete 与 rename 共享 `disabled={busy}`,但
    //   原 doDelete 没调 setBusy(true),删除按钮删除期间仍可点击 → 用户连点
    //   触发「笔记已删 / 你重命名了一个不存在的笔记」连锁错误。setBusy 与
    //   rename 同一模式,失败时 finally 还原。
    setBusy(true);
    try {
      await trash(summary.id);
      toast({ type: 'success', message: t('toast.trashNoteSuccess') });
      setConfirmDelete(false);
    } catch (err: unknown) {
      toast({ type: 'error', message: t('toast.trashNoteFailed', { msg: errMsg(err) }) });
    } finally {
      setBusy(false);
      deleteInFlightRef.current = false;
    }
  };

  return (
    <div className="h-full flex flex-col bg-bg overflow-hidden">
      {/* === Top action row(重命名 / 删除) — V1.5:chrome 收紧到 px-4 py-2 与 TabsBar/StatusBar 同节奏 === */}
      {/* audit 2026-09-16 r18:M8 — 加 aria-live=polite 让屏幕阅读器播报
          busy/成功 toast(原静态 region 没用)。role=status 在 toasts/aria-live
          双通道播报。 */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="px-4 py-2 border-b border-border-subtle flex items-center gap-2 flex-shrink-0"
      >
        <Button
          variant="ghost"
          size="sm"
          onClick={openRename}
          disabled={busy}
          aria-label={t('common.renameNote')}
          title={t('common.renameNote')}
        >
          <FilePen size={13} aria-hidden="true" />
        </Button>
        <Button
          variant="danger"
          size="sm"
          onClick={() => setConfirmDelete(true)}
          disabled={busy}
          // audit-r151 (2026-10-19) UX HIGH #3:与右键菜单 + confirm 对齐,
          //   走 t("notes.contextTrash")「移入回收站 / Move to Trash」——
          //   同一操作(走 safeTrash → 系统回收站)不在两个 surface 用不同
          //   动词。原头部 trash aria-label 用的「删除笔记 / Delete note」
          //   误导 SR 用户以为头部更破坏(真文件删除),实际只是走系统回收站
          //   的可恢复操作,与列表右键菜单完全一致。
          aria-label={t('notes.contextTrash')}
          title={t('notes.contextTrash')}
        >
          <Trash2 size={13} aria-hidden="true" />
        </Button>
        <span className="text-2xs text-fg-tertiary font-mono truncate ml-auto">
          {summary.relPath}
        </span>
      </div>

      {/* === 编辑器主体(复用 StandaloneNoteEditorCore) === */}
      {/* audit-r124:r120 同款修复镜像 —— Core 是 Fragment,body 容器用 flex-1,
          本 wrapper 若还是块级,flex-1 落空(body 高度=内容,超长被
          overflow-hidden 无声裁切)。补 flex flex-col 让链闭合。 */}
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
        {note ? (
          <StandaloneNoteEditorCore
            note={note}
            onSave={handleSave}
            titleEditable
            // audit 2026-09-16 audit-r22 — 「先写后命名」:创建 / 拖入后焦点
            //   落到 body。「刚创建」由上面 useEffect 设的 bodyFocusRequest ===
            //   当前选中笔记 id 判定 —— 仅在 consume pendingFocusNoteId 且
            //   activeNoteFull.id 匹配时才为 true。其它情况 undefined,Core
            //   不主动 focus,保持现有「普通点击光标不动」行为。
            initialFocus={bodyFocusRequest === note.id ? 'body' : undefined}
          />
        ) : (
          // audit 2026-09-07:selectedId 有但 full 还没拉回来时给个 SkeletonLines
          //   占位(原本直接渲染 <StandaloneNoteEditorCore note=null>,UI 短暂
          //   空白)。Reader 有 ReaderLoading 同款模式,NotesView 对齐。
          <div className="h-full px-4 py-3" aria-busy="true" aria-live="polite">
            <SkeletonLines rows={6} />
          </div>
        )}
      </div>

      {/* === 重命名 Modal === */}
      {/* audit-r145a (2026-10-19) HIGH:r143e 接入 —— Modal.description
       *   接「扩展名自动追加」提示(替代原 <p id="rename-input-hint">),SR
       *   念完 dialog title 后接念 description,与 Modal 原语契约一致
       *   (modal-contract.test.tsx「description 传 string → aria-describedby +
       *   <p id=> 渲染」锁);Input.error 接 renameError 替代手写 aria 三件套
       *   (aria-invalid + aria-describedby + 下方裸 <p role=alert>),让 input
       *   原语自己管 error 视觉 + a11y 接线(input-contract.test.tsx 锁)。
       *   Hint 与 Error 互不抢语义:description 始终宣读(用户对 UX 提示的
       *   「这条输入框会做什么」先验);error 只在 IPC 失败时出现,role=alert
       *   让 SR 中断当前播报宣读错误内容 —— 双通道独立工作。 */}
      <Modal
        open={renameOpen}
        onClose={closeRename}
        title={t('modal.renameNote')}
        description={t('notes.saveExtensionHint')}
        initialFocusRef={renameInputRef}
        footer={
          <>
            <Button variant="ghost" onClick={closeRename} disabled={busy}>
              {t('common.cancel')}
            </Button>
            {/* audit-r145d (2026-10-19) MED:Button.loading 接入 —— 原
             *   disabled={busy || !renameDraft.trim()} 把两个语义混一起
             *   (loading + form-validation)。拆:loading={busy} 给原语处理
             *   spinner + aria-busy + 强 disabled(IPC 跑期间视觉反馈 +
             *   SR 同步);disabled={!renameDraft.trim()} 只剩纯表单校验
             *   (空 draft 不能提交,与 IPC 无关)。cancel 仍走 disabled={busy}
             *   —— cancel 不显示 spinner(用户没发起动作,不该给「正在处理」
             *   错觉),但要挡双击关弹窗时 IPC 已飞的问题。 */}
            <Button
              variant="primary"
              onClick={doRename}
              loading={busy}
              disabled={!renameDraft.trim()}
            >
              {t('modal.renameNoteConfirm')}
            </Button>
          </>
        }
      >
        <label htmlFor="rename-input" className="block text-xs text-fg-secondary mb-1.5">
          {t('notes.renameFilenameLabel')}
        </label>
        <Input
          id="rename-input"
          ref={renameInputRef}
          value={renameDraft}
          onChange={(v) => {
            setRenameDraft(v);
            if (renameError) setRenameError(null);
          }}
          autoFocus
          error={renameError ?? undefined}
          onKeyDown={(e) => {
            // audit-r80 (2026-10-17) HIGH:IME composition 期间的 Enter 是
            //   「选词上屏」,不是提交 —— 此时 React state 还是上屏前的 stale
            //   值,doRename 会用半截拼音串发起重命名;若 stale 值恰好仍等于
            //   旧名(从头重打的常见路径)则静默关弹窗,刚打的字全丢。
            //   composition 的 keydown(isComposing=true)一律放行给输入法。
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter') {
              // audit round 8 (2026-09-14):preventDefault 阻止 form submit 默认
              //   行为 —— 之前裸 doRename 在 form 内会触发 form onSubmit 同时
              //   跑一次,造成 renameInFlightRef 双重 race(用户连按 Enter 触发
              //   第二条 IPC 撞 duplicate name 错误)。
              e.preventDefault();
              void doRename();
            }
          }}
        />
      </Modal>

      {/* === 删除确认 === */}
      <ConfirmDialog
        open={confirmDelete}
        title={t('notes.trashConfirmTitle', { title: summary.title || summary.filename })}
        message={t('notes.trashConfirmDesc')}
        confirmLabel={t('notes.trashConfirmLabel')}
        danger
        onConfirm={doDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  );
}
