// CodeMirror 6 Markdown 编辑器 —— 原始文本(源码)显示
//
// 形态(audit-r133 改版):回退 2026-09-06 的 Typora 式「所见即所得」——
// 装饰层自动隐藏非活动行的 ## / ** / --- 等标记,光标移动时符号忽隐忽现、
// 内容跳动,且 GFM 表格 / 任务列表根本没有装饰,「既不是源码也不是渲染」,
// 用户报障「显示存在很大问题」。现在默认**只显示原始文本**:doc 是什么
// 就显示什么,无任何标记隐藏;「渲染显示」由父组件(StandaloneNoteEditorCore)
// 的头栏 toggle 切到 reader/MarkdownReader(markdown-it 真渲染,只读)。
// 装饰层 markdown-live-preview.ts 连同其单测已整体删除。
// 行号 / 活动行高亮同样没有 —— 排版只保留可读性基础(等宽 / 居中栏 / 行距)。
//
// perf(2026-08-21):codemirror 模块(state / view / commands / lang-markdown)
// 全部改为动态 import — NotesView chunk 不再带 codemirror(~180KB)。
// mount 时并行拉依赖,初始化一次;卸载 destroy() 释放。
//
// polish(2026-08-25):codemirror chunk 加载完成前父 div 不再是空块 ——
// 渲染 6 行 SkeletonLines 占位,既保留 h-full(避免父容器塌缩)又让用户
// 视觉上有"马上看到内容"的预期。ready 一到 setReady(true) 立刻移除。
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLatestValue } from '../../hooks/useLatestValue';
import { SkeletonLines } from '../ui/Skeleton';
import { createLogger } from '../../lib/logger-client';
import { errMsg } from '../../lib/error';

const log = createLogger('MarkdownEditor');

// 类型侧:codemirror 的类型只出现在**类型位置**(`import(...)` 类型查询),
// 编译期即被完全擦除 —— 与文件头「运行时代码一律动态 import」的约定一致,
// 不会把 codemirror 拖进主 chunk。
type CMState = import('@codemirror/state').EditorState;
type CMExtension = import('@codemirror/state').Extension;
type CMView = import('@codemirror/view').EditorView;
type CMCommands = typeof import('@codemirror/commands');

/**
 * 命令式句柄 —— 父级(StandaloneNoteEditorCore)工具栏的「撤销 / 重做」按钮
 * 通过它驱动 CodeMirror 的 history。
 *
 * 为什么不让父级直接操作编辑器实例:CodeMirror 的 view 只存在于
 * MarkdownEditor 内部(动态 import 之后才建出来),父级拿不到也拿不稳。
 * 这里把「撤销 / 重做 / 能不能撤」三个动作收敛成一个窄接口,
 * 父级只管按钮的 enabled 态与点击。
 */
export interface MarkdownEditorApi {
  /** 撤销一步。 */
  undo: () => void;
  /** 重做一步。 */
  redo: () => void;
  /** 当前是否可撤销。 */
  canUndo: () => boolean;
  /** 当前是否可重做。 */
  canRedo: () => boolean;
}

/** 撤销栈的能力位 —— 只在**翻转**时向上抛,避免每次击键都 setState。 */
export interface EditorHistoryFlags {
  canUndo: boolean;
  canRedo: boolean;
}

// perf (2026-09-04):React.memo —— StandaloneNoteEditorCore 父级重渲(autosave
//   状态 / title input 任意变化)时,Memo 后的 Editor 不参与 reconcile。Editor
//   内部已有 useEffect [value] 处理 value → view 同步,父级其它 state 变化不应
//   触发 Editor render。onChange 通过 onChangeRef 拿最新引用,父级不传 inline
//   箭头也能正常工作。
//
// audit 2026-09-16 audit-r22 — 加 autoFocus + autoFocusToken(2 个 prop 联动)
//   「先写后命名」流程要求:创建 / 拖入 / 重命名后光标立刻落到 body 可直接打字。
//   autoFocus: 期望聚焦(切到新笔记时为 true)
//   autoFocusToken: 数字 token,每次「期望重新 focus」+1,触发 re-check。
//     view 是异步 chunk 解析后才创建([MarkdownEditor]:lines:75-155),只传
//     autoFocus=true 不够:异步加载期间父组件已切到别的笔记,view 创建时闭包
//     拿到 mount 时的 autoFocus=旧的 true / false,无法重新评估「现在该
//     重新 focus 吗」。用 token + useLatestValue 双轨,token 变化时 effect
//     重跑,view 已就绪则 contentDOM.focus()。
//   autoFocus 单 prop 已能 cover「mount 时立刻 focus」场景(view 创建完后
//   读 latestFocus 决定),但「同 Editor 实例后续 token 变化 → 再 focus」
//   必须有第二个 effect deps = [autoFocusToken] 才触发。
export const MarkdownEditor = memo(function MarkdownEditor({
  value,
  onChange,
  autoFocus,
  autoFocusToken,
  docToken,
  onHistoryChange,
  apiRef,
}: {
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
  autoFocusToken?: number;
  /**
   * 文档身份 token —— 变化表示「换了一篇文档」(切笔记)。
   *
   * 换文档必须**清空撤销栈**:CodeMirror 的 history 是挂在 EditorState
   * 上的,切笔记只是把正文整段替换掉,旧笔记的编辑事件仍留在栈里 ⇒
   * 用户在新笔记里按「撤销」会撤销掉**上一篇**笔记的编辑(还会被 autosave
   * 写进新笔记 —— 跨笔记污染正文)。
   *
   * 有 token 时,token 变化走 setState 重建(撤销栈天然归零);
   * 不传 token(旧调用方 / 纯文本场景)时行为不变。
   */
  docToken?: number;
  /**
   * 撤销/重做能力变化回调 —— 仅在 canUndo/canRedo **翻转**时调用。
   * 父级据此禁用/启用工具栏按钮;每次击键都回调会把父级拖进重渲
   * (perf r247 的教训:渲染进程每击键的浪费)。
   */
  onHistoryChange?: (flags: EditorHistoryFlags) => void;
  /** 命令式句柄 —— 父级工具栏按钮调 undo/redo。 */
  apiRef?: { current: MarkdownEditorApi | null };
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  // view 类型来自 codemirror/view 的 EditorView;为避免主 chunk 包含 codemirror
  // 类型,把 viewRef 类型放宽到 unknown,使用侧再做最小化的形状断言
  const viewRef = useRef<unknown>(null);
  const onChangeRef = useLatestValue(onChange);
  // ── 撤销/重做(CodeMirror history)─────────────────────────────────────
  // cmRef 存动态 import 到的 @codemirror/commands 模块(undo/redo/undoDepth/
  // redoDepth 都在里面);stateModRef 存 @codemirror/state(Transaction.addToHistory)。
  const cmRef = useRef<CMCommands | null>(null);
  const stateModRef = useRef<typeof import('@codemirror/state') | null>(null);
  // extensions 存一份 —— 换文档时要用它重建 EditorState(见下面的 setState 路径)
  const extensionsRef = useRef<CMExtension[] | null>(null);
  // 已灌进 view 的文档 token(初始化于 view 创建时)
  const appliedTokenRef = useRef<number | undefined>(undefined);
  // 撤销栈当前能力位 —— 只在翻转时向上抛
  const historyFlagsRef = useRef<EditorHistoryFlags>({ canUndo: false, canRedo: false });
  const onHistoryChangeRef = useLatestValue(onHistoryChange);
  // docToken 走 latest —— 异步加载期间父级可能已换文档,重建 state 时要取最新
  const latestDocToken = useLatestValue(docToken);
  // audit r28 (2026-09-21):last-consumed-token —— 区分「同 token 重复 focus」
  //   与「新 token 触发 focus」,避免 a11y skip 逻辑误伤笔记切换。
  const lastConsumedTokenRef = useRef<number>(0);
  // codemirror 异步 chunk 完成前为 true:此时 render Skeleton 占位;
  // EditorView 挂载后立刻 setReady(false) 移除。state 而非 ref —— 触发重渲染。
  // 初始 true:第一次渲染就需要显示占位;ready → false 才会触发 re-render
  // 移除占位(再调 setReady(true) 是 no-op,不会更新)。
  const [ready, setReady] = useState(true);
  // chunk-load 错误状态:不为 null 时渲染空态(替代永久 skeleton),用户能
  // 看到失败原因并报告 bug。不影响 ready 流转 —— 错误态独立展示。
  const [error, setError] = useState<unknown>(null);
  // audit C3R16 (2026-08-22):value 走 useLatestValue 而不是 useRef + 赋值 —
  // async 加载 codemirror 期间(parent 切笔记太快 / 冷启动 chunk 还在拉)若
  // value 已变化,异步 resolve 后必须读最新值。闭包里的 value 是 mount 时
  // 的快照,EditorState.create({ doc: value }) 用旧值 → view 显示旧 body。
  // 用 useLatestValue 后,async resolve 后读 latestValue.current 拿到最新 prop,
  // 立刻 dispatch 同步进 view。详见 useLatestValue.ts。
  const latestValue = useLatestValue(value);
  // perf r247:lastEmittedRef —— 「本编辑器最后一次**自己发出**的正文」。
  //   用途:把「value → view 同步」这条 effect 的 O(n) 比较降成 O(1) 短路。
  //
  //   旧实现在**每次击键**都做两次全文字符串构建:
  //     ① updateListener:onChangeRef.current(u.state.doc.toString())
  //        —— 必需(要把新正文交给上层),但 doc.toString() 是 O(全文长),
  //        10 万字笔记 = 每次击键造一个 10 万字符的字符串;
  //     ② effect [value]:`view.state.doc.toString() !== value` —— 又造一次
  //        同样的全文字符串,只为了回答「doc 是不是已经等于 value?」。
  //   ② 的答案是**几乎恒为「相等」**(value 就是 ① 刚发上去的那份)⇒
  //   整次 O(n) 字符串构建 + 比较纯属浪费。
  //
  //   短路判据:value === lastEmittedRef.current ⇒ 这个 value 就是本编辑器
  //   刚刚自己发出去的 ⇒ doc 里已经是它了 ⇒ 不需要再读一遍 doc。
  //   正确性(为什么不会漏同步):
  //     - doc 只会由两处改变:① 用户输入(updateListener)与 ③ 本 effect 的
  //       dispatch。① 之后 lastEmitted === doc 内容;③ 只在 value 与
  //       lastEmitted **不**相等时才发生 ⇒ 不会把「已是最新」的 doc 改掉。
  //     - 外部换笔记 / 外部改 body ⇒ value 与 lastEmitted 不等 ⇒ 走慢路径
  //       (完整 toString 比较)⇒ 照常 dispatch。
  //     - 唯一「value === lastEmitted 但 doc 不是它」的情形是 ③ dispatch
  //       之后 lastEmitted 尚未更新 —— 此时走慢路径,最多多比一次,
  //       绝不会漏同步(慢路径本身就是「不一致就 dispatch」)。
  const lastEmittedRef = useRef<string | null>(null);
  // audit 2026-09-16 audit-r22 — view 创建是 async chunk 完成后的 callback,
  //   闭包可能 stale,latestFocus.current 拿最新 autoFocus 值;token 变化走
  //   独立 effect deps=[autoFocusToken]。useLatestValue 直接包 boolean,
  //   不再与 token 组合(verify: token 字段仅作 effect deps 触发器,从未读取)。
  const latestFocus = useLatestValue(!!autoFocus);

  // ── 撤销/重做:能力上报 ────────────────────────────────────────────────
  // 每次 CodeMirror 状态变化(updateListener)都算一次当前栈深:
  //   undoDepth / redoDepth 返回的是「可撤销/可重做的**组**数」,
  //   > 0 即按钮可点。
  // 只在**翻转**时回调上游 —— 每次击键都 setState 会把父级拖进重渲
  // (perf r247:渲染进程每击键的浪费)。
  const reportHistory = useCallback(
    (state: CMState, force = false) => {
      const cm = cmRef.current;
      if (!cm) return;
      const canUndo = cm.undoDepth(state) > 0;
      const canRedo = cm.redoDepth(state) > 0;
      const prev = historyFlagsRef.current;
      if (!force && prev.canUndo === canUndo && prev.canRedo === canRedo) return;
      historyFlagsRef.current = { canUndo, canRedo };
      onHistoryChangeRef.current?.({ canUndo, canRedo });
    },
    // onHistoryChangeRef 的 identity 恒定(useLatestValue 返回同一个 ref),
    // 列进 deps 纯粹是让 exhaustive-deps 看到真实依赖(见 useLatestValue 头注)。
    [onHistoryChangeRef],
  );

  // ── 撤销/重做:执行 ────────────────────────────────────────────────────
  // 按钮点击会把焦点从编辑器挪到按钮上 ⇒ 先把焦点还给编辑器,
  // 撤销后的光标位置才看得见(否则正文变了、光标消失,像"没反应")。
  const runHistory = useCallback(
    (kind: 'undo' | 'redo') => {
      const v = viewRef.current as CMView | null;
      const cm = cmRef.current;
      if (!v || !cm) return;
      v.focus?.();
      if (kind === 'undo') cm.undo(v);
      else cm.redo(v);
      // undo/redo 会改 doc ⇒ updateListener 也会上报一次;这里再报一次
      // 兜底「只撤了光标选择、doc 没变」的情况。
      reportHistory(v.state);
    },
    [reportHistory],
  );

  // 命令式句柄 —— 父级工具栏按钮调它。view 是异步建的,句柄先给出去,
  // 调用时若 view 还没就绪就静默 no-op(按钮此时也是禁用态)。
  useEffect(() => {
    if (!apiRef) return;
    const api: MarkdownEditorApi = {
      undo: () => runHistory('undo'),
      redo: () => runHistory('redo'),
      canUndo: () => {
        const v = viewRef.current as CMView | null;
        const cm = cmRef.current;
        return !!v && !!cm && cm.undoDepth(v.state) > 0;
      },
      canRedo: () => {
        const v = viewRef.current as CMView | null;
        const cm = cmRef.current;
        return !!v && !!cm && cm.redoDepth(v.state) > 0;
      },
    };
    apiRef.current = api;
    return () => {
      if (apiRef.current === api) apiRef.current = null;
    };
  }, [apiRef, runHistory]);

  useEffect(() => {
    if (!ref.current) return;
    let disposed = false;
    // view 持有 codemirror EditorView 实例;为避免主 chunk 包含 codemirror
    // 类型,变量类型留 unknown,使用侧做最小化的形状断言。
    let view: unknown = null;
    // 加载错误状态:chunk 加载失败(asar hash 失配 / 网络挂 / 沙箱限制)时
    // setLoadError 让父级 render 错误 UI,而不是永久卡在 Skeleton 占位。
    // 之前无 try/catch,reject 走到 unhandledRejection,用户看到永远 skeleton,
    // 没线索排查。
    const setLoadError = (err: unknown) => {
      log.error('MarkdownEditor: chunk-load failed', err);
      setError(err);
    };

    (async () => {
      try {
        // 并行拉 4 个 codemirror 模块 + lang-markdown + 自家装饰层
        const [stateMod, viewMod, cmdMod, mdMod] = await Promise.all([
          import('@codemirror/state'),
          import('@codemirror/view'),
          import('@codemirror/commands'),
          import('@codemirror/lang-markdown'),
        ]);
        const { EditorState, Transaction } = stateMod;
        const { EditorView, keymap, drawSelection, dropCursor, rectangularSelection } = viewMod;
        const { defaultKeymap, history, historyKeymap, indentWithTab } = cmdMod;
        const { markdown, markdownLanguage } = mdMod;
        // 模块句柄存 ref —— 撤销/重做命令与 Transaction.addToHistory
        // 只在**运行时**用到,放 ref 里不进主 chunk。
        cmRef.current = cmdMod;
        stateModRef.current = stateMod;
        // 原始文本主题 —— 「显示原始文本」本体:无标记隐藏 / 无标题放大 /
        // 无装饰(audit-r133 删除 Typora 装饰层,见文件头注)。只保留可读
        // 排版:等宽、行距、居中正文栏、颜色变量跟随明暗主题。
        const sourceTheme = EditorView.theme({
          '&': { fontSize: '15px', height: '100%', backgroundColor: 'transparent' },
          '&.cm-focused': { outline: 'none' },
          '.cm-scroller': {
            fontFamily:
              '"JetBrains Mono", "SF Mono", Menlo, Monaco, Consolas, "Cascadia Code", monospace',
            lineHeight: '1.7',
            padding: '8px 0 40vh 0',
          },
          '.cm-content': {
            padding: '16px 24px',
            maxWidth: '780px',
            margin: '0 auto',
            width: '100%',
            color: 'rgb(var(--fg-rgb))',
            caretColor: 'rgb(var(--accent-rgb))',
          },
          '.cm-cursor, .cm-dropCursor': {
            borderLeftColor: 'rgb(var(--accent-rgb))',
            borderLeftWidth: '2px',
          },
          '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
            backgroundColor: 'rgb(var(--accent-dim-rgb)) !important',
          },
        });
        if (disposed || !ref.current) return;
        // C3R16:用 latestValue.current 而不是闭包 value —— 异步加载期间父组件可能
        // 已切到别的笔记(value 改了),必须读最新值。
        const initialDoc = latestValue.current;
        const extensions = [
          history(),
          drawSelection(),
          dropCursor(),
          rectangularSelection(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          // base: markdownLanguage —— 默认的 base 是严格 CommonMark,删除线 / 表格 /
          // 任务列表(GFM)根本不进语法树,`~~字~~` 只会显示成原样。笔记里这些都
          // 是常用语法,必须开 GFM。
          // markdown() 自带 addKeymap: true,已经用 Prec.high 挂了 markdownKeymap
          // (回车续写列表 / 退格删标记),这里不要重复挂 —— 重复挂会落在
          // defaultKeymap 同一优先级里,反而不如它自己的高优先级绑定。
          // lang-markdown 保留的原因不是渲染,而是它自带的 markdownKeymap
          // (回车续写列表 / 退格删标记,Prec.high)—— 写作辅助,不影响显示。
          markdown({ base: markdownLanguage }),
          EditorView.lineWrapping,
          // audit-r133:Typora 装饰层已删,原始文本显示见上方 sourceTheme。
          sourceTheme,
          // audit round 16 (2026-09-15):A11Y-009 — 之前外层 wrapper div 带
          //   role=textbox aria-label=笔记正文,但 SR 实际聚焦的是内层
          //   .cm-content(CodeMirror 自己渲染的 contenteditable),外层 label
          //   不在 SR 的无障碍树里 —— 笔记主编辑控件没可访问名。
          //   用 EditorView.contentAttributes 直接给内层 .cm-content 元素
          //   打 aria-label + aria-roledescription="rich text editor";
          //   注意:editorAttributes 走外层 .cm-editor,SR 不聚焦那个,
          //   contentAttributes 才打到 SR 真正进入的 contenteditable。
          EditorView.contentAttributes.of({
            'aria-label': t('common.noteBodyAria'),
            'aria-roledescription': 'rich text editor',
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              const next = u.state.doc.toString();
              // perf r247:记下「这份正文是我发出去的」—— 供下面 [value]
              //   effect 做 O(1) 短路(见 lastEmittedRef 注释)。
              lastEmittedRef.current = next;
              onChangeRef.current(next);
            }
            // 撤销/重做能力位:doc 变了(打字 / 撤销 / 重做)或选区变了都会走到这
            // 里 ⇒ 顺手报一次当前栈深(只在翻转时才真正通知上游)。
            reportHistory(u.state);
          }),
        ];
        // extensions 留一份 —— 换文档(detoken 变化)时要用它重建 EditorState,
        // 重建 ⇒ 撤销栈天然归零(见下面 [value, docToken] effect)。
        extensionsRef.current = extensions;
        const state = EditorState.create({
          doc: initialDoc,
          extensions,
        });
        view = new EditorView({ state, parent: ref.current });
        viewRef.current = view;
        // 首次上报能力位(force)—— 让上层从一开始就拿到真值,而不是靠
        // 「默认值恰好对」蒙对。之后的每一次只在**翻转**时上报。
        reportHistory(state, true);
        // view 里装的就是「当前这篇文档」⇒ 记住它对应的 docToken。
        // 之后父级 token 一变 ⇒ 走 setState 路径(重建 ⇒ 撤销栈清零)。
        appliedTokenRef.current = latestDocToken.current;
        // 占位 → 真实编辑器:此时父 div 已经有 cm-content,Skeleton 必须撤掉,
        // 否则两层叠加。setReady(false) 同步触发本组件 re-render,把整棵
        // Skeleton 从 DOM 里移走。
        setReady(false);
        // C3R16:async 加载期间 value 可能已变;若 view 当前 doc 与最新 value 不同,
        // 立刻 dispatch 同步。useEffect 2 也会在下次 value 变化时跑,但这里补一次
        // 保证切到 view 时第一帧就是新内容。
        const v = view as {
          contentDOM?: HTMLElement;
          state: { doc: { toString: () => string; length: number } };
          dispatch: (s: unknown) => void;
        } | null;
        if (v && v.state.doc.toString() !== latestValue.current) {
          v.dispatch({
            changes: { from: 0, to: v.state.doc.length, insert: latestValue.current },
            // 外部灌入的正文**不进撤销栈** —— 用户按「撤销」撤的应该是
            // 「我自己敲的那些字」,不是「外部替换进来的整篇」。
            annotations: Transaction.addToHistory.of(false),
          });
        }
        // audit 2026-09-16 audit-r22 — view 创建完成时若 autoFocus=true
        //   立即 focus contentDOM。latestFocus 由 useLatestValue 包,异步
        //   chunk 加载期间父组件已多次 render(切到别的笔记 / 切回),闭包
        //   仍能拿到最新的 {autoFocus, token}。这覆盖「mount 时立刻
        //   focus」场景;「同 Editor 实例后续 token 变化 → 再 focus」由
        //   下面的 token effect 覆盖。
        if (v && latestFocus.current) {
          v.contentDOM?.focus();
        }
      } catch (err: unknown) {
        if (disposed) return;
        setLoadError(err);
      }
    })();

    return () => {
      disposed = true;
      // EditorView 实例有 destroy();留 unknown 类型让 codemirror 类型不进入主 chunk
      const v = view as { destroy: () => void } | null;
      v?.destroy();
      viewRef.current = null;
      // 卸载时把 ready 重置回 true —— 父组件若 remount 会再次看到占位。
      setReady(true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // C3R16:value 同步仍走 viewRef + 闭包 value(标准 React 数据流);只是 view
    // 创建阶段改成读 ref,避免 stale 闭包导致 view 用旧 doc 创建后再被同步。
    const view = viewRef.current as CMView | null;
    if (!view) return;
    // ── 路径 A:换了一篇文档(docToken 变化)─────────────────────────────
    // 切笔记时正文整段被替换,但 CodeMirror 的撤销栈还挂着**上一篇**的编辑
    // 事件 ⇒ 用户在新笔记里按「撤销」会撤掉上一篇的字(而且 autosave 会把这
    // 个结果写进新笔记 ⇒ 跨笔记污染正文)。
    //
    // 修法:setState 重建 EditorState —— 新的 state 天然带着**空撤销栈**
    // (history 是 StateField,新 state = 字段初始值 = 空),顺带把光标/
    // 滚动复位到新文档开头(切笔记本来就该从头看)。
    //
    // 为什么不靠「整段替换 + addToHistory:false」顺带清栈:那条路依赖
    // 「替换范围覆盖全部历史事件」,正文为空时替换是空操作 ⇒ 清不掉;
    // setState 无条件干净。
    const token = latestDocToken.current;
    if (token !== undefined && appliedTokenRef.current !== token) {
      const exts = extensionsRef.current;
      const stateMod = stateModRef.current;
      if (exts && stateMod) {
        appliedTokenRef.current = token;
        const next = latestValue.current;
        view.setState(stateMod.EditorState.create({ doc: next, extensions: exts }));
        // setState 不触发 updateListener(没有 transaction)⇒ 手动把
        // 「本编辑器当前持有这份正文」记上,免得下面又走一次全量比较。
        lastEmittedRef.current = next;
        reportHistory(view.state);
        return;
      }
    }
    // ── 路径 B:同一篇文档的外部改动 ────────────────────────────────────
    // perf r247:O(1) 短路 —— value 就是本编辑器刚发出去的那份 ⇒ doc 已是它
    //   ⇒ 跳过整段 doc.toString()(O(全文长) 的字符串构建 + 比较)。
    //   不等时走原来的完整比较(慢路径),保证外部改动照常同步进编辑器。
    const v = latestValue.current;
    if (v === lastEmittedRef.current) return;
    if (view.state.doc.toString() !== v) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: v },
        // 外部灌入的正文不进撤销栈(见上面 mount 分支的同款注释)。
        annotations: stateModRef.current?.Transaction.addToHistory.of(false),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, docToken]);

  // audit 2026-09-16 audit-r22 — token 变化时重新评估 autoFocus:view 可能
  //   已就绪(view 创建后 unmount 之前),父组件 StandaloneNoteEditorCore 切到
  //   新笔记(initialFocus='body')时 token +1,这里读 latestFocus 决定是否
  //   focus。deps 只放 autoFocusToken 不放 autoFocus:token 是 source of truth,
  //   autoFocus 是 token 对应的「期望」开关,token 自带版本号语义。
  //   如果 view 还没就绪(viewRef.current=null,异步 chunk 还在拉),no-op —
  //   等 view 创建完时第一个 useEffect 内的 latestFocus 检查会兜底。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!latestFocus.current) return;
    const view = viewRef.current as { contentDOM?: HTMLElement } | null;
    if (!view?.contentDOM) return;
    // audit 2026-09-17 r23 a11y L2:首次 mount 时上面 view 创建 callback 已经
    //   focus 过一次;若 autoFocusToken 0→1 时 contentDOM 已在焦点上,跳过
    //   避免部分 SR(NVDA / VoiceOver)在已聚焦元素上重复播报「笔记正文
    //   rich text editor」,扰乱键盘 / SR 用户的导航流。
    // audit r28 (2026-09-21):per-token 消费追踪 —— 旧实现只看「当前焦点
    //   在不在 contentDOM」,导致 token 1→2 时虽然用户已聚焦在旧 token 的
    //   contentDOM(初始 0→1 触发的那次 focus),新的 token 又被 skip,
    //   光标停在旧位置不跟随笔记切换。用 lastConsumedToken 记住上次
    //   focus 过的 token,只有「本次 token 未消费过」才走 SR skip 路径;
    //   「新 token」必须 focus,即便 contentDOM 已在焦点上。
    if (
      lastConsumedTokenRef.current === autoFocusToken &&
      view.contentDOM === document.activeElement
    ) {
      return;
    }
    if (autoFocusToken !== undefined) {
      lastConsumedTokenRef.current = autoFocusToken;
    }
    view.contentDOM.focus();
    // latestFocus 由 useLatestValue 包,ref 本身 stable 但 current 会跟 autoFocus 变;
    //   effect 已经通过 autoFocusToken 作为版本号触发,不需要把 latestFocus 再列进 deps。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocusToken]);

  return (
    <div
      ref={ref}
      // audit r35 (2026-10-08):A11Y2 —— 删外层 wrapper 的 role/aria-label。
      //   A11Y-009 (round 16) 已经把 SR 真正进入的 `.cm-content` 标记为
      //   `aria-roledescription="rich text editor" + aria-label=笔记正文`
      //   (EditorView.contentAttributes,上方 line 147)。但 wrapper 上仍
      //   留着 `role="textbox" aria-multiline="true" aria-label=笔记正文`,
      //   三个属性**全部**对 SR 不可见(wrapper 不进无障碍树,SR 进的是
      //   `.cm-content`),等于 dead code —— 更糟的是会让 SSR / a11y linter
      //   误判成"已经有 textbox role 了",阻止后人加正确的 wrapper label。
      //   删掉后,内层 `.cm-content` 是唯一承担 textbox 语义的节点,符合
      //   WAI-ARIA「rich text editor 用 aria-roledescription 修饰原生
      //   contenteditable」的最佳实践(r16 注记里本意如此,只是 wrapper
      //   那份遗漏了清理)。
      className="h-full overflow-auto bg-bg relative"
    >
      {/* chunk-load 错误:不再渲染 skeleton(给用户误导),改为可识别的错误态,
       * 提示原因 + 引导重启 / 升级,失败可报告。设计参照 ErrorBoundary 风格
       * 让用户知道"这不是空白页,是加载失败"。 */}
      {error ? (
        <div role="alert" className="absolute inset-0 flex items-center justify-center p-6">
          <div className="max-w-md text-center">
            <div className="text-sm text-danger mb-1.5">
              {t('reader.errorMarkdownLoaderReaderTitle')}
            </div>
            <p className="text-xs text-fg-tertiary font-mono break-all">{errMsg(error)}</p>
          </div>
        </div>
      ) : (
        <>
          {/* codemirror chunk 还在拉时显示 6 行骨架;ready 后立即移除。
           * pointer-events-none —— 切到 view 之前 div 不能吞事件,防止卡住父级滚动。
           * cm-content 的 padding 上 16px 与下面 p-4 对齐,ready 切换不跳。 */}
          {ready && (
            <div aria-hidden="true" className="absolute inset-0 p-4 pointer-events-none">
              <SkeletonLines rows={6} />
            </div>
          )}
        </>
      )}
    </div>
  );
});
