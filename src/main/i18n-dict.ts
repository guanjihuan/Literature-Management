// src/main/i18n-dict.ts
//
// r165 (2026-10-19) 分层硬不变式:零上游 import 的字典叶子模块。
//
// 抽出原因:src/main/i18n.ts ↔ src/main/utils/safe-write.ts 通过
//   i18n → settings/store → safe-write → i18n 形成循环依赖
//   (layering.test.ts 持续红)。解法:把 T 字典与 Lang 类型从 i18n.ts
//   抽到本零依赖文件,safe-write.ts 直接从这里 import T(绕开 i18n.ts),
//   当前语言由 setI18nLangProvider 注册的 getter 解析(bin/index.ts 在
//   启动早期一次注入,setter 之前任何 tr() 调用回退 zh-CN)。
//
// 不引 main 侧任何东西(electron / fs / settings / ...),让本文件可在
// 任何地方 import 而不引发新环。

import type { AppSettings } from '../shared/types';

/** 单一真相源 —— 与 i18n.ts 的 Lang 等价,但本文件可独立 import。 */
export type Lang = NonNullable<AppSettings['language']>;

type Dict = Record<Lang, string>;
type Entry = Record<string, Dict>;

export const T: Entry = {
  // App / File / Edit / View / Window / Help 菜单
  'menu.preferences': { 'zh-CN': '偏好设置…', 'en-US': 'Preferences…' },
  'menu.file': { 'zh-CN': '文件', 'en-US': 'File' },
  'menu.file.newNote': { 'zh-CN': '新建笔记', 'en-US': 'New Note' },
  'menu.file.save': { 'zh-CN': '保存', 'en-US': 'Save' },
  // Edit 菜单依赖系统 role 自带本地化,这里只占位
  'menu.edit': { 'zh-CN': '编辑', 'en-US': 'Edit' },
  'menu.view': { 'zh-CN': '视图', 'en-US': 'View' },
  // r242:左侧列表面板折叠 / 展开(与标题栏按钮、renderer ⌘B 同一命令)
  'menu.view.toggleSidebar': {
    'zh-CN': '折叠 / 展开左侧栏',
    'en-US': 'Toggle Sidebar',
  },
  'menu.view.toggleStatusBar': {
    'zh-CN': '折叠 / 展开 Status Bar',
    'en-US': 'Toggle Status Bar',
  },
  'menu.window': { 'zh-CN': '窗口', 'en-US': 'Window' },
  'menu.help.openSettings': { 'zh-CN': '打开设置', 'en-US': 'Open Settings' },

  // Window title / 启动失败 dialog / renderer 生命周期
  'window.title': { 'zh-CN': '文献管理', 'en-US': 'Literature Management' },
  'error.startupFailed': { 'zh-CN': '启动失败', 'en-US': 'Startup failed' },
  'error.windowCreateFailed': {
    'zh-CN': '窗口创建失败',
    'en-US': 'Failed to create window',
  },
  'error.notesServiceFailed': {
    'zh-CN': '笔记服务启动失败',
    'en-US': 'Notes service failed to start',
  },
  'error.favoritesServiceFailed': {
    'zh-CN': '收藏服务启动失败',
    'en-US': 'Favorites service failed to start',
  },
  'error.unhandledException': {
    'zh-CN': '未捕获异常',
    'en-US': 'Unhandled exception',
  },
  'error.unhandledRejection': {
    'zh-CN': '未处理的 Promise 拒绝',
    'en-US': 'Unhandled promise rejection',
  },
  'error.notesWatcherFailed': {
    'zh-CN': '笔记监听失败',
    'en-US': 'Notes watcher failed',
  },
  'error.notesReloadFailed': {
    'zh-CN': '笔记重载失败',
    'en-US': 'Notes reload failed',
  },
  // audit-r136:literature watcher 失败 / reload 失败 toast —— 与 notes 同款
  //   词条,推送给 renderer 走 IPC.TOAST_PUSH(主进程 index.ts 的 watcherToast
  //   helper 桥接)。失败语义:连续重启超上限(同 notes MAX_NOTES_AUTO_RESTARTS
  //   阈值)触发 watcher-failed,或 reload 抛错触发 reload-failed。
  'error.literatureWatcherFailed': {
    'zh-CN': '文献监听失败',
    'en-US': 'Literature watcher failed',
  },
  'error.literatureReloadFailed': {
    'zh-CN': '文献重载失败',
    'en-US': 'Literature reload failed',
  },
  // 五种 Electron renderer 错误统一 toast 给用户,避免白屏无响应
  'error.rendererLoadFailed': {
    'zh-CN': '渲染进程加载失败,正在重试',
    'en-US': 'Renderer failed to load, retrying',
  },
  // audit-r124:window.ts r28 重试耗尽分支一直在 t() 本 key,词表从未收录
  //   → 用户重试烧完后收到裸 key 字符串(「error.rendererLoadFailedFinal」)
  //   或空 toast。补齐双词条。
  'error.rendererLoadFailedFinal': {
    'zh-CN': '渲染进程连续加载失败,请重启应用;仍失败请重新安装',
    'en-US': 'Renderer keeps failing to load — restart the app; if it persists, reinstall',
  },
  'error.rendererCrashed': {
    'zh-CN': '渲染进程崩溃,正在重启',
    'en-US': 'Renderer crashed, reloading',
  },
  'error.rendererUnresponsive': {
    'zh-CN': '渲染进程无响应',
    'en-US': 'Renderer is unresponsive',
  },
  'error.rendererGone': {
    'zh-CN': '渲染进程已退出 ({reason}),正在重启',
    'en-US': 'Renderer process gone ({reason}), reloading',
  },
  'error.childProcessGone': {
    'zh-CN': '子进程已退出 ({reason})',
    'en-US': 'Child process gone ({reason})',
  },

  // 文件夹选择对话框(SETTINGS_PICK_DATA_PATH)
  'settings.pickerData': { 'zh-CN': '选择数据文件夹', 'en-US': 'Data folder' },

  // Library / Notes / Validation 错误
  'library.fileMissing': { 'zh-CN': '文件路径为空', 'en-US': 'File path is empty' },
  'library.fileMoved': {
    'zh-CN': '文件不存在或已被移动',
    'en-US': 'File no longer exists or has been moved',
  },
  'library.fileTooLarge': { 'zh-CN': '文件过大', 'en-US': 'File too large' },
  'library.noPermission': {
    'zh-CN': '无权限读取此文件',
    'en-US': 'No permission to read this file',
  },
  'library.notAFile': {
    'zh-CN': '不是文件,无法读取',
    'en-US': 'Not a regular file, cannot read',
  },
  'notes.frontmatterParseFailed': {
    'zh-CN': '笔记「{path}」 frontmatter 解析失败: {reason}',
    'en-US': 'Failed to parse frontmatter of note "{path}": {reason}',
  },
  'notes.writeReadbackFailed': {
    'zh-CN': '写入后无法立即读回笔记',
    'en-US': 'Could not read back note after write',
  },
  'notes.createReadbackFailed': {
    'zh-CN': '新建笔记后无法立即读回',
    'en-US': 'Could not read back note after creation',
  },
  'notes.renameReadbackFailed': {
    'zh-CN': '重命名后无法立即读回',
    'en-US': 'Could not read back note after rename',
  },
  'notes.notFound': { 'zh-CN': '笔记 {id} 不存在', 'en-US': 'Note {id} does not exist' },
  'notes.notFoundPath': {
    'zh-CN': '笔记「{path}」不存在',
    'en-US': 'Note "{path}" does not exist',
  },
  'notes.duplicateName': {
    'zh-CN': '已存在同名笔记「{name}」',
    'en-US': 'A note with the same name "{name}" already exists',
  },
  'notes.createFailed': {
    'zh-CN': '无法创建笔记「{name}」: {reason}',
    'en-US': 'Failed to create note "{name}": {reason}',
  },
  'notes.renameNewFailed': {
    'zh-CN': '无法写入新笔记「{path}」: {reason}',
    'en-US': 'Failed to write renamed note "{path}": {reason}',
  },
  'notes.deleteOldFailed': {
    'zh-CN': '无法删除原笔记「{path}」: {reason}',
    'en-US': 'Failed to delete original note "{path}": {reason}',
  },
  // r161+ disk-folder Phase 2b:跨文件夹移动失败
  'notes.moveFailed': {
    'zh-CN': '无法移动笔记「{path}」: {reason}',
    'en-US': 'Failed to move note "{path}": {reason}',
  },
  'notes.moveReadbackFailed': {
    'zh-CN': '移动后无法读取笔记「{path}」',
    'en-US': 'Failed to read back note after move "{path}"',
  },
  // audit-r160:safeTrash 三条 throw 的本地化文案 —— 原实现把 ${resolved}
  //   绝对路径拼进 message,wrap.ts 非 INTERNAL 分支原样透传 IPC wire,把
  //   用户家目录 / OneDrive 路径暴露给 renderer / telemetry。改走 tr() 固定
  //   双语文案,绝对路径改由主进程 log 留痕(IPC 边界外的诊断信号)。
  'notes.trashRefusedSymlink': {
    'zh-CN': '无法移入回收站:文件是符号链接',
    'en-US': 'Cannot move to trash: file is a symbolic link',
  },
  'notes.trashRefusedNonRegular': {
    'zh-CN': '无法移入回收站:不是常规文件',
    'en-US': 'Cannot move to trash: not a regular file',
  },
  'notes.trashFailed': {
    'zh-CN': '移入回收站失败: {reason}',
    'en-US': 'Failed to move to trash: {reason}',
  },
  'notes.renameDbSyncFailed': {
    'zh-CN': '重命名后 DB 同步失败: {reason}',
    'en-US': 'Failed to sync database after rename: {reason}',
  },
  // audit-r155:write id-repin 路径(外部 fm.id 覆写或副本重映射)DB 旧行
  //   delete 失败 —— 旧实现 best-effort swallow,留下 DB + byId 双键漂移
  //   (搜索命中死行)。改为显式 IO_ERROR 上抛,chokidar 后续 self-heal byId。
  'notes.idRepinDbSyncFailed': {
    'zh-CN': 'id 重映射后旧行清理失败({oldId} → {newId}): {reason}',
    'en-US': 'Failed to clean up old row after id repin ({oldId} → {newId}): {reason}',
  },
  // 外部 mtime 与 expectedMtime 不一致 → CONFLICT,renderer 走冲突 UI
  'notes.modifiedExternally': {
    'zh-CN': '笔记被外部修改(磁盘 mtime {actual} ≠ 期望 {expected})',
    'en-US': 'Note was modified externally (disk mtime {actual} ≠ expected {expected})',
  },
  'notes.invalidExpectedMtime': {
    'zh-CN': 'expectedMtime 参数非法: {value}',
    'en-US': 'Invalid expectedMtime parameter: {value}',
  },
  // OS 拖入 .md 导入错误
  'notes.importNotMd': {
    'zh-CN': '「{name}」不是 .md 文件,无法作为笔记导入',
    'en-US': '"{name}" is not a .md file and cannot be imported as a note',
  },
  'notes.importTooLarge': {
    'zh-CN': '笔记文件过大 ({size} 字节),上限 5MB',
    'en-US': 'Note file too large ({size} bytes, max 5MB)',
  },
  'notes.importFailed': {
    'zh-CN': '读取源文件失败: {reason}',
    'en-US': 'Failed to read source file: {reason}',
  },

  // 文献导入 / 删除(audit-r71,src/main/literature/import.ts)
  'literature.importNotRegularFile': {
    'zh-CN': '「{name}」不是普通文件,无法作为文献导入',
    'en-US': '"{name}" is not a regular file and cannot be imported as literature',
  },
  'literature.importTooLarge': {
    'zh-CN': '「{name}」过大({size} 字节),文献导入上限 500MB',
    'en-US': '"{name}" is too large ({size} bytes; literature import limit is 500MB)',
  },
  'literature.importFailed': {
    'zh-CN': '导入文献「{name}」失败: {reason}',
    'en-US': 'Failed to import literature "{name}": {reason}',
  },
  'literature.removeFailed': {
    'zh-CN': '删除文献文件「{name}」失败: {reason}',
    'en-US': 'Failed to delete literature file "{name}": {reason}',
  },
  'literature.notFound': {
    'zh-CN': '文献条目不存在: {id}',
    'en-US': 'Literature entry not found: {id}',
  },
  // r161+ disk-folder Phase 2b:文献跨文件夹移动失败
  'literature.moveFailed': {
    'zh-CN': '无法移动文献「{name}」: {reason}',
    'en-US': 'Failed to move literature "{name}": {reason}',
  },
  'literature.moveTargetExists': {
    'zh-CN': '目标位置已存在文献「{name}」',
    'en-US': 'A literature file already exists at the target "{name}"',
  },
  // r187:文献单文件重命名(与 notes 侧改名同款文案粒度)
  'literature.renameInvalidName': {
    'zh-CN': '文件名「{name}」不合法(不能含路径分隔符或保留字符)',
    'en-US': 'Invalid file name "{name}" (no path separators or reserved characters)',
  },
  'literature.renameTargetExists': {
    'zh-CN': '目标位置已存在文献「{name}」',
    'en-US': 'A literature file already exists at the target "{name}"',
  },
  'literature.renameFailed': {
    'zh-CN': '重命名文献「{name}」失败: {reason}',
    'en-US': 'Failed to rename literature "{name}": {reason}',
  },
  // audit-r160:search IPC 把脏 resource id 翻译为 VALIDATION —— 之前走 INTERNAL
  //   兜底,renderer 看到通用「内部错误」,实际是 DB 脏数据 / 0005 残留 / 手改
  //   .md 引入非法 prefix。双语文案走 tr() 与其它 notFound 同款。
  'search.badResourceId': {
    'zh-CN': '搜索结果中的资源 ID 无效: {id}',
    'en-US': 'Invalid resource ID in search results: {id}',
  },

  // r161+ 真实磁盘文件夹操作(safe-write.ts safeMkdir / safeRecursiveTrash)
  //   + ipc/folders.ts 撞名检测。
  //   audit-r206 (2026-10-20):原「虚拟文件夹(0007)」域的 folder.* 文案与
  //   diskFolder.{notFound,moveFailed,invalidRelPath} 三条**零消费者** ——
  //   虚拟文件夹已随 migration 0008 drop_folders 退役,磁盘层错误一律走
  //   diskFolder.*。三者的「留待未来复用」在 13 个条目上躺了数月,零引用
  //   ⇒ 一并删除,并加守卫 tests/unit/main/menu-label-i18n-keys.test.ts
  //   (主进程字典不许出现零引用 key)。
  'diskFolder.mkdirRefusedSymlink': {
    'zh-CN': '无法在符号链接上创建文件夹',
    'en-US': 'Cannot create folder on a symbolic link',
  },
  'diskFolder.mkdirRefusedNonDir': {
    'zh-CN': '目标路径已被占用且不是文件夹',
    'en-US': 'Target path is already occupied and is not a folder',
  },
  'diskFolder.trashRefusedSymlink': {
    'zh-CN': '无法删除符号链接(防止越界)',
    'en-US': 'Cannot delete a symbolic link (refuses to follow)',
  },
  'diskFolder.trashRefusedNonDir': {
    'zh-CN': '目标路径不是文件夹',
    'en-US': 'Target path is not a folder',
  },
  'diskFolder.trashFailed': {
    'zh-CN': '删除文件夹失败: {reason}',
    'en-US': 'Failed to trash folder: {reason}',
  },
  'diskFolder.duplicateName': {
    'zh-CN': '同级已存在同名文件夹「{name}」',
    'en-US': 'A sibling folder named "{name}" already exists',
  },

  // 文件名校验
  'validation.noteFilenameEmpty': {
    'zh-CN': '新文件名不能为空',
    'en-US': 'New filename cannot be empty',
  },
  'validation.noteFilenameEmptyOriginal': {
    'zh-CN': '笔记文件名不能为空',
    'en-US': 'Note filename cannot be empty',
  },
  'validation.noteFilenameInvalidChars': {
    'zh-CN': '笔记文件名「{name}」包含非法字符',
    'en-US': 'Note filename "{name}" contains invalid characters',
  },
  'validation.noteFilenameTooLong': {
    'zh-CN': '笔记文件名过长({len} 字,上限 {max})',
    'en-US': 'Note filename too long ({len} characters, max {max})',
  },
  'validation.noteFilenameReserved': {
    'zh-CN': '笔记文件名段「{seg}」是 Windows 系统保留名',
    'en-US': 'Filename segment "{seg}" is a Windows reserved device name',
  },
  // r195:改名只改文件名、不改位置(r175 不变式)⇒ 改名框里不许带路径分隔符。
  'validation.noteFilenamePathSeparator': {
    'zh-CN': '笔记文件名「{name}」不能包含路径分隔符(改名只改文件名,不改所在文件夹)',
    'en-US': 'Note filename "{name}" cannot contain a path separator (rename changes the name only, not the folder)',
  },
};

/** 与 i18n.ts 的 t() 等价 —— safe-write.ts 的本地 tr() 调用本函数。 */
export function resolveT(
  key: string,
  lang: Lang,
  params?: Record<string, string | number>,
): string {
  const entry = T[key];
  if (!entry) return key;
  let s = entry[lang] ?? entry['zh-CN'] ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.replaceAll(`{${k}}`, String(v));
    }
  }
  return s;
}
