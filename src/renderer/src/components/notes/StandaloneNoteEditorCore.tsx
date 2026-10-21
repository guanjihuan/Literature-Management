// 独立笔记编辑器主体 — 持有 body / title / 防抖 autosave / 显示模式 toggle。
//
// audit-r133:显示模型改「默认原始文本 + 切换渲染显示」——
//   2026-09-06 的 Typora 原地渲染(装饰层自动隐藏非活动行标记)被用户报障
//   「显示存在很大问题」(符号忽隐忽现 / 内容跳动 / 表格任务列表装饰缺失),
//   装饰层 markdown-live-preview.ts 整体删除。现在默认是纯源码编辑器
//   (MarkdownEditor,doc 原样显示);头栏「渲染显示」按钮切到只读渲染视图
//   (复用 reader/MarkdownReader:markdown-it → sanitize → prose-academic),
//   再点切回。body 由 Core 持有,切换往返不经过编辑器实例,未保存内容不丢
//   (行为锁 tests/unit/renderer/notes/editor-preview-toggle.test.tsx ——
//    本轮补齐 6 例:默认原始文本 / 双向切换 / 往返不丢正文 /
//    预览显示最新正文 / 切换不动保存状态 / 聚焦正文时切回源码视图)。
//
// 设计要点:
//   - Core 内部维护 body / title / saveState(controlled-by-effect,带同步)。
//     当 prop.note.id 变化,Core 拉取新 note 的字段填回本地态;切走旧笔记时
//     flush 防抖定时器。
//   - onSave(body, title) 由 owner 决定怎么落盘 —— 当前唯一调用方 NotesView
//     调 useNotesStore.save,Core 不绑任何特定 store,保持纯展示 + 受控的输入。
//   - 切换 note 时 Core 不弹"未保存切换"对话框 —— owner 自管 dirty 提示。
//     标准用法:Core + owner 各自的 ConfirmDialog(可选)。
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Check, Save, AlertCircle, Pencil, Eye, Code, Undo2, Redo2 } from 'lucide-react';
import { Input } from '../ui/Input';
import { Button } from '../ui/Button';
import { SkeletonLines } from '../ui/Skeleton';
import { createLogger } from '../../lib/logger-client';
import { MarkdownEditor, type MarkdownEditorApi } from '../editor/MarkdownEditor';
import { clsx } from '../../lib/clsx';
import { WORKSPACE_LIMITS } from '@shared/types';
import { useWorkspaceStore } from '../../store/workspace';
import { useNotesStore } from '../../store/notes';
import { resolveNoteId } from '../../lib/note-id-remap';
import { IpcError } from '../../lib/api';
import type { StandaloneNote } from '@shared/types';

const log = createLogger('StandaloneNoteEditorCore');

// audit-r133:「渲染显示」模式复用 reader/MarkdownReader(markdown-it + sanitize
// + prose-academic)。lazy + 只在 preview 首次打开时才拉 —— NotesView chunk 平时
// 不带 markdown-it(~80KB),与 Reader.tsx 的 perf 约定一致。
const MarkdownReader = lazy(() =>
  import('../reader/MarkdownReader').then((m) => ({ default: m.MarkdownReader })),
);

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

/**
 * 「当前有未落盘内容」的判定 —— note-switch flush(:124)与 unmount flush(:198)
 * 共用同一份,避免两处条件再次漂移。
 *
 * audit 2026-10-04 (P0 数据丢失):原实现两处都写成
 *   `state === 'dirty' || state === 'saving'`
 * **漏了 'error'**。而保存失败(磁盘满 / 目录只读 / 文件被锁)时状态恰恰是
 * 'error' ⇒ 切笔记 / 关面板时两个守卫都不匹配 ⇒ flush 不执行 ⇒ 编辑器里
 * 那段内容随组件卸载彻底消失,磁盘上还是上一次的内容。
 * 'idle' 与 'saved' 才是真正「无未落盘内容」的状态。
 */
function hasUnflushedContent(state: SaveState): boolean {
  return state === 'dirty' || state === 'saving' || state === 'error';
}

/**
 * 保存失败的草稿缓冲 —— 跨组件实例存活(renderer 进程内)。
 *
 * audit 2026-10-05:HIGH(数据丢失 + 谎报状态)—— 切笔记 / 卸载时的 flush 失败
 * 原本只有一句 `log.error`,随后 effect **无条件** `setSaveState('saved')`。
 * 后果是确定性的,不是理论上的:
 *
 *   1. 目录只读 / 磁盘满 / 文件被锁 → autosave 失败,状态 'error';
 *   2. 用户点另一篇笔记 → flush 旧笔记 → **同一个只读目录不会在两次调用之间
 *      变可写** → 补存再次失败,只 log;
 *   3. 紧接着 `setSaveState('saved')` → UI 显示「已保存」;
 *   4. 用户点回原笔记 → `api.readNote` 读**磁盘** → 上一次的内容,新文字没了。
 *
 * store 侧兜不住:`store/notes.ts` 的 `save` 是
 * `const note = unwrap(await api.writeNote(...))`,失败时**在 patch 之前就抛出**,
 * `notes[]` 与 `activeNoteFull` 都保持旧 body —— 所以内存里也没有副本可捞。
 *
 * 于是这里把失败那一刻的 body/title 留下来。它是模块级(不是 ref)的原因:
 * ref 随组件卸载一起消失,而「关面板 → 重开」正是最需要它活着的场景。
 * 下次加载该笔记时用草稿覆盖磁盘内容并保持 'error' 状态 —— 用户的字重新
 * 出现在编辑器里,下一次 ⌘S / autosave 会自动重试落盘,自愈。
 *
 * 成功保存时(`doSave` 的 try 分支)清掉对应条目,避免草稿无限堆积。
 *
 * 覆盖范围与已知边界(不要过度承诺):
 *   - 覆盖:同一 renderer 进程内的切笔记 / 关面板 / 重开。
 *   - **不覆盖**应用整体退出(进程没了)—— 那条路是 beforeunload flush,
 *     见该处注释与 H2 记录。
 */
// audit r35 (2026-10-08):把 failedDrafts Map + clearFailedDraft 抽到
//   store/failed-drafts.ts(叶子模块),避免与 store/notes.ts 形成循环依赖
//   (layering.test.ts 失败原因)。本组件与 store/notes 现在都单向依赖叶子。
import { clearFailedDraft, getFailedDraft, putFailedDraft } from '../../store/failed-drafts';

// audit round 17 (2026-09-02):export 已删 —— 全仓无 caller(grep 仅此声明本身),
//   NotesView.tsx 用 inline 类型注解(props: { note: ...; onSave: ...; ... })而不是
//   引用本 interface。改为非 export 即可。
interface StandaloneNoteEditorCoreProps {
  /** 当前笔记(id 变化时 Core 拉取新 body/title)。 */
  note: StandaloneNote | null;
  /** 落盘回调 —— owner 接到 body/title 后异步保存,返回 Promise<void>。
   *  Core 内部负责 saveState 状态机:save → saving → saved/error。 */
  onSave: (id: string, body: string, title: string) => Promise<void>;
  /** 标题是否可编辑 — 右列默认 title 展示不可编辑。 */
  titleEditable: boolean;
  // audit 2026-09-16 audit-r22 — 「先写后命名」流程:创建 / 拖入后光标
  //   应直接落在 body 可打字。父组件 NotesView 在 consume pendingFocusNoteId
  //   且校验 activeNoteFull.id 匹配后传 initialFocus='body',Core 内部
  //   把这个意图透传给 MarkdownEditor(autoFocus + autoFocusToken)。
  //   undefined = 不主动 focus,保持现有行为(普通点击笔记光标不动)。
  //   'title' = focus 标题 input;'body' = focus MarkdownEditor。
  initialFocus?: 'title' | 'body';
}

/**
 * 编辑器主体 —— title + body + save row + autosave。
 * C2R18 防 stale closure:onSave 通过 ref 转发,防抖定时器 fire 时读最新一次
 * render 的版本,确保 paste 触发 markDirty 后定时器拿到新 body。
 */
export function StandaloneNoteEditorCore(props: StandaloneNoteEditorCoreProps) {
  const { note, onSave, titleEditable, initialFocus } = props;
  const { t } = useTranslation();
  const [body, setBody] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  // audit-r133:显示模式 —— false(默认)= 原始文本编辑器;true = 渲染显示(只读)。
  // 不持久化:每次进面板回到「原始文本」,与用户指定的默认语义一致。body 不受
  // 切换影响(Core 持有,autosave / ⌘S / flush 全部照常)。
  const [previewOn, setPreviewOn] = useState(false);
  // audit 2026-09-16 audit-r22 — 透传给 MarkdownEditor 的 autoFocusToken。
  //   每次 initialFocus='body' 且 note.id 变化时 +1,让 MarkdownEditor
  //   重新评估「期望 focus」并调 contentDOM.focus()(详见 MarkdownEditor 的
  //   autoFocus + autoFocusToken 双 prop 注释)。functional updater 自带
  //   latestPrev,无需额外 ref。
  const [bodyAutoFocusToken, setBodyAutoFocusToken] = useState(0);
  // ── 撤销 / 重做 ───────────────────────────────────────────────────────
  // 撤销栈由 CodeMirror 的 history 扩展持有(在 MarkdownEditor 内部),
  // Core 这边只保留两样东西:
  //   editorApi —— 命令式句柄(按钮点它);
  //   canUndo/canRedo —— 按钮的 enabled 态(编辑器只在**翻转**时上报)。
  // 「能不能撤」不进 React 状态的地方是性能关键:每次击键都 setState
  // 会把整个编辑器头栏重渲一遍(perf r247 的教训)。
  const editorApiRef = useRef<MarkdownEditorApi | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const handleHistoryChange = useCallback((flags: { canUndo: boolean; canRedo: boolean }) => {
    setCanUndo(flags.canUndo);
    setCanRedo(flags.canRedo);
  }, []);
  // 文档身份 token —— 换笔记(=换一篇文档)时 +1,编辑器据此重建 state、
  // 把撤销栈清零(否则「撤销」会撤掉**上一篇**笔记的字,还会被 autosave
  // 写进新笔记 ⇒ 跨笔记污染正文)。只在「正文确实被换成另一篇」时 +1:
  // id 漂移 / 搬移分支里正文不动(用户还在接着写),那里**不能**加 ——
  // 加了会把用户正在写的这篇的撤销栈也清掉。
  const [bodyDocToken, setBodyDocToken] = useState(0);
  // 标题 input ref —— initialFocus='title' 时 focus 用
  const titleInputRef = useRef<HTMLInputElement>(null);
  // 防抖 autosave 定时器
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 记录当前正在编辑的 note.id,切换笔记时冲刷旧那篇
  const prevIdRef = useRef<string | null>(null);
  // r192:记录上一篇笔记的 relPath —— 用来区分「切到另一篇笔记」与
  //   「**同一篇**笔记的 id 被主进程重钉了」(见下面 effect 的 idDrift 判定)。
  const prevRelPathRef = useRef<string | null>(null);
  // onSave ref —— C2R18:定时器 fire 时读最新一次 render 的版本
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  // 当前 note ref —— Cmd+S 守卫用,⌘S handler 在 effect deps=[] 下需读到最新 note
  const noteRef = useRef(note);
  noteRef.current = note;
  // doSave 闭包读最新 body/title —— markDirty 触发 doSave 后立即取最新值
  const doSaveRef = useRef<(() => Promise<void>) | null>(null);
  // saveState 镜像 ref —— re-entry 守卫用,避免在 useCallback 闭包里捕获
  // 旧 saveState。state 与 ref 双轨:state 触发渲染,ref 同步读。
  const saveStateRef = useRef<SaveState>('idle');
  saveStateRef.current = saveState;
  // audit 2026-10-01:MEDIUM — 把「是否正在保存」从 saveState 里拆出来。
  //
  //   旧实现拿 saveStateRef.current === 'saving' 当 doSave 的重入守卫,但
  //   markDirty 会无条件 setSaveState('dirty')。于是保存飞行期间用户敲一下键
  //   → state 变 'dirty' → 守卫失效。两个后果:
  //     1) 飞行中的 onSave resolve 后执行 setSaveState('saved'),把 markDirty
  //        刚标的 'dirty' 盖掉 → UI 显示「已保存」,而磁盘上仍是上一次的内容,
  //        用户以为改动已落盘(实际要等下一次击键才补存)。
  //     2) 磁盘慢 / body 大时,autosave(1500ms)在保存未完成时就 fire,守卫已
  //        失效 → 两次 writeNote IPC 并发在途,后写可能拿到旧 body。
  //
  //   拆成两个独立信号:
  //     - savingRef:只管重入,doSave 独占写(进入 true / finally 复位)
  //     - pendingDirtyRef:保存期间又编辑过 —— 保存完成时据此决定标 'saved'
  //       还是回 'dirty' 并补排一次 autosave
  const savingRef = useRef(false);
  const pendingDirtyRef = useRef(false);
  // 切到新 note 时把磁盘内容拉到本地态
  // 重要:flush 旧笔记时必须用「旧 id + 当前 body/title」(本 effect 闭包里的
  // body/title 仍是旧值,setBody 还没跑)。直接走 doSaveRef 会读到 NEW note.id,
  // 等于把旧内容覆盖到新笔记 —— 切页前最后一段修改全丢。
  useEffect(() => {
    const prevId = prevIdRef.current;
    const prevRelPath = prevRelPathRef.current;
    // r192:id 漂移 ≠ 切笔记 ——
    //   主进程保存时会把 frontmatter id 重钉为「当前 relPath 的哈希」
    //   (standalone.ts 副本重映射规则),当磁盘上的 fm.id 与路径哈希不一致
    //   (用户在资源管理器里改过文件名 / 从别的机器拷来的 .md / 手改过
    //   frontmatter)就会发生 ⇒ 同一个**文件**换了 id。
    //
    //   旧实现把它当成「切到另一篇笔记」,两个后果都是丢字:
    //     1. 用**已死**的旧 id 去 flush(主进程已删掉旧 byId 键)⇒ 必撞
    //        NOT_FOUND ⇒ 正文只进 failedDrafts(旧 id 键)⇒ 再也读不回来;
    //     2. setBody(note.body) 把用户在保存之后新敲的字**擦掉**。
    //   判据用 relPath(同一个文件 = 同一个 relPath),不用 id。
    const idDrift =
      prevId !== null &&
      prevId !== note?.id &&
      prevRelPath !== null &&
      prevRelPath === note?.relPath;
    // audit 2026-10-21(P0 数据丢失):「文件被搬走/改名」与「保存时 id 漂移」
    //   是**两件不同的事**,但都会让 note?.id 变:
    //     - 漂移(r192):同一个 relPath、同一个文件,只是 id 被主进程重钉
    //       ⇒ 不 flush(旧 id 已死),靠防抖 autosave 用新 id 落盘;
    //     - 搬移/改名:relPath 变了(文件真的搬了)⇒ 旧 id 在主进程是**死键**
    //       (applyNoteIdSwap 里 byId.delete(oldId))⇒ 必须按**新 id** flush。
    //       按旧 id 写必撞 NOT_FOUND ⇒ 内容只进 failedDrafts(旧 id 键)⇒
    //       而笔记现在的新 id 取不到那份草稿 ⇒ 这段字永久消失。
    //   判据 = store 登记的旧→新 id 映射(见 lib/note-id-remap.ts):登记过 ⇒
    //   旧 id 有继任者 ⇒ 按新 id 落盘。
    const remappedTo = prevId ? resolveNoteId(prevId) : null;
    const idRemapped = remappedTo !== null && remappedTo !== prevId;
    if (prevId && prevId !== note?.id && !idDrift) {
      // 落点:被搬走/改过名 ⇒ 新 id(旧 id 是主进程死键);否则照旧旧 id
      //   (切笔记场景 —— 旧笔记还活着,内容该写回它)。
      const flushId = idRemapped && remappedTo ? remappedTo : prevId;
      // audit 2026-09-07:flush 触发条件从 `saveTimerRef.current` 改成
      //   `saveTimerRef.current || saveStateRef.current === 'dirty'` —— 原
      //   写法漏掉了 debounce 已 fire 但用户又打了几个字符的情况:定时器到点
      //   跑了 doSave(拿到旧 body 落盘),saveTimerRef 被清;紧接着用户继续打
      //   字 markDirty,saveState 变 dirty 但 saveTimerRef 是 null。切笔记时
      //   effect 看到 saveTimerRef=null 直接跳过 flush → 本段最后几个 keystroke
      //   静默丢失(id 已切到新笔记,body/title 又会被新笔记覆盖)。
      // 用 dirty 兜底 + onSaveRef 走"切换前的最新值",确保切走前任何未落盘
      // 的修改都能落盘。
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (hasUnflushedContent(saveStateRef.current)) {
        // 显式传旧 id —— body/title 走 effect 闭包(旧笔记的最新内容)。
        // audit 2026-09-11:补 .catch —— 切换前 flush 与 unmount flush 同等地位,
        //   但旧实现 line 90 走 `void onSaveRef.current?.(...)` 不挂 catch,
        //   IPC 失败(doSave re-throw)在用户视角完全静默,最后一段 keystroke 丢失
        //   且无 trace。修:与 unmount flush 同款 catch + log.error,与 C3R89
        //   convention lock 对齐(禁止直调 console.*)。
        // audit r28 (2026-09-21):skip 已删笔记 —— `note=null` 场景(chokidar
        //   unlink 触发 NOTES_CHANGED → store 清 activeNoteFull)会让本 effect
        //   跑,但 prevId 仍指着已被 chokidar 删除的旧笔记。直接 flush →
        //   writeNote(NOT_FOUND) → 误导 toast「保存失败」。修法:flush 前查
        //   useNotesStore.notes 还有没有 prevId,有再走 save,没有就放弃。
        // 「还在不在」按**落点 id** 判 —— 搬移场景下旧 id 已经被从列表里换掉
        //   (applyMoveRemapImpl 把 notes[] 的 id 一起换),新 id 还在 ⇒
        //   拿旧 id 判会误判成「笔记被删了」⇒ 跳过 flush ⇒ 丢字。
        const stillExists = useNotesStore.getState().notes.some((n) => n.id === flushId);
        if (stillExists) {
          const flushP = onSaveRef.current?.(flushId, body, title);
          if (flushP) {
            // audit 2026-10-05:必须用 then(成功,失败) 两条支路,**不能**写成
            //   `.catch(留草稿).then(清草稿)` —— catch 之后的 then 对两种结局
            //   都会跑,草稿刚存进去就被同一条链删掉(第一版就是这么写错的,
            //   被本轮新增的草稿恢复用例当场抓住)。
            //
            // audit 2026-10-08 (MEDIUM):flush 失败的 setSaveState 移除
            //   —— 旧 `setSaveState((s) => s==='saved' ? 'error' : s)` 在
            //   异步 then 里跑,此时 effect 已经因 note 切换把 saveState 重置
            //   成新笔记的状态。setSaveState('error') 会污染**新笔记**的
            //   saveState,UI 上"已保存"badge 突然变红,误导。
            //   失败信号完全由 failedDrafts 持有:下次选中 prevId 那条笔记
            //   时(line 215-219)读到草稿并把 saveState 设为 'error' 才是
            //   正确时机。这里不直接 setSaveState,让失败语义只体现在
            //   failedDrafts 与 log,不抢正在编辑的新笔记的状态机。
            Promise.resolve(flushP).then(
              () => {
                // 补存成功 → 草稿作废(否则它会一直覆盖磁盘上的正确内容)
                clearFailedDraft(flushId);
              },
              (err: unknown) => {
                log.error('flush on note switch failed', err);
                // 失败必须**留草稿**,否则这段字就此消失 —— 见 failedDrafts
                // 声明处的完整推演。
                // 草稿键 = **落点 id**(搬移/改名后是新 id)⇒ 重新打开这篇
                //   笔记时能取回来(按旧 id 存的话永远取不到 ⇒ 永久丢字)。
                putFailedDraft(flushId, { body, title });
              },
            );
          }
        } else {
          log.warn('skip flush: note deleted between edit and switch', prevId);
        }
      }
    }
    if (note) {
      if (idDrift || idRemapped) {
        // r192:同一个文件、只是 id 被主进程重钉了 ⇒
        //   - 本地正文 / 标题**保持不动**(用户在保存后新敲的字不能被擦);
        //   - saveState 也**不动**(可能已是 'dirty' —— 保存期间又敲了字);
        //   - 防抖 autosave 定时器**不取消** —— 它要用**新 id** 把这些新字
        //     落盘(doSave 读 noteRef.current.id,此刻已是新 id);
        //   - 旧 id 的失败草稿作废(内容已落盘,草稿是更旧的版本)。
        //
        // audit 2026-10-21(P0):idRemapped(文件被搬走/改名)走**同一分支** ——
        //   理由相同:note.body 是搬移**前**的快照,setBody(note.body) 会把
        //   用户搬移前敲的、还没落盘的字**直接擦掉**。内容虽然已经在上面的
        //   flush 里按新 id 写出去了,但本地态一旦回滚,用户下一次敲键 +
        //   autosave 就会拿「回滚后的旧正文」覆盖磁盘 ⇒ 刚存进去的字又没了。
        if (prevId) clearFailedDraft(prevId);
      } else {
        // audit 2026-10-05:优先用「上次保存失败的草稿」覆盖磁盘内容。
        // 不这么做的话,切回一篇保存失败的笔记会读到**上一次**的磁盘内容,
        // 用户在界面上看不到自己刚写的东西,也没有任何提示它曾经存在。
        // 保持 'error' 而不是 'saved' —— 草稿还没落盘,谎报「已保存」正是本
        // 次要修的那个问题。用户下一次 ⌘S / autosave 会重试落盘并自愈。
        const draft = getFailedDraft(note.id);
        if (draft) {
          setBody(draft.body);
          setTitle(draft.title);
          setSaveState('error');
        } else {
          setBody(note.body);
          setTitle(note.title ?? '');
          setSaveState('saved');
        }
        // 换了一篇文档 ⇒ 撤销栈清零(编辑器按 token 重建 state)。
        // 同时把按钮的 enabled 态归零 —— 新文档还没有可撤的编辑。
        setBodyDocToken((n) => n + 1);
        setCanUndo(false);
        setCanRedo(false);
        if (saveTimerRef.current) {
          clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
        }
      }
    }
    prevIdRef.current = note?.id ?? null;
    prevRelPathRef.current = note?.relPath ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note?.id]);
  // audit 2026-09-16 audit-r22 — 切到新笔记且父组件明确要求 focus 时
  //   调对应 input 的 focus:
  //   - 'title' → titleInputRef.focus() —— 已有 titleEditable 时直接聚焦
  //   - 'body' → bodyAutoFocusTokenRef + setBodyAutoFocusToken → MarkdownEditor
  //     通过 autoFocus + autoFocusToken 双 prop 触发 contentDOM.focus()
  //   deps 包含 note?.id 与 initialFocus:笔记切换 / 父组件切换意图时重跑。
  //   注意:initialFocus=undefined 时 effect 提前 return,不主动 focus,
  //   保持现有「普通点击笔记光标不动」的行为。
  useEffect(() => {
    if (!note || !initialFocus) return;
    if (initialFocus === 'title') {
      titleInputRef.current?.focus();
      return;
    }
    // 'body' — audit-r133:focus body 的意图(新建 / 拖入后直接打字)要求
    //   编辑器在场;若上次留在「渲染显示」,先切回原始文本再走 focus token,
    //   否则光标丢失(渲染视图只读,MarkdownEditor 根本未 mount)。
    setPreviewOn(false);
    setBodyAutoFocusToken((prev) => prev + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note?.id, initialFocus]);
  // 卸载清掉定时器
  // audit 2026-09-10:卸载前 flush 未落盘的内容 —— 旧实现只 clearTimeout,
  //   关闭 NotesPanel(WorkbenchContentPanel.closePanel → notes.select(null)
  //   → NotesView → Core 整条链 unmount;2026-10-18 解耦后 closePanel 只清
  //   selectedId,不再 setActive)时若有未到 debounce 点的修改 + dirty
  //   状态,最后一段 keystroke 静默丢失。改用 fire-and-forget flush:走
  //   onSaveRef(闭包最新版本)+ 读 body/title ref(避免卸载时 React state
  //   已不可靠)。注意:这是卸载路径上的"最后一次尽力保存",失败也无 UI
  //   反馈可走(组件已 unmount);错误会走 IPC 层 wrap.ts 日志,事后排查用。
  //   onSave 本身返回 Promise<void>,这里 .catch 吞掉。
  const bodyRef = useRef(body);
  bodyRef.current = body;
  const titleRef = useRef(title);
  titleRef.current = title;
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      // audit 2026-10-21(P0):卸载时也要按**新 id** 落盘 —— 笔记被搬走/改名
      //   后旧 id 已是主进程死键(按旧 id 写必撞 NOT_FOUND ⇒ 内容进不了
      //   可取回的草稿 ⇒ 永久丢字)。见 lib/note-id-remap.ts。
      const prevFinalId = prevIdRef.current;
      const finalId = prevFinalId ? resolveNoteId(prevFinalId) : prevFinalId;
      // dirty / saving 都视为"有未落盘内容" —— 卸载时不等 debounce 兜底
      // dirty / saving / error 都视为"有未落盘内容" —— 卸载时不等 debounce 兜底。
      // audit 2026-10-04 (P0):补 'error'。保存失败时状态是 'error',旧条件
      //   (dirty|saving)不匹配 ⇒ 卸载不 flush ⇒ 失败的那段内容直接消失。
      if (finalId && hasUnflushedContent(saveStateRef.current)) {
        // audit 2026-09-10:沉默吞错升级为 log.error —— 用户在关 tab 瞬间
        //   最后一次自动保存如果 IPC 失败,静默吞掉意味着用户丢字且无任何 trace。
        //   renderer 主进程日志里看不到任何错误,debug 极困难。保留 trace,
        //   但不弹 toast(卸载阶段 React 已卸载,弹了也是悬挂 DOM)。
        // 必须走 createLogger —— C3R89 convention lock 禁止 renderer 直调 console.*。
        // audit 2026-09-14:Promise.resolve(...) 包裹 —— onSaveRef.current?.(...) 可能
        //   返回 undefined(unmount 时 handler 已 null),undefined.catch() 同步抛
        //   TypeError。Promise.resolve 兜住 undefined/undefined.then 情况,统一进 catch。
        // audit 2026-10-05:卸载路径同样要留草稿。关面板 → 重开是本项目最常见
        // 的「保存失败后内容消失」触发路径,而组件卸载后 ref 全部失效 ——
        // 所以草稿存在模块级缓冲里(见 failedDrafts 声明)。
        // 同上:两条支路用 then(成功,失败),不能串 catch→then。
        Promise.resolve(onSaveRef.current?.(finalId, bodyRef.current, titleRef.current)).then(
          () => clearFailedDraft(finalId),
          (err: unknown) => {
            log.error('flush on unmount failed', err);
            putFailedDraft(finalId, { body: bodyRef.current, title: titleRef.current });
          },
        );
      }
    };
  }, []);
  // 立即保存
  // audit 2026-09-07:加 saveState==='saving' re-entry 守卫 —— 同一实例并发
  // 触发(⌘S + autosave timer 同时 fire)只跑一次,避免后写覆盖前写 + 多 toast。
  // audit 2026-09-21 audit-r24 perf:deps 收敛到 [note?.id] + 内部读 bodyRef/
  //   titleRef/onSaveRef —— 原 [note, body, title, onSave] 让 body/title 每按键
  //   变就重建 doSave,handleSave (NotesView) 接的是 ref 看不到重建,但闭包
  //   自身重分配 + 任何 inline 调用方拿到的 doSave 引用都不稳定(perf 噪声)。
  //   与同模块 markDirty (deps=[] + noteRef) 同款 pattern。
  const doSave = useCallback(async () => {
    const currentNote = noteRef.current;
    if (!currentNote) return;
    // 已经在 saving 中,本次不入队 —— 静默 no-op(已经在落盘了)。
    // 错误态允许重试(用户改完后想再保存)。
    //
    // audit 2026-10-01:守卫改用独立的 savingRef,不再借 saveState —— 后者会被
    //   markDirty 的 setSaveState('dirty') 击穿,见 savingRef 声明处注释。
    if (savingRef.current) return;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    savingRef.current = true;
    // 本次保存要落的就是此刻的 body/title,先清 pending 标记。
    pendingDirtyRef.current = false;
    setSaveState('saving');
    setBusy(true);
    try {
      await onSaveRef.current(currentNote.id, bodyRef.current, titleRef.current);
      // 落盘成功 → 这篇笔记的草稿作废(否则它会一直覆盖磁盘上的正确内容)
      clearFailedDraft(currentNote.id);
      // 保存期间又编辑过 → 不能标 'saved'(那会骗用户「已保存」,而磁盘上
      // 还是上一次的内容)。保持 dirty,并补排一次 autosave 保证最终落盘:
      // 正常情况下 markDirty 已经重排过 timer,但若它 fire 时守卫生效而
      // 早退(slow disk),那次排程就没了,这里兜住。
      if (pendingDirtyRef.current) {
        setSaveState('dirty');
        armAutosaveRef.current();
      } else {
        setSaveState('saved');
      }
    } catch (err) {
      // audit 2026-09-07:re-throw 让 NotesView 拿到 → 单点 toast;这里只管
      //   设置 saveState 指示 + 记错误日志(带 stack)。统一一次 log + 一次 toast。
      log.error('StandaloneNoteEditorCore onSave failed', err);
      // audit 2026-10-08 (LOW):失败 body/title 暂存 failedDrafts —— 原实现
      //   只 setSaveState('error') + throw,NotesView toast「保存失败」,但内存里
      //   的当前内容**没有落盘**,用户若切走/卸载就丢字。store/notes.ts:save
      //   的 IPC 抛错(IO_ERROR / IPC_REJECTED / EACCES 等)已经把内容留在
      //   store 之外的本地态里,这里把 bodyRef/titleRef 快照进 putFailedDraft,
      //   下次选中同一笔记(甚至重开应用)时优先用草稿覆盖磁盘内容,见
      //   failed-drafts.ts 头注的完整推演。CONFLICT 不算"丢字" —— 用户的字
      //   仍在内存里,需要他去 reload 取磁盘最新版,塞草稿反而误导,所以跳过。
      // audit-r160:用 instanceof IpcError 收窄到 union code —— 旧实现裸读
      //   `(err as { code?: unknown } | null)?.code`,把任何偶然挂 .code 字段
      //   的 unknown 都当 IPC 错误判定;非 IpcError / string / 任何带 .code
      //   的对象都会被误判为「不是 CONFLICT」→ 跳过 putFailedDraft,实际丢字。
      //   与 store/notes.ts save 路径的同款防御(r152 已收口)对齐。
      if (!(err instanceof IpcError && err.code === 'CONFLICT')) {
        putFailedDraft(currentNote.id, { body: bodyRef.current, title: titleRef.current });
      }
      setSaveState('error');
      throw err;
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [note?.id]);
  doSaveRef.current = doSave;
  // 触发 markDirty:本地态变更 + 防抖定时器
  // perf (2026-09-04):useCallback 锁引用 —— MarkdownEditor 已包 React.memo,
  //   markDirty 不稳定会让 Editor 的 onChange prop 每次换引用,memo 失效。
  // audit 2026-09-17 r23 perf M4:deps 改 [] + 内部读 noteRef.current ——
  //   旧 deps=[note] 让 markDirty 在笔记切换(note 引用换)时重建,顺带让
  //   handleEditorChange 重建 → MarkdownEditor memo 失效。改 ref 后 markDirty
  //   稳定,handleEditorChange 稳定,MarkdownEditor memo 命中(同 id 的 autosave
  //   路径上不重渲)。
  const armAutosaveRef = useRef<() => void>(() => {});
  const markDirty = useCallback(() => {
    if (!noteRef.current) return;
    // audit 2026-10-01:飞行中的保存不因这次编辑被「取消」—— 用独立的
    //   pendingDirtyRef 记一笔,而不是把 saveState 从 'saving' 拉回 'dirty'
    //   (那会击穿 doSave 的重入守卫,见 savingRef 声明处注释)。
    //   UI 上此时继续显示 'saving' 其实是准确的:确实有一次保存正在进行。
    if (savingRef.current) {
      pendingDirtyRef.current = true;
    } else {
      setSaveState('dirty');
    }
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      // audit round 13 (2026-09-15):F2 — autosave setTimeout 加 .catch。
      //   doSave 内部 IPC 失败会 rethrow(set saveState='error' 后 throw 给上层,
      //   让 NotesView 弹 toast);但 fire-and-forget `void doSaveRef.current?.()`
      //   不挂 catch,reject 走 unhandledRejection —— saveState 已经标 error,
      //   用户看到红色 "保存失败",但 toast 不弹,无主进程错误反馈。补 catch
      //   + log.error,与 line 99-102 (note-switch flush) + line 147-149
      //   (unmount flush) 同模式(都是 fire-and-forget save 路径)。
      const p = doSaveRef.current?.();
      if (p) p.catch((err: unknown) => log.error('autosave failed', err));
    }, WORKSPACE_LIMITS.NOTES_AUTOSAVE_DEBOUNCE_MS);
  }, []);
  // 抽成稳定 ref,供 doSave 在「保存期间又脏了」时补排一次(见 doSave 内注释)。
  armAutosaveRef.current = () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      const p = doSaveRef.current?.();
      if (p) p.catch((err: unknown) => log.error('autosave (re-armed) failed', err));
    }, WORKSPACE_LIMITS.NOTES_AUTOSAVE_DEBOUNCE_MS);
  };

  // 监听全局 ⌘S —— actions.ts 调 useWorkspaceStore.requestSaveActiveNote(),
  // 派 pendingSaveActiveNote.version tick。Core 订阅该 tick,触发 save
  // (持有最新 body/title + doSaveRef)。仅在有 note 时响应(无选中笔记 ⌘S
  // 不应报错)。
  // 重构 (2026-09-17 v2.0 Phase 1b):原 WORKBENCH_EVENT.SaveActiveNote CustomEvent
  //   → pendingSaveActiveNote store flag,与 pendingNewNote / pendingRenameNote
  //   / pendingFocusNote 同款路径(见 store/pendingCommand.ts)。
  // audit 2026-09-07:加 saveState==='saving' 守卫 —— ⌘S 在 save 已 in-flight 时
  //   不应再排一次 save。doSave 内部本身有 setTimeout 清,理论上去重,但 saveState
  //   是用户可见指示符,避免 ⌘S 期间 spinner 闪烁 + 重复 toast 风险。
  // 同时:不依赖闭包 note —— 用 saveStateRef + 通过 store 读最新选中 id,
  //   闭包 note 可能是 stale(切笔记 race 期间)。
  const _saveActiveTick = useWorkspaceStore((s) => s.pendingSaveActiveNote.version);
  useEffect(() => {
    // 同 store flag 模式:多 Core 实例挂载时,所有 effect 都跑,只有 selectedId
    //   匹配的 Core 才真存(同 audit round 8 ownership 守卫)。StrictMode 双 mount
    //   不会重复落盘,consume() 第一次后 hasPending=false,后续无操作。
    if (!useWorkspaceStore.getState().consumeSaveActiveNoteRequest()) return;
    // ownership 守卫(详见上方 audit round 8)—— 防止旧 note 的 Core 拿"旧
    //   note.id + 新 body/title 闭包"覆盖到旧笔记。
    const currentId = useNotesStore.getState().selectedId;
    if (noteRef.current?.id !== currentId) return;
    // doSaveRef.current 内部已有 `if (!note) return`;⌘S 路径同样走它。
    // 用 ref 不依赖闭包 note —— 切笔记时 ⌘S 必须拿到新 note 的 save。
    // audit round 13 (2026-09-15):F2 — ⌘S 路径加 .catch,与 markDirty
    //   自动保存 timer 路径对齐。NotesView.handleSave 已经包 try/catch + toast
    //   (走主流程),但 ⌘S 直接由 store flag 触发进本 effect,绕开 NotesView,
    //   reject 走 unhandledRejection。
    const p = doSaveRef.current?.();
    if (p) p.catch((err: unknown) => log.error('Cmd+S save failed', err));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [_saveActiveTick]);
  // perf (2026-09-04):稳定 onChange 引用 —— MarkdownEditor 已 React.memo,
  //   inline 箭头每次 render 都换引用会让 memo 失效 → 每次击键都触发 Editor
  //   整棵 reconcile。useCallback 锁引用,只有 markDirty / setBody 真正变才让
  //   memo 真的失效(setBody 是 useState setter,身份稳定;markDirty 已
  //   useCallback,只在 note 变化时换)。
  const handleEditorChange = useCallback(
    (v: string) => {
      setBody(v);
      markDirty();
    },
    [markDirty],
  );
  return (
    <>
      {/* V1.5 (audit fix #10):chrome 收紧到 px-4 py-2(原 px-5 pt-4 pb-3 太松,跟
          全站 chrome 节奏对不齐)。title 是编辑器头不是面板头,不加 uppercase。 */}
      <div className="px-4 py-2 border-b border-border-subtle">
        <div className="flex items-center gap-2">
          <Input
            ref={titleInputRef}
            value={title}
            onChange={(v) => {
              setTitle(v);
              markDirty();
            }}
            placeholder={t('notes.placeholderTitle')}
            aria-label={t('common.noteTitleAria')}
            // audit round 17 (2026-09-15):A11Y-M6 — 标题 input 挂 aria-describedby
            //   指向 sr-only hint,告知 SR 用户「保存时自动追加 .md 扩展名」——
            //   用户看不到 footer 提示时(SR / 高倍 zoom / 屏宽窄)仍能知道系统行为。
            aria-describedby="title-md-hint"
            readOnly={!titleEditable}
            className="flex-1"
            variant="ghost"
            inputClassName="py-0.5 text-base font-semibold"
          />
          {/* audit round 17 (2026-09-15):A11Y-M6 — sr-only hint。视觉无变化,
              与 input aria-describedby="title-md-hint" 配对;上方 placeholder
              只在空态可见,SR 用户用 placeholder 也读不到(浏览器 placeholder
              行为不一致),所以单独挂 hint。 */}
          <span id="title-md-hint" className="sr-only">
            {t('notes.saveExtensionHint')}
          </span>
          {/* audit 2026-09-21 audit-r24 — 条件挂载 + key 重 mount。
              原实现单一 span role=alert 永远 mount,初始 saveState='saved' 导致
              SR 切到任意笔记 mount 时立刻朗读"已保存",但这不是事件,是初始
              状态 — 误导 SR 用户以为刚发生过保存。
              拆分条件渲染:
              - saved 走 role=status + aria-live=polite(SR 不强制 mount 朗读,
                只在内容变化时温和公告,不再 mount 误播)
              - error 走 role=alert + aria-live=assertive(真正事件需要打断)
              - dirty / saving / idle 也挂载(占位保持布局稳定,w-20 宽度不变),
                走 role=status + aria-live=off(纯视觉指示,SR 不朗读)
              - key={saveState} 让每次状态变化时 React 重 mount 节点,SR 重新
                朗读一次(避免 SR 对"同 id 同内容"跳过公告的浏览器优化)。 */}
          <span
            key={saveState}
            role={saveState === 'error' ? 'alert' : 'status'}
            aria-live={saveState === 'error' ? 'assertive' : 'polite'}
            aria-atomic="true"
            className={clsx(
              'inline-flex items-center gap-1 text-2xs tabular-nums w-20 justify-end',
              saveState === 'saved' && 'text-fg-tertiary',
              saveState === 'dirty' && 'text-warning',
              saveState === 'saving' && 'text-fg-tertiary',
              saveState === 'error' && 'text-danger',
            )}
          >
            {/* audit round 9 (2026-09-15):为 dirty / error 加视觉图标 —— 原
                实现只在 saved / saving 有 Check + Loader2,dirty / error 只
                靠文字("未保存" / "保存失败")和颜色区分。色弱用户难以区分
                warning(黄)与 danger(红)两态色差,加图标后 5 态全部视觉可
                区分:Pencil=未保存、Loader2=保存中、Check=已保存、
                AlertCircle=失败、idle 无图标。 */}
            {saveState === 'saving' && (
              <Loader2 size={10} className="animate-spin" aria-hidden="true" />
            )}
            {saveState === 'saved' && <Check size={10} aria-hidden="true" />}
            {saveState === 'dirty' && <Pencil size={10} aria-hidden="true" />}
            {saveState === 'error' && <AlertCircle size={10} aria-hidden="true" />}
            {saveState === 'dirty' && t('notes.saveDirty')}
            {saveState === 'saving' && t('notes.saveSaving')}
            {saveState === 'saved' && t('notes.saveIdle')}
            {saveState === 'error' && t('notes.saveError')}
            {saveState === 'idle' && t('notes.saveIdle')}
          </span>
          <Button
            onClick={() => {
              // audit 2026-10-04 (P0):原来是 `void doSave()` —— doSave 在保存
              //   失败时会 re-throw(让上层置 error 态),裸 void 会把它变成
              //   unhandledRejection。autosave / ⌘S / 两处 flush 的调用点都挂了
              //   .catch,唯独这个按钮没有。补上,与它们同模式。
              void doSave().catch((err: unknown) => log.error('manual save failed', err));
            }}
            variant="primary"
            size="sm"
            // audit-r145d (2026-10-19) MED:Button.loading 接入 —— 同 r145d
            //   NotesView rename 拆分逻辑:loading={busy} 给原语处理 spinner
            //   + aria-busy(保存跑期间视觉反馈,避免用户连点);disabled 留
            //   纯表单校验 (saveState==='saved' 表示刚保存完,按钮短暂禁用
            //   防双写,与 IPC 无关)。
            loading={busy}
            disabled={saveState === 'saved'}
          >
            <Save size={12} aria-hidden="true" /> {t('common.save')}
          </Button>
          {/* 撤销 / 重做 —— 驱动 CodeMirror 的 history。
              按钮 enabled 态来自编辑器上报(canUndo/canRedo),不是 Core 自己
              算的 —— Core 不知道栈里还剩几步。
              「渲染显示」模式下编辑器未挂载 ⇒ 一律禁用(那儿没有可撤的编辑)。 */}
          <Button
            variant="ghost"
            size="sm"
            data-testid="note-undo"
            disabled={!canUndo || previewOn}
            aria-label={t('notes.undo')}
            title={t('notes.undo')}
            onClick={() => editorApiRef.current?.undo()}
          >
            <Undo2 size={12} aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            data-testid="note-redo"
            disabled={!canRedo || previewOn}
            aria-label={t('notes.redo')}
            title={t('notes.redo')}
            onClick={() => editorApiRef.current?.redo()}
          >
            <Redo2 size={12} aria-hidden="true" />
          </Button>
          {/* audit-r133:原始文本 ↔ 渲染显示 toggle。默认在源码侧,按一次进
              只读渲染视图,再按切回;body / saveState 全程不经切换(锁在
              editor-preview-toggle.test.tsx)。 */}
          <Button
            variant="ghost"
            size="sm"
            data-testid="note-mode-toggle"
            onClick={() => setPreviewOn((v) => !v)}
            aria-label={previewOn ? t('notes.modeSourceAria') : t('notes.modePreviewAria')}
            title={previewOn ? t('notes.modeSourceAria') : t('notes.modePreviewAria')}
          >
            {previewOn ? (
              <Code size={12} aria-hidden="true" />
            ) : (
              <Eye size={12} aria-hidden="true" />
            )}
          </Button>
        </div>
      </div>
      {/* 编辑器主体 —— audit-r133 双模式互斥(不是分屏):
          previewOn=false 默认原始文本编辑器;true 走只读渲染视图。
          flex-col 是 MarkdownReader(flex-1 overflow-auto)的撑高前提;
          MarkdownEditor 的 h-full 在此布局下与块级父解析结果一致。 */}
      <div className="flex-1 min-h-0 overflow-hidden bg-bg flex flex-col">
        {previewOn ? (
          <Suspense
            fallback={
              <div aria-busy="true" className="p-4">
                <SkeletonLines rows={6} />
              </div>
            }
          >
            <MarkdownReader source={body} filename={note?.filename ?? ''} />
          </Suspense>
        ) : (
          <MarkdownEditor
            value={body}
            onChange={handleEditorChange}
            // audit 2026-09-16 audit-r22 — body autoFocus 透传
            autoFocus={initialFocus === 'body'}
            autoFocusToken={bodyAutoFocusToken}
            // 撤销/重做:文档身份 token + 能力上报 + 命令式句柄
            docToken={bodyDocToken}
            onHistoryChange={handleHistoryChange}
            apiRef={editorApiRef}
          />
        )}
      </div>
    </>
  );
}
