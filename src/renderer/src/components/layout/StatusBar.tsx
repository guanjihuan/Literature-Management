// 底部状态栏 — VSCode / Linear 风格(2026-09-02 V1.5 重设)
//
// 形态:
//   ┌─────────────────────────────────────────────────────────────────┐
//   │ 📁 C:\data\库       │        ✏ 234 字 / 1.2k        │            │
//   └─────────────────────────────────────────────────────────────────┘
//   (左 = 数据路径按钮,audit-r128;中 = 字数,两侧等权占位真居中)
//
// audit-r56:左区(库路径短化)整段下线 —— 库整体退役,settings.libraryPath
//   不再存在,左区无内容可显示,退化成单区布局;useToast / useSettingsStore /
//   errMsg / shortenPath / Check / Copy / BookOpen 等左区专用 import 一并删。
// audit-r126:「中区居中」当时只写在注释里,代码实际是 [flex-1 左占位] +
//   [中区 flex-1 justify-center] 两个 flex-1 平分整栏,字数永远落在栏宽
//   74.6% 处偏右。现改为 [flex-1 占位 | 中区 intrinsic | flex-1 占位]
//   对称结构,真浏览器实测居中(50.0%),结构契约由 statusbar.test.tsx 锁。
// audit-r127:内容契约收窄修正 —— 显示字数从「body 非空」改为「full 已加载」,
//   空笔记显示 "0 字 · 0 字符",不再整栏空白(真机:新建未写的笔记让用户
//   以为状态栏坏了)。
// audit-r128:左区以新语义复活 —— 数据路径按钮(工作目录根,读 paths store
//   的 root;与 r56 退役的 libraryPath 是两个概念,勿混)。点击走
//   SHELL_OPEN_PATH 在系统文件管理器打开,失败/拒绝走全局 error toast,
//   与 SettingsPage.openDataFolder 同款错误面。root='' 时不渲染(无死按钮),
//   此时栏回到「左占位 + 居中中区 + 右占位」。
// audit-r129:r128 的 max-w-64 是无条件硬顶,默认数据路径在宽窗口也被切
//   省略号。解除上限:空间放得下就显示完整路径,截断降级为挤压时的 fallback
//   (按钮 min-w-0 + span truncate),且中区 flex-shrink-0 让收缩预算全走
//   路径,字数永不参与压缩。
//
// 重构 (2026-09):AI 状态指示已下线 —— AI 模块整体移除,useAIHealthStore
//   / AIIndicator / i18n aiRunningLabel 等全部清理。本段原写「中区只剩扫描 /
//   字数」,其中 ScanIndicator 组件已在 audit-r61 (e936724) 随扫描服务收尾
//   下线,现中区只剩字数一个指示器。
//
// audit 2026-09-08:未保存计数(UnsavedIndicator)下线 —— useUnsavedStore 的
//   markDirty/markClean/isDirty 三个 mutator 0 生产 caller,只 StatusBar
//   读 count,而 count 永远是 0(从来没人调 markDirty)。删 useUnsavedStore
//   / UnsavedIndicator / 中区 unsavedCount prop / 相关 i18n key。
//
// 视觉(V1.5 2026-09-02):
//   - 24px 高(--statusbar-h,VSCode 22-24 区间),bg-raised 弱一层区别于主区
//   - 11px 字号(text-xs),12px 图标;hover 用纯色(去掉 /60 半透明)
//   - 整体走 Linear 风:信息密度高、留白克制
//   - locale 区域已删除(2026-08-27)
//   - WordCount 用 Type 图标,避免与 Edit3 撞车
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen, Type } from 'lucide-react';
import { useNotesStore } from '../../store/notes';
import { usePathsStore } from '../../store/paths';
import { useWorkspaceStore } from '../../store/workspace';
import { errMsg } from '../../lib/error';
import { useToast } from '../../lib/toast';
import { wordCount, charCount, lineCount } from '../../lib/text-stats';

export function StatusBar() {
  const { t } = useTranslation();
  // 选中笔记 / 选中文件 — 用于中区"字数"显示
  // perf (2026-09-06):body 直接从 activeNoteFull 取 —— listNotes 返 summary
  //   后,s.notes 里没有 body;s.activeNoteFull 是按需拉的 full note,save() 内部
  //   乐观更新时也同步更新。取 body 不再触发 notes 数组的 subscribe —— notes
  //   数组 autosave 时换引用,以前会让 useShallow selector 重跑 + MiddleZone
  //   重渲,现在 activeNoteFull.body 引用未变就不触发 StatusBar。
  const activeNoteBody = useNotesStore((s) => s.activeNoteFull?.body ?? '');
  // audit-r127 (2026-10-18):「有 active note」必须用 full 是否已加载判定,不能
  //   用 body !== '' —— 后者把「笔记打开了但正文为空」误判成「没开笔记」,空
  //   笔记 / 新建未写的笔记整栏 24px 空白,真机实测用户感知为「底部栏没显示
  //   内容」。布尔 selector:只在有/无之间翻转才重渲,不破坏 2026-09-06 的
  //   perf 收口(body 内容变化仍只走 body selector)。
  const hasActiveNote = useNotesStore((s) => s.activeNoteFull !== null);
  const activeModule = useWorkspaceStore((s) => s.active);

  // audit 2026-09-08:删 30s tick + STATUSBAR_TICK_MS — 之前是给"X 分钟前"
  //   副文案刷新用,现在 StatusBar 不再显示相对时间(Dashboard / RecentView
  //   下线 + 字数走 activeNoteBody 不带时间显示),setTick 只是 no-op
  //   setState,每 30s 触发 StatusBar 整树 reconcile,白占 CPU。

  return (
    <div
      // audit round 17 (2026-09-15):A11Y-M3 — role=contentinfo 给底部状态栏一个
      //   语义地标(WAI-ARIA 1.2),让 SR 用户用 landmark rotor 直接跳到 footer。
      //   contentinfo 自身非 live;字数等动态区不做 live region(每帧更新会让
      //   SR 重读整栏,round 15 教训)。
      role="contentinfo"
      // audit round 15 (2026-09-15):a11y M4 — 之前 role=status + aria-live 让
      //   整 status bar 在字数每帧更新时被 SR 重读。改为纯静态标签
      //   (aria-label 给 SR 一个"我在状态栏"信号)。
      //   audit-r76 (2026-10-17):注释原提及的 ScanIndicator / WordCountIndicator
      //   子组件已不存在,改为描述当前内联结构。
      aria-label={t('statusBar.label')}
      // V1.5:padding 4→3(更紧凑),text-fg-tertiary(让次要信息更"安静",Linear 风),
      // text-xs→text-2xs(13px,VSCode 风 chrome 字号)
      // audit-r126:去 justify-between —— 居中含义改由「左右对称 flex-1 占位
      //   + 中区 intrinsic」表达(见下),justify-between 在有占位吸收全部
      //   剩余空间时是死属性,留着只会误导后人。
      className="flex items-center gap-3 px-3 h-statusbar bg-bg-raised border-t border-border-subtle text-fg-tertiary text-2xs select-none flex-shrink-0"
    >
      {/* audit-r128:数据路径按钮(VSCode 左下惯例)。intrinsic 兄弟不占
          flex-1 空间,中区仍真居中(契约测试锁)。root 未加载时返回 null,
          栏退化回纯居中区,无死按钮。
          audit-r129:去掉 max-w-64 硬顶 —— 空间放得下就显示完整路径,
          截断降级为仅在栏被挤压时生效(截断链见 DataPathButton 注)。 */}
      <DataPathButton />

      {/* audit-r126:中区真居中的前提是左右两个等权 flex-1 占位。audit-r56 删
          左区(库路径)时只留了左占位,中区自己又带 flex-1,两者 50/50 平分
          整栏 → justify-center 只在「自己的右半」内居中,真浏览器实测字数
          indicator 中心落在栏宽 74.6%,永远偏右。现补右占位、中区收 intrinsic
          宽,实测回到 50.0%。结构契约由 statusbar.test.tsx 锁死。*/}
      <div className="flex-1" />

      {/* === 中区:动态指示 === */}
      <MiddleZone
        activeModule={activeModule}
        activeNoteBody={activeNoteBody}
        hasActiveNote={hasActiveNote}
      />

      <div className="flex-1" />
    </div>
  );
}

// ============================================================
// 数据路径按钮(audit-r128)— 点击在系统文件管理器打开工作目录根
// ============================================================

function DataPathButton() {
  const { t } = useTranslation();
  // 读 paths store 的 root(= WorkspacePaths.root,与 SettingsPage
  // .openDataFolder 读的 settings.rootPath 同指工作目录根,叫法差异见
  // ADR-0003;paths store 头注历史上正是按「StatusBar 路径按钮」设计的
  // 消费方)。一次拉取 + settings 变化重订阅都已在 store/App 收口,这里
  // 只读结果。root === ''(启动 load 未回 / 未初始化)→ 不渲染,栏退化
  // 为纯居中区,不给用户一个点了只会弹「未初始化」的死按钮。
  const root = usePathsStore((s) => s.paths.root);
  if (!root) return null;
  // 错误处理与 SettingsPage.openDataFolder 同款(audit 2026-09-10 谱系):
  //   !r.ok 检查包络失败 + try/catch 接 IPC reject(主进程 crash / 桥死时
  //   openPath 直接 reject,不接会变成静默 unhandled rejection)。区别仅
  //   在反馈通道:settings 用抽屉内 flashMsg,这里用全局 useToast。
  //   成功不弹 toast —— 文件管理器窗口本身就是反馈。
  const onClick = async () => {
    try {
      const r = await window.api.openPath(root);
      if (!r.ok) {
        useToast.getState().show({
          type: 'error',
          message: t('toast.openFolderFailed', { msg: r.message }),
        });
      }
    } catch (err: unknown) {
      useToast.getState().show({
        type: 'error',
        message: t('toast.openFolderFailed', { msg: errMsg(err) }),
      });
    }
  };
  return (
    <button
      type="button"
      onClick={onClick}
      // title 挂裸路径(hover 看全称,VSCode 同款;路径非可译文本,
      // 不套分隔 key,避免 r18 双语拼接泄漏形态)。aria-label 给 SR 动作
      // 语义;可见文本 = 路径本身(截断后),SR 读 label 后仍能 tab 到文本。
      title={root}
      aria-label={t('statusBar.dataPathOpen')}
      // audit-r129:无 max-w-* 固定上限(旧 max-w-64 让默认路径在宽窗口也被
      //   切省略号),截断链改为纯挤压驱动:按钮 min-w-0 允许缩到内容宽以下;
      //   span 的 truncate 自带 overflow:hidden,flex 自动最小宽归 0,栏不够宽
      //   时才走省略号。压缩优先级由中区 flex-shrink-0 保证(字数永不参与)。
      className="inline-flex items-center gap-1 min-w-0 rounded px-1 -mx-1 hover:bg-bg-hover hover:text-fg-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
    >
      <FolderOpen size={12} aria-hidden="true" />
      <span className="truncate">{root}</span>
    </button>
  );
}

// ============================================================
// 中区 — 动态指示(字数)
// ============================================================

function MiddleZone({
  activeModule,
  activeNoteBody,
  hasActiveNote,
}: {
  activeModule: ReturnType<typeof useWorkspaceStore.getState>['active'];
  activeNoteBody: string;
  hasActiveNote: boolean;
}) {
  // 只有 notes 模块 + 已加载 active note 才显示字数。audit-r127:判据从
  //   activeNoteBody !== '' 换成 hasActiveNote —— 空笔记也要显示 0 统计,
  //   否则整栏空白像坏了(真机实测复现)。「未选中任何笔记」(full=null)
  //   仍然不显示,由 statusbar.test.tsx 双向锁死。
  const showWordCount = activeModule === 'notes' && hasActiveNote;
  // audit-r126:隐藏时返回 null 而非 flex-1 空 div —— 栏内左右已有对称占位
  //   负责撑开,中区再塞一个 flex-1 会让占位变成 3 个抢空间。
  if (!showWordCount) return null;

  // audit-r126:中区收 intrinsic 宽(不再 flex-1 + justify-center)—— 居中
  //   完全交给父级 [flex-1 占位 | 本段 | flex-1 占位] 的对称结构。旧写法
  //   flex-1 justify-center 与左占位平分宽度,实测 indicator 中心 74.6% 偏右。
  // audit-r129:flex-shrink-0 —— 路径按钮解除 max-w 上限后,长路径挤压时若
  //   中区仍是 shrink-1,两个 shrink 兄弟按比例同缩,字数会被无声裁切;收缩
  //   预算全部让给路径(它自带 truncate 兜底),字数永远完整。
  return (
    <div className="flex items-center gap-3 min-w-0 flex-shrink-0">
      <WordCountIndicator body={activeNoteBody} />
    </div>
  );
}

// ============================================================
// 指标组件
// ============================================================

function WordCountIndicator({ body }: { body: string }) {
  const { t } = useTranslation();
  // audit 2026-09-10:rAF 节流 + lazy init —— body 引用每次 keystroke 都换,
  //   useMemo([body]) 几乎无效(只省同 frame 内重复),仍然跑三遍 O(N) 扫描 +
  //   lineCount 的 split('\n') 数组分配,1MB 笔记 ≈ 20ms。rAF 合并连续 keystroke
  //   为下一帧 paint 前一次计算,避开输入尖峰期。
  //   lazy init 处理首屏:body 已知时同步算,避免用户首屏看到 "0 字 / 0 字符"
  //   一帧再被 rAF 替换(flicker,也破了 statusbar.test.tsx 同步断言的契约)。
  //   bodyRef 锁住最新 body:rAF 回调里取 ref 而非闭包 body,避免连续输入时
  //   读到旧值算错 stats。
  const compute = (b: string) => ({
    words: wordCount(b),
    chars: charCount(b),
    lines: lineCount(b),
  });
  const [stats, setStats] = useState<{ words: number; chars: number; lines: number }>(() =>
    compute(body),
  );
  const rafRef = useRef<number | null>(null);
  const bodyRef = useRef(body);
  bodyRef.current = body;
  useEffect(() => {
    // lazy init 已经把首屏算对了,此 effect 只负责 body 变化后调度 rAF
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      setStats(compute(bodyRef.current));
    });
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [body]);
  return (
    <span
      className="inline-flex items-center gap-1 tabular-nums text-fg-tertiary"
      // audit 2026-09-16 r18:H11 — 走 t() 替代硬编码 ` · `,SR 朗读从双语
      //   字面拼接变成语言一致字串。
      title={t('statusBar.wordLineSep', {
        title: t('statusBar.wordCountTitle'),
        lines: t('statusBar.lineCount', { count: stats.lines }),
      })}
      // audit r29 (2026-09-21):删 live region —— r18:H1 加的 role=status /
      //   aria-live=polite / aria-atomic=true 在用户每次 keystroke(打字 / 删除)
      //   都会触发 setStats → 重读整段 "X 字 Y 字符 Z 行",1 分钟 60-200 次键入
      //   = SR 用户听 60-200 次重报,与 ScanIndicator(扫描期几百 ms 一次)
      //   完全不同的频率量级。StatusBar 不是 SR 用户关心的内容,删 live region
      //   后 SR 仍能 tab 聚焦到这里(可读 title / text)但不会被强制广播噪声。
      //   想看字数 / 行数的用户可以 tab 过来 title hover,无须 live region 主动推。
    >
      <Type size={12} aria-hidden="true" />
      {/* audit round 14 (2026-09-15):I18N-PLURAL-1 — wordCount/charCount 拆 2 个 key,
          各走 {count: ...} plural 解析。原 "{words} words / {chars} chars" 是 2 个
          独立的 plural rule(英 1 word / 2 words + 1 char / 2 chars)无法在同一
          i18next key 表达。
          audit 2026-09-16 r18:H11 — 走 t() 替换硬编码 ` · `,中英文拼接不再泄漏。*/}
      <span>
        {t('statusBar.wordsCharsSep', {
          words: t('statusBar.wordCount', { count: stats.words }),
          chars: t('statusBar.charCount', { count: stats.chars }),
        })}
      </span>
    </span>
  );
}

// audit-r76 (2026-10-17):删 Indicator 原子组件 —— 零 `<Indicator` JSX 消费者
//   (grep 实证;WordCountIndicator 现走内联 span,不用此抽象)。统一颜色 +
//   图标 + 文本的抽象只剩一个潜在使用点时不值得保留组件。
