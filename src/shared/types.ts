// 共享类型:主进程 ↔ 渲染进程通用,禁 Node/Electron API

// 独立笔记:纯 markdown body + frontmatter
export interface StandaloneNote {
  id: string; // 相对 notes/ 路径的 SHA-256
  relPath: string; // 相对 notes/
  filename: string;
  title: string | null;
  tags: string[] | null;
  mtime: number;
  body: string;
}

// NOTES_LIST 用精简版(无 body)。
// r161 disk-folder:不再有 folderId 字段(物理目录就是组织层,
//   relPath 自身包含父子关系,dirname(relPath) === currentRelPath 即归属)。
export type StandaloneNoteSummary = Omit<StandaloneNote, 'body'>;

// audit-r64:Resource 统一模型 — notes/literature 合并;brand ID 见 @shared/resource-id
export type ResourceId = string & { readonly __brand: 'ResourceId' };

export const ResourceKind = ['note', 'literature'] as const;
export type ResourceKind = (typeof ResourceKind)[number];

export interface ResourceBase {
  id: ResourceId;
  kind: ResourceKind;
  title: string;
  mtime: number; // epoch ms
  size: number; // bytes
  indexedAt: number; // epoch ms;0 = 从未索引(0005 迁移标记,启动期补 body)
}

// r161 disk-folder:磁盘文件夹节点 —— 与 0007 虚拟 FolderNode 的 kind/parent
//   树结构不同,本节点纯按 relPath 路径前缀定位(无独立 id):
//   - relPath 形如 '' / 'foo' / 'foo/bar';POSIX 风格(win32 仍用 '/')
//     在 relPath 层完全抹平,basename(parentRelPath + '/' + name) 不可用
//     因为 renderer 端 relPath 已经跨平台一致
//   - parentRelPath = null 表示该 kind 树根的直接子项
//   - name = basename(relPath),单独抽出避免 renderer 重复 split
//   两棵 kind 树(notes / literature)各自维护一份 DiskFolderNode[],
//   互不可见 —— 与 ResourceKind 维度对齐。
export interface DiskFolderNode {
  relPath: string;
  name: string;
  parentRelPath: string | null;
}

/**
 * audit-r173:目录(子树)搬移的结果。
 *
 * 搬一个目录 = 搬里面每一个资源 ⇒ 每个资源的 id 都变(notes id 与
 * relPath 强绑定,lit id 与 absPath 强绑定)。renderer 必须拿到
 * (oldId → newId) 才能把「当前选中的那篇笔记」跟到新位置,否则选中态
 * 指向已不存在的 id(点不开 / 读文件撞 NOT_FOUND)。
 */
export interface FolderMoveResult {
  /** 搬移后目录的 relPath(相对 kind 根)。 */
  relPath: string;
  /**
   * 受影响资源的 id 变化;目录里没有已索引资源时为空数组。
   *   relPath / absPath 一并带出 —— renderer 侧 remap 需要靠 relPath
   *   同步 notes 的 activeNoteFull(见 store/notes.ts applyMoveRemapImpl),
   *   literature 侧靠 absPath 认新位置。
   */
  idRemap: Array<{
    oldId: string;
    newId: string;
    relPath?: string;
    absPath?: string;
  }>;
}

export interface NoteResource extends ResourceBase {
  kind: 'note';
  relPath: string; // 相对 rootPath/notes/
  tags: string[]; // frontmatter
}

export interface LiteratureResource extends ResourceBase {
  kind: 'literature';
  absPath: string; // OS 绝对路径,literatureRoot 子树内
  // audit-r172:相对 <rootPath>/literature/ 的 POSIX 路径(文献域的「文件夹归属」)。
  //   之前 literature 行**没有** relPath —— renderer 的 visibleItemRows 按
  //   dirname(relPath) 分组,没有 relPath ⇒ dirname 恒为 '' ⇒ 文献行只在根
  //   视图可见,子目录视图永远空;「粘贴进文件夹」文件确实搬过去了,UI 却仍
  //   显示在根(用户视角 = 粘贴没生效)。
  //   由 LiteratureService 填充(它知道 literature 根);DB 直读路径
  //   (searchResources / getResource)不填 —— 那两条路径不做文件夹分组。
  relPath?: string;
  rootId: string | null; // 所属 root;0005 迁移旧行暂 NULL
  extractStatus: 'pending' | 'ok' | 'failed' | 'filename-only';
  pageCount?: number; // PDF 文本层抽取附带
}

export type Resource = NoteResource | LiteratureResource;

/** StandaloneNote → StandaloneNoteSummary — 单一真相的窄化点。 */
export function toNoteSummary(n: StandaloneNote): StandaloneNoteSummary {
  return {
    id: n.id,
    relPath: n.relPath,
    filename: n.filename,
    title: n.title,
    tags: n.tags,
    mtime: n.mtime,
  };
}

// 应用设置
// audit-r56:删 libraryPath / libraryMigrationPending / libraryMigrationAcknowledged
//   / extraImportRoots / includeAllExtensions / enabledExtensions 字段 ——
//   「库自动发现 + 索引」概念整体退役,这些伴生配置一起下线
export interface AppSettings {
  /**
   * 工作目录根 —— 2026-10-02 workspace-unification 后的单一真相。
   * `notes/` `workspace/` `settings.json` 都是它的直接子项(与旧 dataPath
   * 同位置,零搬迁)。首次见到这个字段的老 settings.json,rootPath 直接取
   * 旧 dataPath 值 —— 不搬任何既有数据,只是改名。
   */
  rootPath: string;
  /**
   * @deprecated 旧字段,仅为了「降级到旧版本仍能启动」而继续镜像写入
   * `rootPath`。新代码一律读 `rootPath`。下次大版本删除。
   */
  dataPath?: string;
  // audit-r156:删 `notesResyncPending` 字段 —— r50 M6 链路从未接线
  // (audit-r124 实证 service 从未写、renderer 零读),ghost 行清理自 audit-r124
  // 起由 NotesService.resyncIfNeeded 就地完成。Zod strict() 默认剥除未知字段,
  // legacy settings.json 含本字段无副作用。
  theme: Theme;
  /**
   * UI 语言。zh-CN(默认)=中文硬编字符串,i18next 启动时 fallback;
   * en-US=未来英文翻译(目前无翻译,所有 t() 命中 fallback 返回 zh-CN)。
   * 切换触发 main.tsx 中 i18n.changeLanguage + 全树 re-render。
   */
  language: 'zh-CN' | 'en-US';
  version: string;
  /**
   * 工作台布局偏好 — 跨次启动保留的 chrome 可见性 / 字体 / 主题状态。
   * 字段全部 optional,旧设置文件无此段也能正常 hydrate。
   */
  workspaceLayout?: WorkspaceLayout;
}

export interface WorkspaceLayout {
  /** 底部 StatusBar 是否隐藏(Phase 3) */
  statusBarHidden?: boolean;
  /**
   * 左侧列表面板(文献 / 笔记 Tab)是否折叠。
   *
   * 历史:该字段曾随「侧栏 / ActivityBar / Zen 模式」整体下线(r56 之后),
   *   现在**只复活这一条** —— 用户要「一个按钮隐藏 / 展开左侧栏」
   *   (r242):标题栏左上角按钮 + ⌘B / Ctrl+B 切换。
   *   detailCollapsed / activityBarHidden / zenMode 仍是下线的,不要复活。
   */
  sidebarCollapsed?: boolean;
  /** 全局字体族:system / serif / mono — 取值见 FONT_FAMILIES */
  fontFamily?: FontFamily;
  /**
   * 主题预设 — 正交于 theme(light/dark/system):theme 决定是否跟随系统,
   * themePreset 决定颜色配方。取值见 THEME_PRESETS。
   */
  themePreset?: ThemePreset;
}

export type FontFamily = 'system' | 'serif' | 'mono';
export const FONT_FAMILIES = ['system', 'serif', 'mono'] as const satisfies readonly FontFamily[];

/**
 * 工作台模块键 — 'library'(文献库,收藏已并入) | 'notes'(笔记)。
 *
 * audit-r217:从 components/ui/chrome.tsx 下沉到 shared。该 union 是领域词汇
 * (store/workspace 的 active、command/registry 的模块循环都靠它),此前定义在
 * UI 组件层导致 store → components、command → components 两条 type 级反向依赖
 * (层级倒挂)。与 FontFamily / ThemePreset 同判据:被多层消费的基础 union
 * 单源放 shared/types。
 */
export type ModuleKey = 'library' | 'notes';
export const MODULE_KEYS = ['library', 'notes'] as const satisfies readonly ModuleKey[];

/**
 * 主题预设(r247 扩容到 15 档)—— 正交于 theme(light/dark/system):
 *   theme       决定「走哪套明暗」(仅对 preset='default' 生效)
 *   themePreset 决定「具体配色配方」(自带明暗属性,见 PRESET_IS_DARK)
 *
 * 选型原则(面向科研文献/长文阅读场景):
 *   - **常见**:GitHub / Nord / Dracula / Tokyo Night / Gruvbox / Catppuccin
 *     都是开发者社区天天见的主题,用户不需要「学习新皮肤」;
 *   - **实用**:sepia(米色护眼)与 high-contrast(高对比无障碍)是为
 *     「长时间读论文 / 弱视 / 强光环境」准备的实用档,不是纯装饰;
 *   - 每档都自带明暗属性,用户选完即刻得到一套自洽的配色,不需要再
 *     手动配浅/深。
 *
 * ⚠ 顺序 = 设置页展示顺序(按家族分组:默认 → GitHub → Solarized →
 *   One Dark → Nord → Dracula → Tokyo Night → Gruvbox → Catppuccin →
 *   护眼米色 → 高对比)。新增时插在同族旁边,别一股脑堆在末尾。
 */
export type ThemePreset =
  | 'default'
  | 'github-light'
  | 'github-dark'
  | 'solarized-light'
  | 'solarized-dark'
  | 'one-dark'
  | 'nord'
  | 'dracula'
  | 'tokyo-night'
  | 'gruvbox-light'
  | 'gruvbox-dark'
  | 'catppuccin-latte'
  | 'catppuccin-mocha'
  | 'sepia'
  | 'high-contrast';
export const THEME_PRESETS = [
  'default',
  'github-light',
  'github-dark',
  'solarized-light',
  'solarized-dark',
  'one-dark',
  'nord',
  'dracula',
  'tokyo-night',
  'gruvbox-light',
  'gruvbox-dark',
  'catppuccin-latte',
  'catppuccin-mocha',
  'sepia',
  'high-contrast',
] as const satisfies readonly ThemePreset[];

// audit-r125:theme 枚举单源 —— FONT_FAMILIES / THEME_PRESETS 两族早已 tuple 化,
// theme 是唯一漏网成员(同值此前手抄 5 处:TitleBar 循环 / actions 循环 /
// validate 兜底 Set / zod schema / SettingsPage cast)。顺序是行为契约:
// 主题循环与回退起点 = light→dark→system→wrap,r122 的呈现回退与本 tuple 对齐。
// src 内字面量拷贝由哨兵锁 tests/unit/shared/themes-enum-single-source-parity.test.ts
// 禁绝。language 两抄 / font-family、preset 在 schemas 与 registry 的手抄属同族
// 纯值漂移(无行为面),本锁未纳入 —— 记为挂账。
export type Theme = 'light' | 'dark' | 'system';
export const THEMES = ['light', 'dark', 'system'] as const satisfies readonly Theme[];

// 默认设置
// audit 2026-10-02(workspace-unification):rootPath / dataPath 从 DEFAULT_SETTINGS
//   排除 —— 两者是运行期派生的(启动时由 resolveDataPath 解析 + 旧 settings.json
//   的 dataPath 提升而来),不是可默认的常量值。initSettings 负责填进去。
// audit-r56:libraryPath / extraImportRoots / includeAllExtensions / enabledExtensions
//   不再列入默认
export const DEFAULT_SETTINGS: Omit<AppSettings, 'dataPath' | 'rootPath'> = {
  theme: 'dark',
  language: 'zh-CN',
  version: '0.1.0',
  workspaceLayout: {},
};

// 搜索结果
//
// r193:snippet 里夹着**高亮标记** —— 主进程 FTS5 的 snippet() 用
//   '<mark>' / '</mark>' 包住命中片段,其余是上下文。
//   标记常量在这里声明(主进程 SQL 与渲染进程解析共用一份),避免
//   「主进程写死的字面量」与「渲染进程猜的格式」两处漂移。
//
//   ⚠ 渲染侧**不得**把 snippet 直接当 HTML 注入(dangerouslySetInnerHTML):
//   片段原文来自笔记正文 / 文件名,内容由用户写入 ⇒ 直接注入等于把
//   笔记正文当 HTML 执行(XSS)。正确做法:按标记切分后用 React 元素渲染
//   (文本段由 React 自动转义),见 renderer components/search/SearchSnippet.tsx。
export const SEARCH_SNIPPET_MARK_OPEN = '<mark>';
export const SEARCH_SNIPPET_MARK_CLOSE = '</mark>';

export interface SearchHit {
  kind: 'file' | 'note';
  id: string;
  relPath: string;
  title: string | null;
  /** 命中的上下文片段 —— 可能含 <mark> 高亮标记(见上方常量)。 */
  snippet: string;
  score: number;
}

// 工作台全局限制/默认值
export const WORKSPACE_LIMITS = {
  NOTES_AUTOSAVE_DEBOUNCE_MS: 1500,
} as const;

// 数据目录布局 — 相对 dataPath 的 POSIX 风格路径
// audit-r56:LIBRARY_DIR 退役 —— 没有「库目录」概念
// audit-r71:LITERATURE_DIR 复活(改名)—— 拖入导入的文献文件物理落点
//   <rootPath>/literature/,语义与旧「拷进 libraryPath」一致
// 关键 (audit 2026-09-11):dataPath 现在以 'data' 结尾(<Documents>/ResearchHub/data),
//   layout 常量不能再含 'data/' 前缀 —— 否则 join() 出 '<...>/data/data/notes'
//   双层 data 路径,父目录不存在 → createNote 抛 ENOENT
export const WORKSPACE_DATA_LAYOUT = {
  NOTES_DIR: 'notes',
  LITERATURE_DIR: 'literature',
  WORKSPACE_DIR: 'workspace',
  FAVORITES_DIR: 'workspace/favorites',
  FAVORITES_FILE: 'workspace/favorites/favorites.md',
  SETTINGS_FILE: 'settings.json',
} as const;

// 各数据文件的 schema 版本号
export const SCHEMA_VERSION = {
  FAVORITES: 1,
} as const;

// audit r29:canvas 颜色 3 处漂移 —— window.ts (BrowserWindow pre-paint, 须是
//   hex 不能走 CSS 变量) / index.html (browser pre-paint 的 inline style,
//   hex 同款限制) / globals.css :root.dark --bg-canvas-rgb (RGB 三元组,
//   供 Tailwind bg-bg-canvas)。三处值要保持一致,否则冷启动慢机会视觉闪一下
//   (renderer React 接管前那一帧的颜色不同)。与 shared/theme.ts 的
//   --bg-canvas-rgb 推导一致:7 8 10 = #07080A
export const BOOT_CANVAS_HEX_DARK = '#07080A';

// IPC 通道名
// audit-r56:删整条 library:* 操作通道(LIBRARY_LIST / RESCAN / CHANGE_PATH /
//   RESTORE_DEFAULT_PATH / CHANGED push / SCAN_PROGRESS / SCAN_DONE /
//   SCAN_PROGRESS_GET_STATE / IMPORT_FILES / IMPORT_PATHS / OPEN),settings:*
//   配套通道(SETTINGS_PICK_LIBRARY_PATH / PICK_IMPORT_ROOT)以及 library
//   归位 4 个通道(LIBRARY_MIGRATION_MOVE / KEEP / PROGRESS / GET_STATE)。
// 留下唯一一条 library:* 通道 LIBRARY_READER_FOR_FILE —— 它是「按 path 读
//   bytes 给 renderer」的 minimal 入口,rkms:// iframe 协议仍走它,只是
//   入参从 fileId 改成 absPath。
export const IPC = {
  SETTINGS_GET: 'settings:get',
  SETTINGS_UPDATE: 'settings:update',
  SETTINGS_PICK_DATA_PATH: 'settings:pick-data-path',
  SETTINGS_MIGRATE_DATA: 'settings:migrate-data',
  SETTINGS_RESTORE_DEFAULT_DATA: 'settings:restore-default-data',
  LIBRARY_READER_FOR_FILE: 'library:readFileForReader',
  // audit-r71:文献功能重建 —— resources 单表上的操作三通道(list / import / delete)。
  //   domain 起名 literature 而非 library:library:* 操作面在 r56 整体退役,
  //   ipc-handlers smoke 锁死该域恰 1 个 handler 且退役通道不得复活,新通道必须开新域。
  LITERATURE_LIST: 'literature:list',
  LITERATURE_IMPORT_FROM_FILE: 'literature:import-from-file',
  LITERATURE_DELETE: 'literature:delete',
  // r161 disk-folder:literature 真实磁盘移动(同 notes:move 语义)——
  //   fs.rename 跨目录;旧 id = 'lit:'+absPath 失效,新 id 按新 absPath 重算
  LITERATURE_MOVE: 'literature:move',
  // r187:文献**单文件**重命名(与 notes:rename-file 对称)——
  //   只改文件名,保留所在目录(旧实现没有这条通道 ⇒ 左侧文献列表
  //   右键没有「重命名」,两侧操作集不对应)。
  //   旧 id = 'lit:'+absPath 失效,新 id 按新 absPath 重算。
  LITERATURE_RENAME_FILE: 'literature:rename-file',
  // r161 disk-folder:literature 域磁盘文件夹操作 4 通道(与 notes 对称)
  LITERATURE_FOLDERS_LIST_DIRS: 'literature:folders-list-dirs',
  LITERATURE_FOLDERS_MKDIR: 'literature:folders-mkdir',
  LITERATURE_FOLDERS_RENAME_DIR: 'literature:folders-rename-dir',
  LITERATURE_FOLDERS_TRASH_DIR: 'literature:folders-trash-dir',
  // audit-r173:目录(子树)跨父目录搬移 —— fs.rename 整棵子树;返回
  //   { relPath, idRemap } 让 renderer 把选中项跟到新 id(目录里每个
  //   资源的 id 都随路径变化)
  LITERATURE_FOLDERS_MOVE_DIR: 'literature:folders-move-dir',
  // audit-r136:literature 域加 push 通道 —— 让 OS 资源管理器
  //   直接放 PDF 进 <rootPath>/literature/ 后,主进程 chokidar 监听
  //   触发 reload、emit changed,IPC.LITERATURE_CHANGED 广播到 renderer,
  //   useLiteratureStore 通过 _ensureInit 订阅 + 200ms self-write 抑制窗口
  //   自动 load({ force: true }) 拉新列表(同 notes 的 NOTES_CHANGED 模式)。
  //   audit-r211:配对的 pull 通道 LITERATURE_GET_STATE **整对下线** ——
  //   它与 LITERATURE_LIST 同源同形(都是 svc.list()),而 renderer 从来
  //   没调用过它(实测:src/renderer/ 全域零调用点,只有注释提到)。
  //   「push 可能先于 listener 注册」的竞态由「先订阅再 load」覆盖:
  //   store 模块顶层 _ensureInit 订阅 → LiteratureList 的 useEffect 里
  //   首次 load();订阅严格早于首次拉取,不存在漏事件窗口。
  LITERATURE_CHANGED: 'literature:changed',
  NOTES_LIST: 'notes:list',
  NOTES_READ: 'notes:read',
  NOTES_WRITE: 'notes:write',
  NOTES_CREATE: 'notes:create',
  // 2026-10-16 file-manager ops:NOTES_DELETE → NOTES_TRASH —— 删除从硬删
  // (fs.unlink)改走系统回收站(electron shell.trashItem),用户可恢复
  NOTES_TRASH: 'notes:trash',
  NOTES_RENAME_FILE: 'notes:rename-file',
  // r161 disk-folder:notes 真实磁盘移动 —— fs.rename 跨目录;旧 id 失效、
  //   新 id 按新 relPath 哈希重算,favorites 引用随之自愈
  NOTES_MOVE: 'notes:move',
  // r161 disk-folder:notes 域磁盘文件夹操作 4 通道
  //   - list-dirs(parentRelPath|null) -> DiskFolderNode[] 一层直接子目录
  //   - mkdir(relPath) -> { relPath } 自动递归父目录(调用方传完整 relPath)
  //   - rename-dir(oldRelPath, newName) -> { relPath } 跨级不支持,先 mkdir
  //   - trash-dir(relPath) -> null 整棵子树走 shell.trashItem(可恢复)
  NOTES_FOLDERS_LIST_DIRS: 'notes:folders-list-dirs',
  NOTES_FOLDERS_MKDIR: 'notes:folders-mkdir',
  NOTES_FOLDERS_RENAME_DIR: 'notes:folders-rename-dir',
  NOTES_FOLDERS_TRASH_DIR: 'notes:folders-trash-dir',
  // audit-r173:目录(子树)跨父目录搬移 —— fs.rename 整棵子树;返回
  //   { relPath, idRemap }(同 LITERATURE_FOLDERS_MOVE_DIR)
  NOTES_FOLDERS_MOVE_DIR: 'notes:folders-move-dir',
  NOTES_SHOW_IN_FOLDER: 'notes:show-in-folder',
  // 单文件 .md 导入:从 OS 拖入的 .md 文件 → 主进程解析 frontmatter + body
  // → 走 createNote + writeNote 写入。一次只能传一个文件(IPC 载荷最简)
  NOTES_IMPORT_FROM_FILE: 'notes:import-from-file',
  NOTES_CHANGED: 'notes:changed',
  // audit-r73 (2026-10-17):NOTES_RESCYNC_PROGRESS + 其 GET_STATE 配对整体下线 ——
  //   push 通道全项目从未有 send 点(r55「手动 resync 按钮」始终没落地),
  //   GET_STATE 无 renderer 调用方。启动期自动 resync 经 bootstrap/settings
  //   快照走,不需要独立 IPC。
  // audit-r156:settings.notesResyncPending 字段同链路一并删除(r50 M6
  //   链路从未接线,audit-r124 实证)。
  // r54 I4:Pull-snapshot 配对 —— push 通道在 renderer 启动期 / 重新 mount 时
  // 存在「push 已先于 listener 注册」的 race,pull-snapshot 让 renderer 主动
  // 拉一份当前状态作为 baseline。每个配对 push 都对应一条 GET_STATE invoke,
  // handler 返 last emit 状态(Zod schema 挡)。**现仅存一对**:
  //   - STARTUP_PROGRESS           → STARTUP_GET_STATE
  //   audit-r211:FAVORITES_GET_STATE / LITERATURE_GET_STATE 两对整对下线
  //   (实测:两者在 src/renderer/ 全域零调用点,且各自与同域的 LIST 通道
  //   同源同形 ⇒ 是空壳 API;「push 先于 listener 注册」的竞态由
  //   「先订阅再 load」覆盖,不需要额外一次 pull)。
  //   结构约束由 tests/unit/main/ipc/pull-snapshot-companion.test.ts 锁定(它同时断言「每个 GET_STATE 通道必须有真实的 renderer 调用方」—— 这一条正是当初放过两个空壳配对的漏网之鱼)。
  SEARCH_QUERY: 'search:query',
  FAVORITES_LIST: 'favorites:list',
  FAVORITES_TOGGLE: 'favorites:toggle',
  FAVORITES_CHANGED: 'favorites:changed',
  // r7:主进程 → renderer 推 toast 通道(迁移警告 / watcher 启动失败 / reload
  // 失败等场景)。renderer 在启动时注册一次 listener,把 payload 喂给
  // useToast.show()。channel 用 string 不用 enum,跨模块轻依赖
  TOAST_PUSH: 'toast:push',
  SHELL_OPEN_PATH: 'shell:open-path',
  WORKSPACE_GET_PATHS: 'workspace:get-paths',
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE_TOGGLE: 'window:maximize-toggle',
  WINDOW_CLOSE: 'window:close',
  WINDOW_IS_MAXIMIZED: 'window:is-maximized',
  WINDOW_MAXIMIZE_CHANGED: 'window:maximize-changed',
  MENU_INVOKE: 'menu:invoke',
  STARTUP_PROGRESS: 'startup:progress',
  STARTUP_GET_STATE: 'startup:get-state',
  APP_BOOTSTRAP: 'app:bootstrap',
  MENU_REBUILD: 'menu:rebuild',
} as const;

// 各模块数据目录的绝对路径
// audit-r56:library 字段退役 —— WorkspacePaths.library 删掉
export interface WorkspacePaths {
  root: string;
  notes: string;
  favorites: string;
}

export interface BootstrapPayload {
  settings: AppSettings;
  paths: WorkspacePaths;
}

// 独立收藏(★)
export interface FavoritesFileEntry {
  kind: 'file';
  id: string;
  fileId: string;
  title: string;
  relPath: string;
  addedAt: string;
}

export interface FavoritesGroupEntry {
  kind: 'group';
  id: string;
  name: string;
  description: string;
  items: FavoritesFileEntry[];
  createdAt: string;
  updatedAt: string;
}

export type FavoritesEntry = FavoritesFileEntry | FavoritesGroupEntry;

// Embedded reader
export interface ReadFileForReaderResult {
  data: Uint8Array;
  size: number;
  mtime: number;
}

// 启动期进度
// audit-r56:StartupPhase 删 'library' —— library service 整体下线;同步删
//   StartupProgressSnapshot.phases.library 字段
// audit-r136:加 'literature' —— LiteratureService 启动期 load()
//   (扫描 <rootPath>/literature/ + upsert disk-only + 删 ghost 行)走
//   独立 phase,与 notes / notes-resync 同形排队。finalizing 仍保留做
//   末段缓冲;phase 启动顺序 = notes → notes-resync → literature → finalizing。
export type StartupPhase = 'notes' | 'notes-resync' | 'literature' | 'finalizing';
export type StartupPhaseState = 'pending' | 'running' | 'done';
export interface StartupPhaseInfo {
  state: StartupPhaseState;
  // audit-r63:删 count —— 全树无 producer(progress 事件已随 r56 删除),死字段
  total?: number;
  error?: string;
}
export type ActiveStartupPhase = StartupPhase | null;
export interface StartupProgressSnapshot {
  done: boolean;
  startedAt: number | null;
  currentPhase: ActiveStartupPhase;
  phases: {
    notes: StartupPhaseInfo;
    'notes-resync': StartupPhaseInfo;
    // audit-r136:literature phase 槽位 —— startup-progress.ts 必须在
    //   freshPhases + snapshot 浅拷贝两处都加,否则 renderer 端
    //   `phases.literature === undefined`,StartupOverlay 卡死。
    literature: StartupPhaseInfo;
    finalizing: StartupPhaseInfo;
  };
  lastError: string | null;
}
// audit round 15 CQ-002:抽常量 tuple 作为 single source of truth。
//   之前 StartupProgressEvent discriminated union 的 type 字段是字面量,preload
//   守卫凭手抄列表校验,主进程新加/删除 type 时守卫不自动更新 → 事件被吞。
//   改用 as const tuple + typeof [number] 派生 union,守卫用 Set 派生,
//   删除触发 TS 编译错误,添加自动传播。
// audit-r56:删 'progress' 事件 —— 唯一 phase (library) 用它报扫描计数,library
//   下线后无 phase 需要 progress 增量事件;缩成 phase-start / phase-done /
//   all-done 三型
export const STARTUP_PROGRESS_EVENT_TYPES = [
  'phase-start',
  'phase-done',
  'all-done',
] as const;
export type StartupProgressEventType = (typeof STARTUP_PROGRESS_EVENT_TYPES)[number];

// audit-r92:toast 推送 payload 类型单源(STARTUP_PROGRESS_EVENT_TYPES 同款
//   模式,CQ-002 修法应用到 toast 通道)。此前同一 4 元组存在 5 处手抄:
//   renderer toast.tsx union / api-types onToastPush 签名 / preload handler
//   参数 + predicate 断言 ×2 / preload 运行时白名单 !== 条件链 —— 跨进程边界
//   两处守门之间零质料联动,加新 type 时 preload 白名单不改会在边界静默丢。
//   现 tuple 是权威:union 派生、守门 Set 派生、Record 穷举表自然继承。
export const TOAST_EVENT_TYPES = ['info', 'error', 'success', 'warning'] as const;
export type ToastEventType = (typeof TOAST_EVENT_TYPES)[number];
/** 主进程 → renderer TOAST_PUSH 的 wire payload 形状(preload 守卫 + main 发送点共用) */
export interface ToastPushPayload {
  type: ToastEventType;
  message: string;
  duration?: number;
}
export type StartupProgressEvent =
  | { type: 'phase-start'; phase: StartupPhase; total?: number }
  | { type: 'phase-done'; phase: StartupPhase; ok: boolean; error?: string }
  | { type: 'all-done' };

// IpcResult
//
// audit v2.0 Phase 0c:`code` 字段从 `string` 收窄到 `IpcErrorCode` 联合类型。
// 单一真相源是 `IPC_ERROR_CODES` const tuple(下面),新增错误码必须改这一处
// + 对应 throw 站点。renderer 端 `IpcError.code: IpcErrorCode` 编译期穷尽性
// 检查,误打 `'DUPLICATE_NAMES'`(多了 s)等 typo 会立刻报红。主进程 `AppError`
// 仍接受任意 string 参数(向后兼容),但在 src/main/ipc/wrap.ts:handle 出口处
// 的 cast 会校验 wire-format code 是否落在 union 内,新码需先加入 tuple。
//
// 顺序**不参与语义**(union 只看成员集合),但历史上按插入顺序追加 ——
// 增删后保持原位以减少 diff 噪音。别再宣称"按字面字符序":CONFLICT /
// SETTINGS_* 几项是后来插入的,并不满足字符序(2026-10-20,r203 更正)。
export const IPC_ERROR_CODES = [
  // r51:BACK_PRESSURE — WriteLock 队列溢出时抛(queue depth >= maxQueue 同步
  // throw,见 utils/write-lock.ts)。透传到 wrap.ts 后由 IpcResult.code 收窄到
  // union,renderer/preload 据此给「系统繁忙,稍后重试」提示而非误诊为 INTERNAL
  'BACK_PRESSURE',
  // r37:删重复 'CONFLICT' —— 上一行 r35 commit 时误以为 union 缺这个 code,
  // 实际 line 539 已有,但 r35 注释把它当「新加」补了一次。Set 去重让运行时
  // 无影响,但未来删/改 CONFLICT 时一处漏改会让 wrap.ts:86 走 INTERNAL 兜底,
  // r35 T1 修过的 conflict 路径再次退化为「internal error」提示。配 guard test
  // `tests/unit/shared/ipc-error-codes-dup.test.ts` 反向锁「tuple 元素互不重复」,
  // 后续合并冲突再发同类型问题会立刻报红
  'DUPLICATE_NAME',
  'EACCES',
  'EINVAL',
  'ENOENT',
  'EOPEN',
  'EPERM',
  'FILE_MISSING',
  'INTERNAL',
  'INVALID_INPUT',
  'IO_ERROR',
  'IPC_REJECTED',
  'MIGRATION_FAILED',
  'MIGRATION_ROLLBACK_FAILED',
  // r35 T1:CONFLICT 是 NOTES_WRITE 的 expectedMtime 冲突抛出的 code。
  // renderer 端 store/notes.ts:290 与 StandaloneNoteEditorCore.tsx:363 都判
  // `err.code === 'CONFLICT'` 走「外部修改,重载」提示路径。原本漏列在 union
  // 里 → wrap.ts:86 走「not in union, fallback INTERNAL」分支,renderer 收到
  // INTERNAL,saveConflictToast 永远不触发 → 用户看到的「internal error」与
  // 「外部修改」是完全不同的诊断信号
  'CONFLICT',
  'NOT_FOUND',
  'NOT_READY',
  // r163 M4:settings.json corruption + quarantine 都失败时抛。renderer 据
  //   此走「清 settings.json 后重启」指引,而非通用 IO_ERROR 误诊。
  'SETTINGS_CORRUPTED',
  // r200:settings.json **读不到**(EACCES/EPERM/EBUSY/EIO/EISDIR)时抛。
  //   与 SETTINGS_CORRUPTED 分开:这里文件内容可能完好,只是此刻读不到 ——
  //   处置是「关掉占用它的程序 / 修权限后重启」,**不要**删文件。旧实现
  //   把读失败当 corrupt 处理(rename 走 + 用默认值覆盖)⇒ 用户设置全丢。
  //   必须列进 union:wrap.ts 对 union 外的 code 会 fallback INTERNAL **并
  //   擦除 message**,那样这条自救指引就传不到用户眼前。
  'SETTINGS_UNREADABLE',
  'TOO_LARGE',
  'UNSAFE_WRITE',
  'VALIDATION',
] as const;

export type IpcErrorCode = (typeof IPC_ERROR_CODES)[number];

// runtime guard — wire 边界校验,防止 main process throw 一个没在 union 里的
// code(例如未来加新 code 但忘了扩 IPC_ERROR_CODES)直接糊到 renderer。fallback
// 到 'INTERNAL' + warn,让用户至少看到通用错误,不出现 type smuggling
const IPC_ERROR_CODE_SET: ReadonlySet<IpcErrorCode> = new Set(IPC_ERROR_CODES);
export function isIpcErrorCode(code: string): code is IpcErrorCode {
  return IPC_ERROR_CODE_SET.has(code as IpcErrorCode);
}

export type IpcResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      code: IpcErrorCode;
      message: string;
      field?: string;
      size?: number;
    };

// audit-r140:删 `status?: number` 与 `body?: string` —— wrap.ts mapErrorToEnvelope
//   只在 INTERNAL / VALIDATION / LibraryError.TOO_LARGE 三处设 result 字段
//   (code / message / field / size),从未设置 status / body(0 producer),renderer
//   IpcError 类同款字段也无 reader。包络上承诺 0 兑现 = 跨版本契约虚位,
//   删干净让 IpcError shape 与 wire 实际形状 1:1 对齐。
