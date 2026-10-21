// 设置页 - Linear 风格
// 已迁移为 Drawer(右侧滑出):设置项通常需要滚动看全部,Modal 居中 + max-height 体验差
//
// 内部仅做表单编排:section 排序、字段 state、迁移触发等。
// 原子 UI(Section / Label / ChromeToggle)抽到 SettingsAtoms.tsx,
// 本文件专注"逻辑"而不是"组件"。
import { useState, useEffect, useRef, useCallback, useId } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Database,
  Sun,
  Moon,
  Monitor,
  Languages,
  Eye,
  Type,
  Palette,
  ExternalLink,
} from 'lucide-react';
import { DEFAULT_SETTINGS, FONT_FAMILIES, THEMES } from '@shared/types';
import type { Theme } from '@shared/types';
import { Drawer } from '../ui/Drawer';
import { confirm } from '../../lib/confirm';
import { Button } from '../ui/Button';
import { RadioChip } from '../ui/RadioChip';
// audit-r56:ExtensionsEditor / ImportRootsEditor 随「扩展名过滤 / 受信任导入根」
//   两个 Section 删除 —— 库概念下线后这两组设置无消费方(AppSettings 字段已删)。
import { Section, Label, ChromeToggle } from './SettingsAtoms';
import { ThemePicker } from './ThemePicker';
import { useRadioGroup } from '../../hooks/useRadioGroup';
import { useSettingsStore } from '../../store/settings';
import { useWorkspaceStore, type FontFamily } from '../../store/workspace';
// audit C3R48 (2026-08-22):errMsg 替代 verbose 错误格式化(3 处)
import { errMsg } from '../../lib/error';

// 主题预设的展示元数据 + 色卡选择器已搬到 components/settings/ThemePicker.tsx
//   (r247):15 档预设用文字芯片排不出效果,改成带真实配色缩略图的网格。
//   预设清单的单一真相源仍是 shared/types.ts 的 THEME_PRESETS。

// audit-r229:字体族选项表从 FONT_FAMILIES(shared/types.ts SSOT)派生 ——
//   此前手抄 3 行,加字族时设置页不跟 ⇒ 用户在设置页选不到新字体(命令面板
//   与设置页漏改的表现不同,同源于同一份手抄)。
//   FONT_TITLE_KEYS 用 Record<FontFamily, string> ⇒ 新增字族时 TS 直接报
//   「缺 key」,编译期拦一道(再由 tests/unit/shared/
//   font-enum-single-source-parity.test.ts 运行时哨兵兜住「多写/漏写」)。
const FONT_TITLE_KEYS: Record<FontFamily, string> = {
  system: 'settings.fontSystem',
  serif: 'settings.fontSerif',
  mono: 'settings.fontMono',
};

const FONT_OPTIONS: Array<{ id: FontFamily; titleKey: string }> = FONT_FAMILIES.map((id) => ({
  id,
  titleKey: FONT_TITLE_KEYS[id],
}));

export function SettingsPage({ open, onClose }: { open: boolean; onClose: () => void }) {
  // audit round 8 (2026-09-14):拆 useShallow per-field selector —— 之前
  //   一次性返回 {settings, update, pickLibrary, pickData, migrate, ...}
  //   7 字段 + useShallow,任何字段变化都重新构造对象引用 → 即使 Object.is
  //   决定不重渲,useShallow 内部每一帧都跑 shallow 比较,7 字段里任一变化
  //   让整对象重渲。
  //   拆 per-field 后:
  //     - settings 真变时(IPC push)重渲;其他 store 字段变化(actions 引用
  //       永远稳定)不重渲本组件 —— 与 zustand 默认 useStore((s)=>s.x) 行为等价。
  //     - actions (update/pickLibrary/...) 在 zustand module-load-time 一次性
  //       创建,引用永远稳定,Object.is 直接命中,无任何浅比较开销。
  //   与原 useShallow 等价的 case:settings 真变 → useShallow 也会重渲;
  //   增强的 case:workspace store / favorites store / library store 字段变化
  //   不再触发本组件(之前 useShallow 阻止不了对象重建,只有 Object.is 才
  //   能挡住 —— 这里就是拆 selector 的净收益)。
  const settings = useSettingsStore((s) => s.settings);
  const update = useSettingsStore((s) => s.update);
  // audit-r56:pickLibrary / restoreDefaultLibrary / pickImportRoot 删除 ——
  //   库路径 / 受信任导入根两组设置随库概念下线。
  const pickData = useSettingsStore((s) => s.pickData);
  const migrate = useSettingsStore((s) => s.migrate);
  const restoreDefaultData = useSettingsStore((s) => s.restoreDefaultData);
  // Phase 3 外观字段 — 接 workspace store;setter 内部已自动 persist 到 settings
  const themePreset = useWorkspaceStore((s) => s.themePreset);
  const setThemePreset = useWorkspaceStore((s) => s.setThemePreset);
  const fontFamily = useWorkspaceStore((s) => s.fontFamily);
  const setFontFamily = useWorkspaceStore((s) => s.setFontFamily);
  const statusBarHidden = useWorkspaceStore((s) => s.statusBarHidden);
  const toggleStatusBar = useWorkspaceStore((s) => s.toggleStatusBar);
  const { t } = useTranslation();
  // audit round 17 (2026-09-15):A11Y-H1/M1 — 4 处 radiogroup + 1 处过滤模式。
  //   每组的 Section h3 需要稳定 id 给 radiogroup aria-labelledby 锚点,
  //   useId() 给出 React 18 自带的 :R{xxx} 唯一 id,SSR 与并发安全。
  const themeGroupId = useId();
  const languageGroupId = useId();
  const presetGroupId = useId();
  const fontGroupId = useId();

  const [busy, setBusy] = useState(false);
  // 反馈消息带 tone —— 之前一律渲染成绿色,连接失败也是绿的
  const [msg, setMsg] = useState<{ text: string; tone: 'success' | 'error' | 'info' } | null>(null);
  const msgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // audit-r137:reentry guard —— busy useState 异步批处理,React 18 下连点
  //   第二次时第一次 setBusy 没 commit、按钮仍 enabled,handler 被调两次 →
  //   pickData / confirm / migrate 重复跑。useRef 同步守 reentry(对位
  //   NotesView.renameInFlightRef / confirm 队列模型)。
  const changeDataInFlight = useRef(false);
  const restoreDataInFlight = useRef(false);

  // 统一的反馈入口:自动清理上一个定时器,避免卸载后 setState
  // audit round 26 (2026-09-21):保留 'info' tone —— 公共 UI 资源,供未来
  //   区分成功 / 错误的提示场景(如 import 重名)复用。
  const flashMsg = useCallback((text: string, tone: 'success' | 'error' | 'info', ms = 3000) => {
    if (msgTimer.current) clearTimeout(msgTimer.current);
    setMsg({ text, tone });
    msgTimer.current = setTimeout(() => setMsg(null), ms);
  }, []);
  useEffect(
    () => () => {
      if (msgTimer.current) clearTimeout(msgTimer.current);
    },
    [],
  );

  // audit round 17 (2026-09-15):radiogroup onChange 统一走 try/catch + flashMsg
  //   —— 原 button onClick 已经按 r13 F3/F4 各自包了 IIFE,radiogroup 把 4 处
  //   重复收口成一个高阶包装,UI 切换只关心「调谁」,错误路径统一交给 store
  //   已有的 flashMsg 反馈槽。
  //
  // 注意:hooks 不能放在 `if (!settings) return null;` 之后;此处用 settings?.X
  //   ?? 默认值 —— 启动早期 settings 尚未加载,UI 也不渲染(useId 给的 id 在
  //   后续 render 复用同一稳定 id,无 hydration 风险)。
  const withFlashMsg = useCallback(
    (fn: () => unknown) => {
      void (async () => {
        try {
          // accept both sync (setThemePreset returns void) and async
          // (update returns Promise<unknown>) — await of non-Promise is a no-op
          await fn();
        } catch (err: unknown) {
          flashMsg(errMsg(err), 'error');
        }
      })();
    },
    [flashMsg],
  );

  const themeRadio = useRadioGroup({
    // audit-r125:三档 tabs 与 cast 收 THEMES/Theme 单源(手抄第 5/6 站;
    // 显示序 = 循环序同 tuple)。null-gate 回退口径注记见下行 r122 原注。
    tabs: THEMES.map((id) => ({ id })),
    // audit-r122:回退口径与 DEFAULT_SETTINGS.theme 对齐(当前 null gate 下
    // 此分支不可达,统一口径防未来有人删 null gate 时把 'system' 复活成真行为)
    active: settings?.theme ?? DEFAULT_SETTINGS.theme,
    onChange: (id) => withFlashMsg(() => update({ theme: id as Theme })),
  });
  const languageRadio = useRadioGroup({
    tabs: [{ id: 'zh-CN' }, { id: 'en-US' }] as const,
    // audit-r122-b:语言回退与 DEFAULT_SETTINGS.language 同口径收单源
    // (上方 theme 同款 —— null gate 下不可达,但手抄字面量正是 r91
    //  常量单源要防的漂移类:默认语言翻转时此处必须自动跟随)
    active: settings?.language ?? DEFAULT_SETTINGS.language,
    onChange: (id) => withFlashMsg(() => update({ language: id as 'zh-CN' | 'en-US' })),
  });
  // r247:主题预设选择器自持 radiogroup(ThemePicker 内含缩略图网格),
  //   设置页只负责接线 value / onChange。
  const fontRadio = useRadioGroup({
    tabs: FONT_OPTIONS.map((f) => ({ id: f.id })),
    active: fontFamily,
    onChange: (id) => withFlashMsg(() => setFontFamily(id as typeof fontFamily)),
  });
  if (!settings) return null;

  // audit 2026-10-09:HIGH —— 跟 restoreData 对齐把 setBusy(true) 提到
  //   pickData 之前。原因:之前 `await pickData()`
  //   与 `await confirm()` 期间 busy=false,用户在文件选择器/确认弹窗前
  //   双击"更改数据路径"按钮 → 第二次进 changeData → 第二次 pickData
  //   (Electron picker 一般是 modal 但 confirm 用的 app 内 Modal 不是
  //   modal,同一 DOM 树,第二次 click 真进 handler)→ 第二个 confirm
  //   排队(详见 lib/confirm 队列语义)→ 第二个 migrate() IPC 与第一个
  //   并发跑 —— switchDataPath 在主进程里串行化但 settings 写盘竞争
  //   仍可能让 location.json 短暂错位,UX 上看到"已迁移"但实际数据
  //   状态混乱。把 setBusy 提到入口拦截双击是更便宜的修法。
  const changeData = async () => {
    // audit-r137:reentry guard 提到入口 —— busy useState 异步批处理下
    //   双击第二次时第一次 setBusy 没 commit,useRef 同步值守住二次进入。
    if (changeDataInFlight.current) return;
    changeDataInFlight.current = true;
    setBusy(true);
    try {
      const p = await pickData();
      if (!p) return;
      // 用应用内 ConfirmDialog 而不是 window.confirm ——
      // 后者会阻塞渲染进程,且完全脱离应用主题。
      const ok = await confirm({
        title: t('settings.migrateConfirmTitle'),
        description: t('settings.migrateConfirmDesc'),
        confirmLabel: t('settings.migrateConfirmLabel'),
      });
      if (!ok) return;
      await migrate(p);
      flashMsg(t('toast.migrateDataSuccess'), 'success', 2000);
    } catch (err: unknown) {
      flashMsg(t('toast.migrateDataFailed', { msg: errMsg(err) }), 'error');
    } finally {
      setBusy(false);
      changeDataInFlight.current = false;
    }
  };

  // 恢复默认数据路径 —— 走主进程 location.defaultDataPath() → switchDataPath 全流程
  // (copy 数据 + 写 settings.json + 写 location.json + initDB + rescan)。
  // 与 changeData 同模式:setBusy 提到 confirm 之前拦截双击 + 取消复位。
  const restoreData = async () => {
    if (restoreDataInFlight.current) return;
    restoreDataInFlight.current = true;
    setBusy(true);
    try {
      const ok = await confirm({
        title: t('settings.dataRestoreConfirmTitle'),
        description: t('settings.dataRestoreConfirmDesc'),
        confirmLabel: t('settings.dataRestoreConfirmAction'),
      });
      if (!ok) return;
      await restoreDefaultData();
      flashMsg(t('toast.dataRestored'), 'success', 2000);
    } catch (err: unknown) {
      flashMsg(t('toast.dataRestoreFailed', { msg: errMsg(err) }), 'error');
    } finally {
      setBusy(false);
      restoreDataInFlight.current = false;
    }
  };

  // 在系统文件管理器中打开数据文件夹 —— 走 SHELL_OPEN_PATH,主进程内部
  // 做白名单校验,shell.openPath 在路径不存在
  // 时静默失败,所以打开前先 fs.access(由主进程 handler 做)。失败时 toast 提示
  // 错误消息,成功不弹 toast(用户已看到文件管理器窗口,无需额外反馈)。
  // audit 2026-09-10:openPath IPC 自身可能 reject(main process crash / preload
  //   bridge 死),之前只检查 IpcResult.ok 不接 try/catch,reject 会变 unhandled
  //   rejection 静默吞掉。包 try/catch 兜底。
  // audit-r56:openLibraryFolder 删除 —— libraryPath 字段随库概念下线。
  const openDataFolder = async () => {
    if (busy) return;
    // audit 2026-10-02(workspace-unification):打开的是工作目录根,读 rootPath。
    //   dataPath 已 @deprecated(只为了降级兼容而镜像写入),渲染层不再读它。
    const rootPath = settings.rootPath;
    // audit round 38 (2026-10-13):与 openLibraryFolder 同款 — 空 rootPath 不
    //   再静默 return,改走 flashMsg toast。典型触发:settings.json 缺失 rootPath
    //   字段(init 阶段 fallback 到默认但尚未写盘时) / 数据目录被外部删 / 迁移
    //   中。toast 显式说明让用户知道是「工作路径未初始化」而非按钮坏了。
    if (!rootPath) {
      flashMsg(t('toast.openDataFolderNoPath'), 'error');
      return;
    }
    try {
      const r = await window.api.openPath(rootPath);
      if (!r.ok) {
        flashMsg(t('toast.openFolderFailed', { msg: r.message }), 'error');
      }
    } catch (err: unknown) {
      flashMsg(t('toast.openFolderFailed', { msg: errMsg(err) }), 'error');
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={t('settings.title')}
      description={t('settings.description')}
      width="w-full max-w-lg"
    >
      <div className="space-y-6">
        {/* audit 2026-09-16 r18:H5 — msg 状态条从抽屉底部移到顶部,sticky
            让用户不管滚到哪里都能看到。视觉上从「埋在底部易错过」改为
            「顶部即时反馈」。role=status + aria-live=polite 不变(SR 也会
            顶部立即公告)。*/}
        {msg && (
          <div
            role="status"
            aria-live="polite"
            // audit round 26 (2026-09-21):info tone 中性色 —— 与 success / error
            //   区分的「中性提示」用色,避免误导 SR 用户「操作已成功」。
            className={`sticky top-0 z-10 -mx-1 px-3 py-2 rounded text-xs border ${
              msg.tone === 'error'
                ? 'text-danger bg-danger/10 border-danger/30'
                : msg.tone === 'info'
                  ? 'text-fg-secondary bg-bg-raised border-border-subtle'
                  : 'text-success bg-success/10 border-success/30'
            }`}
          >
            {msg.text}
          </div>
        )}
        {/* audit-r56:「库路径」Section 整体删除 —— 库概念下线,AppSettings 已无
            libraryPath 字段;文献管理回归「打开 PDF 来读」,无需库路径设置。 */}

        {/* 数据路径 */}
        <Section
          icon={<Database size={14} aria-hidden="true" />}
          title={t('settings.dataFolderTitle')}
          // audit 2026-09-16 r18:M10 — 数据路径同模式,busy 时 section aria-busy。
          aria-busy={busy}
        >
          <div className="flex items-start gap-2">
            <code
              title={settings.rootPath}
              className="flex-1 min-w-0 text-xs bg-bg-raised px-2.5 py-1.5 rounded text-fg-secondary break-all font-mono"
            >
              {/* audit r35 (2026-10-08):ADR-0003 收尾 —— settings.dataPath 是
                  @deprecated 镜像字段,UI 展示走 rootPath(单一真相,与 IPC
                  返回、SettingsStore 状态保持一致)。dataPath 在 settings.json
                  里仍镜像写入,只是 renderer 不再读。
                  audit-r143:补 title + break-all + min-w-0 —— 默认 truncate
                  在 480px 设置抽屉被三个按钮挤到 257px,path(328px 需求)
                  出现 "Resea..." 省略号且无 hover 路径可见;改为按字符折行
                  (font-mono 下 \\ 与 : 是合法折点),path 永远完整可读;
                  buttons 加 shrink-0 保宽度不被压。 */}
              {settings.rootPath}
            </code>
            {/* 原按钮用 migrateConfirmLabel("开始迁移")误导用户 —— 这是改路径
              按钮,不是迁移按钮。迁移是在用户选完新路径后弹 confirm dialog 才发生,
              按钮本身语义是"更改"。换 dataChangeButton 与 library 端对称。 */}
            {/* audit-r143:changeData 是数据路径的主要变更动作(替换 restoreData
                与 openDataFolder 都是 secondary / ghost),默认 Button variant 是
                secondary → 与恢复按钮撞色。改 variant="primary" 让眼睛看出来。 */}
            <Button
              onClick={changeData}
              size="sm"
              variant="primary"
              loading={busy}
              className="shrink-0"
            >
              {t('settings.dataChangeButton')}
            </Button>
            {/* audit-r145d (2026-10-19) MED:r143e Button.loading 接入 —— 原
             *   disabled={busy} 只挡点击不显示 spinner,IPC 跑期间用户看到
             *   按钮静止无反馈,误以为「卡了」。loading={busy} 走原语 Loader2
             *   + aria-busy + 强 disabled,SR 与视觉同步知道「按钮正在处理」。
             *   restoreData 是 destructive,spinner 更显信号强度(配合 danger
             *   红色告诉用户「不可逆操作正在执行,别再点」)。 */}
            <Button onClick={restoreData} size="sm" variant="danger" loading={busy} className="shrink-0">
              {t('settings.dataRestoreButton')}
            </Button>
            <Button
              onClick={openDataFolder}
              size="sm"
              variant="ghost"
              aria-label={t('settings.dataOpenButton')}
              aria-describedby="open-folder-hint-data"
              title={settings.rootPath}
              className="shrink-0"
            >
              <ExternalLink size={12} aria-hidden="true" />
              {t('settings.dataOpenButton')}
            </Button>
            {/* audit round 17 (2026-09-15):A11Y-M11 — 数据路径同模式。 */}
            <span id="open-folder-hint-data" className="sr-only">
              {t('settings.openExternalHint', { folder: t('settings.dataFolderTitle') })}
            </span>
          </div>
          <p className="text-2xs text-fg-tertiary mt-1">{t('settings.migrateHint')}</p>
        </Section>

        {/* 主题 */}
        <Section id={themeGroupId} title={t('settings.sectionTheme')}>
          <div
            {...themeRadio.getContainerProps()}
            aria-labelledby={themeGroupId}
            className="flex gap-2 flex-wrap"
          >
            <RadioChip {...themeRadio.getItemProps('light')}>
              <Sun size={13} aria-hidden="true" /> {t('settings.themeLight')}
            </RadioChip>
            <RadioChip {...themeRadio.getItemProps('dark')}>
              <Moon size={13} aria-hidden="true" /> {t('settings.themeDark')}
            </RadioChip>
            <RadioChip {...themeRadio.getItemProps('system')}>
              <Monitor size={13} aria-hidden="true" /> {t('settings.themeSystem')}
            </RadioChip>
          </div>
        </Section>

        {/* 界面语言 — 切换会通过 settings → App.tsx → i18n.changeLanguage 全树 re-render */}
        <Section
          id={languageGroupId}
          icon={<Languages size={14} aria-hidden="true" />}
          title={t('settings.sectionLanguage')}
        >
          <div
            {...languageRadio.getContainerProps()}
            aria-labelledby={languageGroupId}
            aria-describedby="settings-language-fallback-hint"
            className="flex gap-2 flex-wrap"
          >
            <RadioChip {...languageRadio.getItemProps('zh-CN')}>{t('settings.langZhCN')}</RadioChip>
            <RadioChip {...languageRadio.getItemProps('en-US')}>{t('settings.langEnUS')}</RadioChip>
          </div>
          <p id="settings-language-fallback-hint" className="text-2xs text-fg-tertiary mt-2">
            {settings.language === 'en-US'
              ? t('settings.languageFallbackHint.en')
              : t('settings.languageFallbackHint.zh')}
          </p>
        </Section>

        {/* 外观 — Phase 3:主题预设 + 字体 + chrome 可见性 */}
        <Section
          icon={<Eye size={14} aria-hidden="true" />}
          title={t('settings.sectionAppearance')}
        >
          <p className="text-2xs text-fg-tertiary mb-3">{t('settings.sectionAppearanceDesc')}</p>

          {/* 主题预设 */}
          <div className="mb-4">
            <Label id={presetGroupId} icon={<Palette size={11} aria-hidden="true" />}>
              {t('settings.appearanceThemePreset')}
            </Label>
            <p id="settings-theme-preset-desc" className="text-2xs text-fg-tertiary mb-1.5">
              {t('settings.appearanceThemePresetDesc')}
            </p>
            <ThemePicker
              value={themePreset}
              onChange={(p) => withFlashMsg(() => setThemePreset(p))}
              labelledBy={presetGroupId}
              describedBy="settings-theme-preset-desc"
            />
          </div>

          {/* 字体 */}
          <div className="mb-4">
            <Label id={fontGroupId} icon={<Type size={11} aria-hidden="true" />}>
              {t('settings.appearanceFont')}
            </Label>
            <p id="settings-font-desc" className="text-2xs text-fg-tertiary mb-1.5">
              {t('settings.appearanceFontDesc')}
            </p>
            <div
              {...fontRadio.getContainerProps()}
              aria-labelledby={fontGroupId}
              aria-describedby="settings-font-desc"
              className="flex flex-wrap gap-2"
            >
              {FONT_OPTIONS.map((f) => (
                <RadioChip key={f.id} {...fontRadio.getItemProps(f.id)}>
                  {t(f.titleKey)}
                </RadioChip>
              ))}
            </div>
          </div>

          {/* chrome 可见性 — 状态栏开关 */}
          <div>
            <Label icon={<Eye size={11} aria-hidden="true" />}>
              {t('settings.appearanceChrome')}
            </Label>
            <p className="text-2xs text-fg-tertiary mb-1.5">{t('settings.appearanceChromeDesc')}</p>
            <div className="space-y-1.5">
              <ChromeToggle
                label={t('settings.chromeStatusBar')}
                value={statusBarHidden}
                onToggle={toggleStatusBar}
                visibleLabel={t('settings.chromeVisible')}
                hiddenLabel={t('settings.chromeHidden')}
              />
            </div>
          </div>
        </Section>

        {/* audit-r56:「扩展名过滤」与「受信任导入根目录」两个 Section 整体删除 ——
            includeAllExtensions / enabledExtensions / extraImportRoots 字段随
            库扫描 / 导入功能下线从 AppSettings 删除,这两组设置已无消费方。 */}

        {/* audit 2026-09-16 r18:H5 — msg status region 上移到抽屉顶部 sticky,
             这里的 duplicate block 删除。*/}
        {/* audit round 15 (2026-09-15):i18n H3 — 之前 `v{version} · {platform}`
             硬编码中间点 + process.platform 原值(darwin/win32/linux),en-US
             用户读到 "v1.7.0 · darwin" 这种开发者术语。改走 settings.versionLine
             + settings.platform map,darwin→macOS / win32→Windows / linux→Linux,
             未来平台值不在 map 时 fallback 回原 platform 字符串,不阻塞显示。
             注:template literal `platform.${...}` 直接放在 t() 调用里,让
             i18n-dead-keys 的 prefix-wildcard pattern 命中(会把 platform.*
             全部视为 used,无需列 KNOWN_FALSE_POSITIVES)。
             audit 2026-09-16 r18:M13 — 整行版本 + 平台合并到 settings.versionPlatformLine,
             不再硬编码 ` · ` 拼接。*/}
        <div className="text-2xs text-fg-tertiary pt-3 border-t border-border-subtle">
          {t('settings.versionPlatformLine', {
            version: settings.version,
            platform: t(`settings.platform.${window.api.platform}`, {
              defaultValue: window.api.platform,
            }),
          })}
          {/* 开发者信息 — target=_blank 经主进程 setWindowOpenHandler 白名单
              (http/https 且非公网私网地址) 放行,shell.openExternal 交给系统浏览器,
              应用内不新开窗口。rel=noreferrer 防 opener 引用泄漏。 */}
          <div className="mt-1">
            {t('settings.developerLabel')}: 关济寰 ·{' '}
            <a
              href="https://www.guanjihuan.com/about"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-fg-secondary"
            >
              https://www.guanjihuan.com/about
            </a>
          </div>
        </div>
      </div>
    </Drawer>
  );
}
