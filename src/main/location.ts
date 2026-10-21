// 数据路径定位:用 userData/location.json 作为规范指针
// 解决问题:
//  1. bootstrap 需要在不读取 settings 的情况下知道 dataPath
//  2. 用户切换 dataPath 时,新位置立即被记录
//  3. 旧版本的 settings 在 userData/settings.json (已废弃) 也能被自动迁移
//
// audit-r56:删 defaultLibraryPath —— 库整体下线,没有「库默认路径」概念;
//   location.ts 也不再有「find settings with libraryPath」这种优先序;
//   resolveDataPath 的所有分支都按 rootPath / dataPath 解析。location.json
//   schema 不变(只含 dataPath),向下兼容老格式。
import { app } from 'electron';
import { promises as fs, lstatSync } from 'fs';
import { isAbsolute, join } from 'path';
import { createLogger } from './utils/logger';
import { errMsg, errnoCode } from './utils/error';
import { WORKSPACE_DATA_LAYOUT } from '@shared/types';
import { atomicWriteFileInternal } from './utils/safe-write';
// audit r29 (2026-09-21):location.json mkdir 路径走 lstat 同款 symlink
//   防御。不能用 ipc/paths.assertNotSymlink:那个 helper 同时校验
//   allowedRoots(),而 location.ts 是 bootstrap 最早阶段,setDataPath()
//   还没调用 → allowedRoots() 空 → 任何路径都 EPERM → 永远 fallback 到
//   默认。这里只做末端 lstat 是 symlink 检查,不动 allowedRoots 校验
//   (留给后续 ipc handler 在 setDataPath 之后做)。

const log = createLogger('location');

// audit round 10 (2026-09-15):L7 — 'ResearchHub' 之前在 defaultParentPath()
//   里字面写,改父目录名要 grep 全仓。抽成 BRAND_DIR_NAME 顶层常量,未来
//   白标 / OEM 改目录名改一处即可。注意:location.json / settings.json /
//   数据迁移都依赖这个目录名,改值需要走数据迁移流程,本轮只抽常量不动值。
const BRAND_DIR_NAME = 'ResearchHub';

interface LocationData {
  dataPath: string;
  version: number;
}

const LOCATION_VERSION = 1;

function locationPath(): string {
  return join(app.getPath('userData'), 'location.json');
}

// 重构 (2026-09-07):数据默认路径统一到 <Documents>/ResearchHub/。
//   之前库在 <Documents>/ResearchHub/library,data 在 D:\ResearchHub\<app>
//   (Win 有 D 盘)或 appData/<appName>(其他)。用户拷机器 / 备份目录时要在
//   两个完全不同的位置找;在设置页看到的两个路径也互不挨着,直观上没法
//   一眼看出"这两个都是这 app 的东西"。现在统一到 <Documents>/ResearchHub/:
//     - data:    <Documents>/ResearchHub/data  (settings / index / notes 等)
//   跨平台一致 —— app.getPath('documents') 内部按 OS 选对应目录
//   (Win %USERPROFILE%\Documents,macOS ~/Documents,Linux $XDG_DOCUMENTS_DIR
//   或 ~/Documents),无需 win32 的 existsSync('D:\\') 探测,默认就是用户
//   最熟悉的"我的文档"位置。Documents 不可写(Linux XDG 损坏等)走
//   initSettings 里的「dataPath/library」双层 fallback,与之前一致。
//
//   audit (2026-09-07):data 子目录用 'data' 不用 app.getName() —— 后者是
//     productName "Literature Management",路径会变成 ".../ResearchHub/
//     Literature Management/",目录名又臭又长还带空格。'data' 与
//     'library' 同长同结构,对称好认。
function defaultParentPath(): string {
  return join(app.getPath('documents'), BRAND_DIR_NAME);
}

// audit 2026-10-02(workspace-unification 落地):defaultRootPath 是**权威的**
//   默认工作目录根。defaultDataPath 保留为转发别名 —— 它是「旧名」,但对外
//   仍有 IPC / 设置页等调用方,直接删会是一次纯改名 churn;等下一次大版本
//   随 AppSettings.dataPath 一起删。
export function defaultDataPath(): string {
  return defaultRootPath();
}

// audit 2026-10-02(workspace-unification 落地):defaultRootPath 现在是**权威的
//   默认工作目录根**,defaultDataPath 转发到它。
//
//   取值是 `defaultParentPath()/data` 而不是"更干净"的 `defaultParentPath()`,
//   是刻意的:本项目吃过「同一件事有两种形状」的亏 —— r32 的 data/data/notes
//   事故就是「新装用户」与「升级用户」落在不同布局上引发的。既有用户的
//   rootPath 直接由旧 dataPath 提升而来(零搬迁),所以默认布局必须与之一致,
//   否则新装用户又会拿到第三种形状。丑一点,换布局唯一。
export function defaultRootPath(): string {
  return join(defaultParentPath(), 'data');
}

// 读取 location.json,失败时尝试从旧 userData/settings.json 迁移,再尝试默认路径,最后用全新默认
export async function resolveDataPath(): Promise<{ path: string; fromLegacy: boolean }> {
  const def = defaultDataPath();

  // perf(2026-08-24):3 个 readFile 并发跑(原版是串行 await),互不依赖。
  // HDD / AV-on-Windows 下串行 3 次读 5-30ms,Promise.allSettled 一次拿到全部。
  // 哪个文件不存在就让对应分支走 null,不阻断其它两个。
  const [locationResult, defaultResult, userDataResult] = await Promise.allSettled([
    fs.readFile(locationPath(), 'utf-8'),
    fs.readFile(join(def, WORKSPACE_DATA_LAYOUT.SETTINGS_FILE), 'utf-8'),
    fs.readFile(join(app.getPath('userData'), WORKSPACE_DATA_LAYOUT.SETTINGS_FILE), 'utf-8'),
  ]);

  // 1. 优先读 location.json
  let locationDataPath: string | null = null;
  if (locationResult.status === 'fulfilled') {
    try {
      const parsed: LocationData = JSON.parse(locationResult.value);
      if (parsed.dataPath) {
        // audit round 10 (2026-09-15):location.json 是 userData 内的可信文件,
        //   但同一进程 / 同用户共享 box / 第三方 app 都有写权限。恶意构造
        //   {dataPath: "../../etc"} 让 fs.mkdir 成功后,getDataPath() 解析出
        //   相对 cwd 的非预期路径,后续所有 fs.writeFile 都漂到攻击者选的
        //   位置。加 isAbsolute 兜底,与 settings/migration.ts:24 /
        //   settings/validate.ts 同一防御口径,非绝对路径 → 视为 null 走
        //   默认 fallback,不静默落进 mkdir。
        if (!isAbsolute(parsed.dataPath)) {
          log.warn('location.json dataPath not absolute, falling back to default', parsed.dataPath);
          locationDataPath = null;
        } else {
          locationDataPath = parsed.dataPath;
          // audit 2026-09-07:把 mkdir 从 fire-and-forget 改成 await ——
          //   旧实现把失败吞到 .catch 里,后续步骤(line 127 readFile / 各
          //   fs.writeFile)却假定目录已就绪,Documents 不可写 / 路径被卸载
          //   时会让 settings / index 写到不存在的目录,UI 立即崩。
          //   失败时落到默认路径走"全新默认"分支,行为更可预测。
          try {
            // audit r28 (2026-09-21):recursive mkdir 在 NTFS / ext4 上
            //   会 follow 中间 symlink,允许攻击者先在父目录里布一个
            //   「指向 /etc」 的伪目录 → location.json 让 app mkdir 沿 →
            //   后续 settings.json 写到攻击者控制的目录。先 lstat 路径
            //   末端确认不是 symlink(同 assertNotSymlink 末端检查口径);
            //   父目录链由递归 mkdir 自身不 follow 保证(mkdir {recursive:true}
            //   见 EEXIST 但不静默吞解析结果)。
            // audit r29 (2026-09-21):location.ts 是 bootstrap 最早阶段,
            //   setDataPath() 还没调用,不能用 ipc/paths.assertNotSymlink
            //   (它同时校验 allowedRoots(),此时根列表是空)。这里只做末端
            //   lstat 是 symlink 检查;父链中间 symlink 防御留给
            //   ipc/paths.assertInsideAllowedRoot(setDataPath 之后)。
            await fs.mkdir(parsed.dataPath, { recursive: true });
            try {
              const lst = lstatSync(parsed.dataPath);
              if (lst.isSymbolicLink()) {
                log.warn(
                  'location.json dataPath is a symlink, falling back to default',
                  parsed.dataPath,
                );
                locationDataPath = null;
              }
            } catch (lstatErr: unknown) {
              // lstat 失败(权限翻转 / ENOENT 等)不阻断 — mkdir 已成功,
              // 后续 readFile/writeFile 会抛真错误,这里多一次 syscall
              // 不替上层掩盖。
              const code = errnoCode(lstatErr);
              if (code !== 'ENOENT') {
                log.warn('location.json dataPath lstat failed', {
                  path: parsed.dataPath,
                  code,
                });
              }
            }
          } catch (err: unknown) {
            log.warn('mkdir location.dataPath failed, falling back to default', errMsg(err));
            locationDataPath = null;
          }
          if (locationDataPath) log.info('Resolved data path from location.json', parsed.dataPath);
        }
      }
    } catch (err: unknown) {
      log.warn('location.json parse failed', errMsg(err));
    }
  } else {
    const code = errnoCode(locationResult.reason);
    if (code !== 'ENOENT') {
      log.warn('Failed to read location.json', errMsg(locationResult.reason));
    }
  }

  // 2. 默认路径的 settings.json(可能包含更完整的旧设置,如 rootPath)
  let defaultSettingsRaw: string | null = null;
  let defaultSettingsParsed: Record<string, unknown> | null = null;
  if (defaultResult.status === 'fulfilled') {
    try {
      defaultSettingsRaw = defaultResult.value;
      defaultSettingsParsed = JSON.parse(defaultSettingsRaw);
    } catch (err: unknown) {
      // audit round 17 (2026-09-02):损坏 JSON 不再静默 —— 之前 0 字节 / 权限翻转 /
      //   截断的 settings.json 会被默认 silently skip,bootstrap 退回新默认路径,
      //   老用户数据看似"凭空消失"。至少留一行 warn 给 telemetry。
      log.warn('default settings.json parse failed', errMsg(err));
    }
  }

  // 3. userData 的 settings.json (legacy)
  let userDataSettingsParsed: Record<string, unknown> | null = null;
  if (userDataResult.status === 'fulfilled') {
    try {
      userDataSettingsParsed = JSON.parse(userDataResult.value);
    } catch (err: unknown) {
      log.warn('userData settings.json parse failed', errMsg(err));
    }
  }

  // 4. 智能合并: 找出所有候选设置中 rootPath / dataPath 任意一个不为空的
  // audit-r56:删「libraryPath 不为空」的优先序 —— library 整体下线。
  //   现在按 rootPath → dataPath → 默认 的取值顺序,优先级仍是 new > userData
  //   > default(同 r32 修法),不再有「带库 settings 优先于无库 settings」的
  //   隐式排序。早期版本如果 settings.json 有 libraryPath 而没有 rootPath,
  //   这里仍能取到 dataPath(老字段),不会被孤立。
  const candidates: { source: string; parsed: Record<string, unknown> }[] = [];
  if (locationDataPath) {
    try {
      const newSettingsRaw = await fs.readFile(
        join(locationDataPath, WORKSPACE_DATA_LAYOUT.SETTINGS_FILE),
        'utf-8',
      );
      candidates.push({ source: 'new', parsed: JSON.parse(newSettingsRaw) });
    } catch (err: unknown) {
      // readFile 失败(权限 / 路径不存在):warn 但不阻断 bootstrap。
      log.warn('new settings.json read/parse failed', errMsg(err));
    }
  }
  if (userDataSettingsParsed)
    candidates.push({ source: 'userData', parsed: userDataSettingsParsed });
  if (defaultSettingsParsed) candidates.push({ source: 'default', parsed: defaultSettingsParsed });

  // 5. 优先用有 rootPath / dataPath 的设置(任一字段非空都算「有设置」)
  //   audit-r56:把 libraryPath 判定换成 rootPath / dataPath 的 union 判定。
  //   行为上「new 路径 + 默认路径都同时有 settings.json」时仍由 new 获胜
  //   (candidates 数组顺序保证),不重蹈 r32 「默认获胜导致 location.json
  //   被改写到默认」的覆辙。
  const withPath = candidates.find((c) => {
    const rp = c.parsed['rootPath'];
    const dp = c.parsed['dataPath'];
    return (
      (typeof rp === 'string' && rp) ||
      (typeof dp === 'string' && dp)
    );
  });
  if (withPath) {
    log.info('Found settings with rootPath/dataPath in', withPath.source);
    // audit 2026-10-03:MEDIUM — `rootPath` 必须与 `dataPath` 同等参与取值。
    //   旧实现只看 `dataPath`,缺字段就退回默认目录。但 ADR-0003 之后
    //   `rootPath` 才是工作目录根的**单一真相**(`dataPath` 只是为降级到旧版本
    //   而镜像写入的 @deprecated 字段)。于是「有 rootPath 但没有 dataPath」的
    //   settings.json —— 手改过、旧版本写的、或将来某个版本真的不再写镜像 ——
    //   会被判成「没有工作目录」而 fallback 到 `def`,紧接着 writeLocation
    //   **把 location.json 改写成默认目录**。
    //   用户可见后果:应用在一个全新的空工作区里启动,真笔记被彻底孤立
    //   (不是丢在磁盘上,只是再也看不到),而 location.json 已经被改写,
    //   下次启动连线索都没了。这正是 r32「首启必丢笔记」那一类事故的
    //   同构形态 —— 同样是「同一件事有两种布局来源」。
    //   取值顺序 rootPath → dataPath → 默认,与 initSettings 的优先级一致。
    const rawDataPath =
      typeof withPath.parsed['rootPath'] === 'string'
        ? withPath.parsed['rootPath']
        : typeof withPath.parsed['dataPath'] === 'string'
          ? withPath.parsed['dataPath']
          : def;
    // audit 2026-10-01:MEDIUM — 补齐与 location.json 同一口径的绝对路径校验。
    //   读 location.json 的分支(location.ts:108 附近)有 `isAbsolute` 防御,
    //   注释也明写「与 settings/migration.ts / settings/validate.ts 同一防御
    //   口径」;但**这份 settings.json 的 dataPath 却没有**:
    //     - 相对路径会被 fs.mkdir 按 process.cwd() 解析(dev 下是项目根,
    //       打包后是 asar 侧目录)→ 整个工作区落到一个完全意外的位置;
    //     - 更糟的是紧接着 writeLocation(realDataPath) 会把这个相对路径
    //       **持久化**进 userData/location.json —— 下次启动 location.ts:108
    //       的 isAbsolute 才会 reject,但那时目录已经在 cwd 下建好了。
    //   来源是 userData / 默认路径下的**旧版本** settings.json(不是本 app
    //   写出的可信格式),所以必须自己校验。
    const realDataPath = isAbsolute(rawDataPath) ? rawDataPath : def;
    if (!isAbsolute(rawDataPath)) {
      log.warn('settings.json dataPath is not absolute, falling back to default', {
        source: withPath.source,
        dataPath: rawDataPath,
        fallback: def,
      });
    }
    // audit 2026-10-03:fallback 到默认目录会把真工作区孤立掉,而
    //   writeLocation(realDataPath) 紧接着就把这个选择**持久化**进
    //   location.json —— 之后既看不到原工作区,也没有任何提示。
    //   这里**故意只 log 不弹 toast**:`resolveDataPath()` 是在 bootstrap 的
    //   第一步(index.ts:startup)跑的,那时 createWindow() 还没执行,
    //   BrowserWindow.getAllWindows() 是空的 —— 推出去的 toast 不会有任何人
    //   收到。一个「看起来在通知、实际静默失效」的信号比没有更糟。
    //   而且由于上一段已经让 rootPath 参与取值,能走到这里的只剩
    //   「记录值不是绝对路径」这种真正的坏数据,频率极低。
    if (realDataPath === def && rawDataPath !== def) {
      log.warn('Falling back to default data path; previous workspace may be orphaned', {
        source: withPath.source,
        claimed: rawDataPath,
        fallback: def,
      });
    }
    await fs.mkdir(realDataPath, { recursive: true });

    if (realDataPath !== locationDataPath) {
      await writeLocation(realDataPath);
    }

    // 关键: 如果目标 settings 不存在,或者目标 settings 缺 rootPath / dataPath
    //   (审计-r56:不再判 libraryPath),都覆盖。
    const targetSettingsPath = join(realDataPath, WORKSPACE_DATA_LAYOUT.SETTINGS_FILE);
    let needWrite = true;
    try {
      const existing = JSON.parse(await fs.readFile(targetSettingsPath, 'utf-8')) as {
        rootPath?: unknown;
        dataPath?: unknown;
      };
      if (existing.rootPath || existing.dataPath) {
        needWrite = false; // 已有完整设置,不覆盖
        log.info('Target settings already has rootPath/dataPath, keeping it');
      } else {
        log.info('Target settings missing rootPath/dataPath, will overwrite');
      }
    } catch (err: unknown) {
      // audit 2026-09-14:之前裸 catch 把 EACCES / EBUSY 当成"不存在",会覆盖
      //   用户磁盘上的合法 settings.json。仅 ENOENT 走 needWrite=true,其他报错。
      if (errnoCode(err) !== 'ENOENT') {
        log.warn('settings.json read failed unexpectedly', {
          path: targetSettingsPath,
          err: errMsg(err),
        });
      }
    }
    if (needWrite) {
      await atomicWriteFileInternal(
        targetSettingsPath,
        JSON.stringify(withPath.parsed, null, 2),
      );
      log.info('Copied settings (with path) to', realDataPath);
    }
    return { path: realDataPath, fromLegacy: true };
  }

  // 6. 没有 rootPath / dataPath, 用 location.json 或默认
  if (locationDataPath) {
    return { path: locationDataPath, fromLegacy: false };
  }

  // 7. userData settings 有 dataPath
  let legacyDataPath =
    typeof userDataSettingsParsed?.['dataPath'] === 'string'
      ? userDataSettingsParsed['dataPath']
      : null;
  // r197:绝对路径守卫(defense-in-depth)——
  //   **先说清可达性**:本分支在当前流程里其实**到不了**。第 5 步的
  //   withPath 分支已经把「userData settings 里带 rootPath/dataPath」的
  //   情形全部截住(那里已有 isAbsolute 校验,见 :264),能走到第 7 步时
  //   userData settings 要么没有 dataPath、要么 dataPath 是空串 ⇒
  //   legacyDataPath 恒为 null。
  //   但守卫仍然留着:本分支的形态是「拿候选路径 → fs.mkdir → writeLocation
  //   持久化」,一旦将来流程调整(withPath 的候选顺序变了 / 某个分支提前
  //   return),漏掉绝对路径校验的后果是工作区被建在 process.cwd() 下并
  //   写进 location.json 长期固化 —— 与 :255-263 描述的危害完全一致。
  //   一行守卫换一条「将来不会静默改回去」的保险,划算。
  if (legacyDataPath && !isAbsolute(legacyDataPath)) {
    log.warn('userData settings dataPath is not absolute — ignoring it', legacyDataPath);
    legacyDataPath = null;
  }
  if (legacyDataPath) {
    await fs.mkdir(legacyDataPath, { recursive: true });
    await writeLocation(legacyDataPath);
    return { path: legacyDataPath, fromLegacy: true };
  }

  // 8. 默认 settings 没有 dataPath 但存在
  if (defaultSettingsRaw) {
    await fs.mkdir(def, { recursive: true });
    await writeLocation(def);
    return { path: def, fromLegacy: true };
  }

  // 9. 全新默认
  await fs.mkdir(def, { recursive: true });
  log.info('Using fresh default data path', def);
  return { path: def, fromLegacy: false };
}

export async function writeLocation(dataPath: string): Promise<void> {
  const data: LocationData = { dataPath, version: LOCATION_VERSION };
  const target = locationPath();
  await atomicWriteFileInternal(target, JSON.stringify(data, null, 2));
  log.info('Location written', dataPath);
}
