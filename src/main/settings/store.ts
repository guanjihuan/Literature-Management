// 设置存储:在数据路径下读写 settings.json
import { app } from 'electron';
import { promises as fs } from 'fs';
import { join, resolve } from 'path';
import { AppSettings, DEFAULT_SETTINGS, WORKSPACE_DATA_LAYOUT } from '@shared/types';
import { safeWriteFileAtomic, atomicWriteFileInternal, safeCloseFh } from '../utils/safe-write';
import { createLogger } from '../utils/logger';
import { writeLocation } from '../location';
import { AppError, errnoCode, errMsg } from '../utils/error';
import { isDeepStrictEqual } from 'node:util';
// 并发 updateSettings 走 updateLock 串行化(防两 patch 互相覆盖)—— 与
// LibraryService / NotesService 共用 utils/write-lock.ts
import { WriteLock } from '../utils/write-lock';
import { sanitizeLoadedSettings } from './validate';
import { isSameDir } from '../utils/path-compare';
import { MAX_SETTINGS_BYTES } from '../ipc/path-limits';
// audit r200:读 settings.json 也走 transient 退避 —— Windows 上同步盘 /
// 杀毒软件短暂持句柄会让 open 报 EPERM/EBUSY,那是「重试一下就好」,
// 不该被当成「文件损坏」(与 atomic-file 的读路径同款处理)
import { retryOnWindowsTransient } from '../utils/retry-transient';

const log = createLogger('settings');

// 单 fd 拿 size check + content — 替代 fs.stat → fs.readFile 两步走法(后者
// stat 与 read 之间存在 TOCTOU 窗口,cap 校验可能跑在错 inode 上)
async function readFileCapped(path: string, cap: number): Promise<string> {
  let fh: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    fh = await fs.open(path, 'r');
    const st = await fh.stat();
    if (st.size > cap) {
      throw new AppError(
        'IO_ERROR',
        `${path} exceeds ${cap} bytes (got ${st.size}); refusing to load oversized config`,
      );
    }
    return await fh.readFile('utf-8');
  } finally {
    // safeCloseFh 统一 close 失败日志形态,Windows stale handle 偶发 EBUSY
    // 时 fd 泄漏信号不再消失
    await safeCloseFh(fh, 'fh.close failed in readFileCapped finally', log, { path });
  }
}

let currentSettings: AppSettings | null = null;
let settingsPath: string | null = null;
// 串行化锁:两个 IPC 同时调,A: 读 → B: 读 → A: 写 patch1 → B: 写 patch2,
// B 的快照不含 patch1 → patch1 静默丢失
const updateLock = new WriteLock();

/** 消解「settings.json 自述路径」与「文件实际所在目录」的分叉。
 *  自述与实际位置一致才可信;不一致说明文件从别处搬来 / 被手改过,采信会让
 *  getSettings().rootPath 与 getRootPath() 分叉,下游读写落在不同磁盘位置。
 *  用 isSameDir(尾部分隔符 / 分隔符风格 / 大小写统一)避免
 *  C:/Users/foo/data 与 C:\Users\foo\data 误判分叉 */
function reconcileRootPath(claimed: string | undefined, actualDataPath: string): string {
  if (!claimed) return actualDataPath;
  if (isSameDir(claimed, actualDataPath)) return actualDataPath;
  log.warn('settings.json rootPath disagrees with its own location; using actual directory', {
    claimed,
    actual: actualDataPath,
  });
  return actualDataPath;
}

export async function initSettings(dataPath: string): Promise<AppSettings> {
  settingsPath = join(dataPath, WORKSPACE_DATA_LAYOUT.SETTINGS_FILE);
  // 本地副本:module-level 的 settingsPath 是 `string | null`,TS 在闭包
  // (retryOnWindowsTransient 的 action 回调)里丢失窄化 ⇒ 读盘调用点拿到
  // `string | null`。这里抓一份确定是 string 的局部引用给读 / 写路径用。
  const settingsFile = settingsPath;
  await fs.mkdir(dataPath, { recursive: true });
  // 本函数读的就是 dataPath 下的 settings.json,「工作目录根」在定义上 = dataPath
  const resolvedDataPath = resolve(dataPath);

  // symlink 守卫:dataPath 在用户机器上,若被恶意 mklink settings.json → 别的
  // 文件,readFile 会 follow 读到对方内容,sanitizeLoadedSettings 把错误配置
  // 加载到 currentSettings。本地 minimal lstat(不能调 assertNotSymlink ——
  // 其 allowedRoots 依赖 getSettings(),而 initSettings 还没设 currentSettings,
  // 会自抛 INTERNAL 把 fail-fast 误退成 fail-closed)
  try {
    const lst = await fs.lstat(settingsPath);
    if (lst.isSymbolicLink()) {
      throw new AppError(
        'VALIDATION',
        `settings.json is a symbolic link — refusing to follow (${settingsPath})`,
      );
    }
  } catch (err: unknown) {
    if (err instanceof AppError) throw err;
    const code = errnoCode(err);
    if (code !== 'ENOENT') {
      // security 关键路径不静默放过,lstat 失败(EACCES / EIO / ELOOP) 显式 warn
      log.warn('settings.json lstat failed (continuing with defaults)', {
        path: settingsPath,
        err: errMsg(err),
      });
    }
  }

  let loaded: Partial<AppSettings> = {};
  //
  // audit r200 (2026-10-20):**读失败 ≠ 文件损坏** —— r199(atomic-file 同一
  // bug 类)的上层版本。旧实现把 readFileCapped 与 JSON.parse 裹在**同一个
  // try** 里 ⇒ 除 ENOENT / IO_ERROR 外的**任何读错误**(EACCES 权限 /
  // EPERM / EBUSY 被占用 / EIO / EISDIR 路径其实是目录)都落进「corrupt」
  // 分支 ⇒
  //   1. **rename 走用户的 settings.json**(内容可能完好,只是此刻读不到);
  //   2. loaded 保持 {} ⇒ currentSettings = DEFAULT_SETTINGS;
  //   3. 函数末尾 saveSettings() 用**默认值**写出一个**新的** settings.json
  //      ⇒ 主题 / 语言 / 布局 / extraImportRoots 等用户设置**全丢**
  //      (原文件只剩 settings.json.corrupt-<ts>.json 一份,而它并不是坏文件)。
  // 一句话:一次瞬时读失败 = 用户设置被重置 —— 与本函数自己对 size-cap 的
  // 策略注释「让首启崩比『静默接受 defaults 覆盖用户设置』更安全」自相矛盾。
  //
  // 新契约(**读 / 解析两阶段独立处置**):
  //   读阶段 —— ENOENT → 正常首启走默认值;IO_ERROR(size cap)→ 照旧抛;
  //     **其它读错误 → fail-closed 抛错**:不 rename、不写默认值,文件原封
  //     不动留在盘上,让用户自己处理(关掉占用它的同步盘 / 编辑器 / 杀毒,
  //     或修权限),然后重启;
  //   解析阶段 —— JSON.parse 抛错(SyntaxError,**无 errno code**)才说明
  //     「内容坏了」→ 走原来的 quarantine 阶梯(保留手编辑内容)。
  let raw: string | null = null;
  try {
    // 读也走 transient 退避:Windows 上 AV / OneDrive 短暂持句柄会让 open
    // 报 EPERM/EBUSY —— 那是「重试一下就好」,不该被当成损坏。
    raw = await retryOnWindowsTransient(
      () => readFileCapped(settingsFile, MAX_SETTINGS_BYTES),
      () => Promise.resolve(), // 读失败没有 tmp 残留要清
    );
  } catch (err: unknown) {
    const code = errnoCode(err);
    if (code === 'ENOENT') {
      // 正常首启,settings.json 还不存在 → 走默认值
    } else if (code === 'IO_ERROR') {
      // size cap 主动抛,有意 fail-closed —— 超大说明磁盘被异常写入或 IPC 边界
      // 被绕过,让首启崩比「静默接受 defaults 覆盖用户设置」更安全
      // 不 quarantine:rename 走会让用户失去原文件,应自己看到错误决定
      throw err;
    } else {
      // **读失败** —— 不是「文件损坏」。fail-closed(与上面的 size-cap 同款
      // 理由):不 rename(那是破坏用户数据)、不写默认值(那会覆盖用户设置)。
      // 错误文案要能指导用户自救:关掉占用它的程序 / 修权限,而不是「删掉
      // settings.json」(那才是真正的数据销毁)。
      throw new AppError(
        'SETTINGS_UNREADABLE',
        `settings.json at ${settingsPath} could not be read (${errMsg(err)}). ` +
          `It was left untouched on disk — close whatever is holding it (sync client / ` +
          `antivirus / editor) or fix its permissions, then restart. Refusing to start ` +
          `with default settings, because that would overwrite your existing settings.`,
        err,
      );
    }
  }
  if (raw !== null) {
    try {
      // 走 sanitizeLoadedSettings 与 IPC update 路径同源 —— 手工编辑 / 老版本
      // 残留写非法 theme='rainbow' / workspaceLayout.statusBarHidden='yes'
      // 会被丢弃,DEFAULT_SETTINGS 接管,防下游静默失效或 TypeError
      loaded = sanitizeLoadedSettings(JSON.parse(raw));
      log.info('Settings loaded from', settingsPath);
    } catch (err: unknown) {
      // 真·corrupt JSON(JSON.parse 抛 SyntaxError,无 errno code):quarantine 到
      // .corrupt-<unix-ms>.json,用户可在 dataPath 找回手编辑内容,而不是被
      // 默认值无声覆盖后找不到
      try {
        const quarantineName = `settings.json.corrupt-${Date.now()}.json`;
        const quarantinePath = join(dataPath, quarantineName);
        await fs.rename(settingsPath, quarantinePath);
        log.warn('settings.json is corrupt, quarantined to', {
          from: settingsPath,
          to: quarantinePath,
          err: errMsg(err),
        });
      } catch (renameErr: unknown) {
        // quarantine 失败必须 fail-closed:旧实现只 log 继续,代价是本函数末尾
        // 的 saveSettings() 拿 DEFAULT_SETTINGS 覆盖掉损坏原文件 —— quarantine
        // 唯一作用(保住用户手编辑内容)在它失败时不仅没生效,反而毁了唯一可
        // 恢复副本
        log.error('settings.json is corrupt AND could not be quarantined', {
          path: settingsPath,
          readErr: errMsg(err),
          renameErr: errMsg(renameErr),
        });
        throw new AppError(
          'SETTINGS_CORRUPTED',
          `settings.json at ${settingsPath} is unreadable (${errMsg(err)}) and could not be ` +
            `preserved (${errMsg(renameErr)}). Refusing to start, because continuing would ` +
            `overwrite the only copy of your settings. Move or delete that file manually, ` +
            `then restart.`,
          err,
        );
      }
    }
  }

  currentSettings = {
    ...DEFAULT_SETTINGS,
    ...loaded,
    // rootPath 取值优先级 ① loaded.rootPath ② loaded.dataPath ③ resolvedDataPath
    // ①② 都要先与「本文件实际所在目录」对齐 —— 旧实现无条件信任文件里的
    // 自述,但自述可能指向别的目录(changeDataPath 旧版逐字复制 / 手工编辑 /
    // 备份恢复),一旦采信,getSettings().rootPath 与 getRootPath()(safe-write
    // 单例,由 location.json 解析)就永久分叉,下游读写落在不同位置
    rootPath: reconcileRootPath(loaded.rootPath ?? loaded.dataPath, resolvedDataPath),
    // dataPath 镜像写入:降级到旧版本时仍能启动(见 AppSettings @deprecated)
    dataPath: reconcileRootPath(loaded.rootPath ?? loaded.dataPath, resolvedDataPath),
    version: app.getVersion(),
  } as AppSettings;

  // audit-r163 N1:首启场景(loaded === 空对象 / 全 DEFAULT)跳过 saveSettings —
  //   旧实现末尾无条件 await saveSettings(),用户每开 app 一次首启无意义写盘
  //   + 触发 mtime 变化让下游 chokidar / fsevents 误以为 settings.json 改了
  //   唤醒 inotify(浪费 IO)。比对 next 是否等于「DEFAULT + 实际 dataPath +
  //   当前 version」(首启形态),若等则跳过 saveSettings 直接 return。
  // 防误伤:loaded 含任意用户字段(theme / language / workspaceLayout 等)
  //   → next 必不等默认 → 走 saveSettings(用户编辑仍落盘)。仅完全首启
  //   才走 skip,无回归风险。
  const freshDefault: AppSettings = {
    ...DEFAULT_SETTINGS,
    rootPath: resolvedDataPath,
    dataPath: resolvedDataPath,
    version: app.getVersion(),
  };
  if (isDeepStrictEqual(currentSettings, freshDefault)) {
    return currentSettings;
  }
  await saveSettings();
  return currentSettings;
}

export function getSettings(): AppSettings {
  if (!currentSettings) throw new AppError('INTERNAL', 'Settings not initialized');
  return currentSettings;
}

/** 回滚 module-level settings —— migration 失败时还原到旧快照。
 *  initSettings(newPath) 会把 currentSettings / settingsPath 指向 newPath,
 *  但 location.json / setDataPath / initDB rollback 后只还原磁盘状态;
 *  currentSettings 仍指向 newPath → 后续 updateSettings 写到新路径。
 *  返回旧快照供 caller(罕见)复用 */
export function resetSettings(prev: { current: AppSettings; path: string }): {
  current: AppSettings;
  path: string;
} {
  currentSettings = prev.current;
  settingsPath = prev.path;
  return prev;
}

/** 抓 module-level settings 当前快照 —— switchDataPath 在 initSettings(newPath)
 *  之前捕获 currentPath 状态,失败时给 resetSettings 还原。
 *  必须在 initSettings(newPath) 之前调用 —— 一旦改了 currentSettings,快照
 *  就丢失 currentPath 数据,resetSettings 还原成「新路径数据」无意义 */
export function captureSettingsSnapshot(): { current: AppSettings; path: string } {
  if (!currentSettings || !settingsPath) {
    // 理论上不可达(switchDataPath 只在 initSettings(currentPath) 成功后进入),
    // 仍抛清晰错误避免 reset 成 null
    throw new AppError('INTERNAL', 'Settings not initialized before switchDataPath');
  }
  return { current: currentSettings, path: settingsPath };
}

export async function saveSettings(value?: AppSettings): Promise<void> {
  if (!currentSettings || !settingsPath) throw new AppError('INTERNAL', 'Settings not initialized');
  // 可选参数 — updateSettings 需要「先落盘、成功后才改内存」
  const source = value ?? currentSettings;
  const next = JSON.stringify(source, null, 2);
  // 写盘侧体积闸门(系统性,不是逐字段补丁):
  // 写侧原本无 cap,读侧 cap = 1MB → 任意字段撑大序列化结果就能永久砖化启动
  // (r56 enabledExtensions 缺 cap 一次 IPC 写出 6MB;新加字段不变式仍在,系统
  // 性闸门一视同仁,与读侧同源不再漂移)。fail-closed:宁可这次写入失败也
  // 不能写出一个下次启动读不回来的文件;旧 settings.json 抛错前完好
  const nextBytes = Buffer.byteLength(next, 'utf8');
  if (nextBytes > MAX_SETTINGS_BYTES) {
    throw new AppError(
      'VALIDATION',
      `Refusing to write settings.json of ${nextBytes} bytes — it would exceed the ` +
        `${MAX_SETTINGS_BYTES}-byte read cap and make the app fail to start on next ` +
        `launch. Check for an oversized field in the settings patch.`,
    );
  }
  // 跳过无变化写入:保护用户手工编辑的 settings.json 不被默认值合并覆盖,
  // 也避免每次启动都触发一次磁盘 IO + fsync
  //
  // KNOWN LIMITATION:read→compare→write 存在 TOCTOU 窗口(读 prev → 比对
  // 通过 early return → 期间用户手工改 / OneDrive 同步合并 → currentSettings
  // 仍旧值,等下次 saveSettings 才盖回正确内容)。在我们的应用模型下可接受:
  // 唯一 writer 是主进程 updateSettings,外部手工编辑时应用处于 idle;
  // 撞上也只是「应用最后一次写的版本覆盖用户外部修改」,不是数据丢失
  // 完整 CAS(proper-lockfile / atomic rename 检测 mtime)留 follow-up;
  // 现行 workaround:saveSettings 只由 updateSettings 调,updateSettings
  // 走 updateLock 串行化不会并发竞争
  try {
    const prev = await readFileCapped(settingsPath, MAX_SETTINGS_BYTES);
    if (prev === next) return;
  } catch (err: unknown) {
    const code = errnoCode(err);
    if (code === 'ENOENT') {
      // 文件不存在(首启 / 被用户删了)→ 正常写
    } else if (code === 'IO_ERROR') {
      // size cap fail-closed(与读侧同款)
      throw err;
    } else {
      // audit r200:读失败 —— **不能**继续写。写下去就是把一份「此刻读不到
      // 但内容可能完好」的 settings.json 直接盖掉(与 initSettings 读阶段
      // 同一个 bug 类,只是这里发生在写路径上)。fail-closed + 可行动文案。
      throw new AppError(
        'SETTINGS_UNREADABLE',
        `settings.json at ${settingsPath} could not be read (${errMsg(err)}), so it was ` +
          `left untouched — refusing to overwrite a file we could not read. Close whatever ` +
          `is holding it (sync client / antivirus / editor) or fix its permissions, then retry.`,
        err,
      );
    }
  }
  await safeWriteFileAtomic(settingsPath, next);
}

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  if (!currentSettings) throw new AppError('INTERNAL', 'Settings not initialized');
  // 并发 IPC(SETTINGS_UPDATE 连发)走 updateLock 串行化,修 lost-update race:
  // 旧实现 base = currentSettings 在锁外捕获,A/B 拿到同一 base,A 写完释放
  // 锁后 B 用旧 base 算 next,A 的字段被覆盖丢失。修:base 挪进 updateLock.run
  // 闭包,每次进入锁都读最新 currentSettings
  //
  // 内存赋值挪到落盘成功之后:旧顺序 currentSettings = next; await saveSettings();
  // 写盘失败时异常上抛但内存已污染,UI 乐观更新 → 重启后静默回退;getSettings()
  // 返回从没落过盘的值,saveSettings 「无变化跳过」比对都建立在错前提
  return updateLock.run(async () => {
    if (!currentSettings) throw new AppError('INTERNAL', 'Settings not initialized');
    const base = currentSettings;
    const next: AppSettings = { ...base, ...patch };
    // 先落盘(失败即抛,内存不动)→ 再更新内存态
    await saveSettings(next);
    currentSettings = next;
    return next;
  });
}

/**
 * 读源工作区的 settings.json —— **「没有」与「读不到」是两件事**(r207)。
 *
 * - **不存在**(ENOENT)→ 返回 null:全新工作区就是没有这个文件(r163 起
 *   首启不写盘),迁移**不该**因此失败。
 * - **读不到**(EACCES / EPERM / EBUSY / EISDIR …)→ fail-closed 抛错:宁可不
 *   迁移,也不能把一份读不出来的设置当成「没有设置」搬过去 —— 那等于悄悄
 *   把用户的主题 / 语言 / 布局换成默认值。读先走 retryOnWindowsTransient:
 *   Windows 上同步盘 / 杀毒软件短暂持句柄会让 open 报 EPERM/EBUSY,那是
 *   「重试一下就好」。
 * - **超过 size cap** → 照旧抛(IO_ERROR,有意 fail-closed)。
 * - **内容不是合法 JSON** → 不抛:逐字复制(「迁移不改变内容」优先)。
 */
async function readSourceSettings(
  currentDataPath: string,
): Promise<{ raw: string; parsed: Record<string, unknown> | null } | null> {
  const sourcePath = join(currentDataPath, WORKSPACE_DATA_LAYOUT.SETTINGS_FILE);
  let raw: string;
  try {
    raw = await retryOnWindowsTransient(
      () => readFileCapped(sourcePath, MAX_SETTINGS_BYTES),
      () => Promise.resolve(), // 读失败没有 tmp 残留要清
    );
  } catch (err: unknown) {
    if (errnoCode(err) === 'ENOENT') {
      // 源工作区没有 settings.json(全新工作区,或它已被 quarantine 改名)
      return null;
    }
    throw new AppError(
      'IO_ERROR',
      `无法读取源工作区的 settings.json(${sourcePath}):${errMsg(err)}。` +
        `迁移已中止 —— 目标目录未被写入任何内容。请关掉占用它的程序(同步盘 / ` +
        `杀毒软件 / 编辑器)或修复权限后重试。`,
      err,
    );
  }
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch (parseErr: unknown) {
    // 源 settings.json 本身非合法 JSON — 逐字复制,新目录继承同样损坏
    // (下次启动走 quarantine,与留在旧目录一致)。「迁移不改变内容」优先
    log.warn('Source settings.json is not valid JSON; copying verbatim', errMsg(parseErr));
  }
  return { raw, parsed };
}

// 切换数据路径:复制所有数据到新位置
export async function changeDataPath(
  newPath: string,
  currentDataPath: string,
): Promise<{ oldPath: string; newPath: string }> {
  log.info('Changing data path', currentDataPath, '->', newPath);
  // HIGH:旧实现 mkdir + fs.cp({force:false}) 写入任意目标,失败 catch 又
  // fs.rm({recursive,force}) 强制清空 → 若用户选 D:\MyBackup(已有照片等)
  // 作新数据目录,复制中途 EEXIST/throw → catch 触发 → 整个 D:\MyBackup
  // 被 rm -rf 永久删。
  // 修法两段:
  //   (1) mkdir 前 readdir 预检:ENOENT/已存在且空 → safe(targetWasEmpty=true);
  //       已存在且非空 → 直接抛 VALIDATION 让用户重选,根本不写任何字节
  //   (2) rollback fs.rm 仅当 targetWasEmpty —— 我们 mkdir/复制出去的才 rm,
  //       用户原有非空目录永不 rm
  let targetWasEmpty = false;
  try {
    const existing = await fs.readdir(newPath, { withFileTypes: true });
    if (existing.length > 0) {
      throw new AppError(
        'VALIDATION',
        `target directory must be empty: ${newPath} (contains ${existing.length} entries)`,
      );
    }
    targetWasEmpty = true;
  } catch (err: unknown) {
    if (err instanceof AppError) throw err;
    const code = errnoCode(err);
    if (code === 'ENOENT') {
      targetWasEmpty = true;
    } else {
      throw err;
    }
  }

  // audit-r207:源 settings.json **先读**,且「没有」与「读不到」是两件事。
  //
  //   旧实现把 readFileCapped 的 ENOENT 当成致命错 ⇒ **迁移整个失败**。
  //   而「全新工作区根本没有 settings.json」是**正常状态**:r163 的
  //   「首启跳过写盘」优化(当前设置 == 全默认 ⇒ 不写盘)让空工作区的根下
  //   一直没有这个文件。⇒ 「更改数据目录」按钮对**全新安装**的用户永远是
  //   坏的,报的还是一句裸的
  //     ENOENT: no such file or directory, open '...\settings.json'
  //   (settings.json 被 quarantine 成 .corrupt-<ts>.json 的工作区同样中招
  //    —— 那条分支也不写回 defaults)。
  //
  //   新的处置口径:
  //     - **不存在** → 没有可搬的设置,新根也不写(与源保持一致;新根的
  //       initSettings 会给出同一套默认值)⇒ 迁移正常进行;
  //     - **读不到**(EACCES / EBUSY / EISDIR …)→ fail-closed 抛错:宁可不
  //       迁移,也不能把一份读不出来的设置当成「没有设置」搬过去(那等于
  //       悄悄把用户的主题/语言/布局换成默认值)。读先走
  //       retryOnWindowsTransient —— Windows 上同步盘/杀毒软件短暂持句柄
  //       会让 open 报 EPERM/EBUSY,那是「重试一下就好」;
  //     - **内容不是合法 JSON** → 不抛:逐字复制(「迁移不改变内容」优先),
  //       由新根的 initSettings 走它自己的 quarantine 阶梯。
  //
  //   位置也重要:这一段在 mkdir / 拷贝**之前** ⇒ 读失败时目标目录**一个
  //   字节都没被写**,不必先复制几 GB 再回滚。
  const sourceSettings = await readSourceSettings(currentDataPath);

  await fs.mkdir(newPath, { recursive: true });

  try {
    // 复制整个数据目录(除了 index/settings.json/location.json,后面会重建)
    // 库目录已下线,rootPath 下任何子目录都照搬过去
    const entries = await fs.readdir(currentDataPath, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.name === 'index' ||
        entry.name === WORKSPACE_DATA_LAYOUT.SETTINGS_FILE ||
        entry.name === 'location.json'
      )
        continue;
      const src = join(currentDataPath, entry.name);
      const dst = join(newPath, entry.name);
      // 遇 EEXIST 直接 abort:目标已有同名条目(用户建了同名子目录 / 上次
      // 迁移残骸)会让 fs.cp({force:false}) 跳过,新路径缺文件但无报错信号
      try {
        await fs.cp(src, dst, { recursive: true, force: false });
        log.info('Copied', entry.name);
      } catch (err: unknown) {
        const code = errnoCode(err);
        log.warn('Failed to copy', entry.name, code ?? errMsg(err));
        throw err;
      }
    }

    // 写新的 settings.json —— 用 atomic 写入避免半截文件被下个启动读到
    // 不能走 safeWriteFileAtomic:迁移时 dataPath 还指向旧目录,写新路径会被
    // safe-write 的 dataPath 校验拒掉
    //
    // HIGH:不能**逐字**复制。旧 settings.json 带 rootPath = <旧目录>,逐字
    // 搬过去后新目录里的 settings.json 说「我的根在别处」。随后 switchDataPath
    // 调 setRootPath(newPath)(safe-write 单例 = 新目录)再 initSettings(newPath),
    // 取值优先级是 loaded.rootPath ?? …,getSettings().rootPath = 旧目录,与
    // getRootPath() = 新目录永久分叉。后果不是抽象「两个真相」:library-migration
    // 用 deriveLibraryPath(getSettings().rootPath) 算「规范库位置」,分叉后
    // 指向已被用户放弃的旧目录 —— 用户点「搬」的话,库会被复制到那个即将
    // 被删的目录里,新目录下的真库反而不被索引
    // 修法:复制时把 rootPath / dataPath 重写成新目录(数据已在复制,这里只是
    // 让「我在哪」与实际位置一致),其余字段逐字保留
    //
    // audit-r207:源没有 settings.json(全新工作区)⇒ **不写**(与源保持一致)。
    // 源有但内容损坏 ⇒ 逐字复制(「迁移不改变内容」优先,新根的 initSettings
    // 会走它自己的 quarantine 阶梯)。
    if (sourceSettings) {
      const newSettingsPath = join(newPath, WORKSPACE_DATA_LAYOUT.SETTINGS_FILE);
      const parsed = sourceSettings.parsed;
      if (parsed) {
        parsed['rootPath'] = newPath;
        parsed['dataPath'] = newPath;
      }
      await atomicWriteFileInternal(
        newSettingsPath,
        parsed ? JSON.stringify(parsed, null, 2) : sourceSettings.raw,
      );
    } else {
      log.info('Source workspace has no settings.json; leaving the new root without one');
    }

    // 更新 location.json
    await writeLocation(newPath);
  } catch (err) {
    // 清理部分复制的目录,回滚到旧路径
    log.error('Failed to copy data, rolling back new directory', err);
    if (targetWasEmpty) {
      // targetWasEmpty=true newPath 是我们 mkdir 出来的(原不存在或原空),
      // rm 合法清理;用户原有非空目录永不 rm,半成品 entry 让用户手动清
      await fs.rm(newPath, { recursive: true, force: true }).catch((rmErr: unknown) =>
        log.warn('Failed to remove partially-copied data dir during rollback', {
          newPath,
          err: errMsg(rmErr),
        }),
      );
    } else {
      log.warn('Rollback skipped: targetWasEmpty=false, refusing to rm user-owned dir', {
        newPath,
      });
    }
    throw err;
  }

  return { oldPath: currentDataPath, newPath };
}
