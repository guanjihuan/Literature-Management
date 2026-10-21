// src/main/utils/migrate-old-userdata.ts
//
// audit r40 (2026-10-15):dev userData 一次性搬迁 helper
//
// 背景:src/main/index.ts 在 whenReady 之前调 app.setName(...),把 dev 模式的
//   userData 路径从 package.json name 字段(research-knowledge-management-system)
//   切到 productName。2026-10-21 productName 又从 'Research Knowledge
//   Management' 改为 'Literature Management',于是 legacy userData 目录有两代
//   (name 字段的老 dev 目录 + 旧 productName 目录),调用方逐代传入。老用户
//   的 location.json / settings.json / index/ 仍留在旧 userData 内,新 userData
//   看不到 → 用户配置丢失,SQLite 索引从零重建。
//
// 本 helper 把老 userData 内的 3 类应用文件搬到新 userData,搬完后**删 source
//   端的 3 个文件**;Chromium 自管目录(Cache / GPUCache / Local Storage 等)
//   **保留**(由 Chromium 自己回收 / 用户手动清理)。
//
// 行为契约:
//   - 严格幂等:新位置已有 → 跳过该文件(不 merge)
//   - 老不存在 → no-op
//   - 老是 symlink → skip + warn(symlink 替换攻击防御,同 migration-layout)
//   - 0 warning + 每个 item 都被处理过(moved / skipped / absent-ENOENT)→
//     删 source 端对应应用文件(stale cleanup:skipped 场景下新端已有更新
//     版本,删 source 是清理 stale;moved 场景已被 fs.rename 原子搬走,
//     deleteItem 走 ENOENT 兜底,deleted.length 不计已搬走的;absent 场景
//     本无 source 副本,删除阶段 ENOENT no-op。audit-r96:缺失项原不计入
//     「被处理过」,「1 skipped + 2 缺失」会让 stale 副本永久残留)
//   - 任一 warn → 整体保留 source(不删任一应用文件,等下次启动再试)
//
//   调用方:src/main/index.ts app.setName 之后,fire-and-forget。
//   不会抛错:helper 内 catch 全部 swallow + log;启动失败不该由迁移触发。
import { app } from 'electron';
import { promises as fs } from 'fs';
import { join } from 'path';
import { createLogger } from './logger';
import { errnoCode, errMsg } from './error';

const log = createLogger('migrate-old-userdata');

// 3 个应用文件 / 目录清单(老 → 新相对路径)。Chromium 自管的 Cache /
//   GPUCache / Local Storage / Session Storage / Code Cache / Network /
//   Preferences / Dictionaries / blob_storage / SharedDictionary /
//   SharedStorage / Local State / DawnGraphiteCache / DawnWebGPUCache /
//   README.md 不在清单 —— 由 Chromium 自己管理,迁移它会拖走我们需要权限。
const APP_ITEMS: readonly string[] = ['location.json', 'settings.json', 'index'] as const;

interface MigrateReport {
  moved: string[];
  skipped: string[];
  deleted: string[];
  warnings: string[];
}

/**
 * 计算老 userData 绝对路径 = `<appData>/<oldAppName>`。
 * 不依赖 app.getPath('userData')(其依赖 app 启动时 name 字段,setName 后已被
 *   切走),也不依赖 app.getPath('appData')(ready 之前不可调)。
 * 直接拼 platform 各自的标准 appData 位置 + 传入的 oldAppName。
 * 公开以让单测在 mock platform 时直接拿路径(不依赖 process.env)。
 */
export function computeOldUserDataPath(oldAppName: string): string {
  if (process.platform === 'win32') {
    const appData =
      process.env.APPDATA || join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
    return join(appData, oldAppName);
  }
  if (process.platform === 'darwin') {
    // macOS:~/Library/Application Support/<name>。homedir() 在 Node 启动时即可用,
    //   不依赖 electron ready。
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { homedir } = require('os') as typeof import('os');
    return join(homedir(), 'Library', 'Application Support', oldAppName);
  }
  // linux + 其他
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const { homedir } = require('os') as typeof import('os');
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(xdg, oldAppName);
}

/**
 * 把单个 item 从 oldUserData 搬到 newUserData。
 * - 老不存在 → 跳过(返回 ok=true, skipped=null)
 * - 新已存在 → 跳过(返回 ok=true, skipped=newPath;不覆盖,保留 source)
 * - 老是 symlink → 跳过 + warn(返回 ok=false)
 * - 搬失败 → 抛错(让 caller 决定不删 source)
 */
async function moveItem(
  oldBase: string,
  newBase: string,
  item: string,
): Promise<{
  ok: boolean;
  movedTo?: string;
  skipped?: string;
  /** audit-r96:source 不存在(ENOENT)= 已核验「无 source 可丢」,
   *  计入「每个 item 都被处理过」闸门 —— 否则「1 项 skipped + 2 项缺失」
   *  会让 skipped 的 stale 副本永久保留(每次启动重复 partial-state warn)。 */
  absent?: boolean;
  warning?: string;
}> {
  const oldPath = join(oldBase, item);
  const newPath = join(newBase, item);

  // lstat:不 follow symlink,见 migration-layout.ts:141 同款防御。
  let oldStat;
  try {
    oldStat = await fs.lstat(oldPath);
  } catch (err: unknown) {
    if (errnoCode(err) === 'ENOENT') return { ok: true, absent: true };
    return { ok: false, warning: `lstat ${item}: ${errMsg(err)}` };
  }

  if (oldStat.isSymbolicLink()) {
    return { ok: false, warning: `${item} is a symlink; skipping` };
  }

  // 新位置已存在 → 跳过;保留 source 不动。
  try {
    await fs.lstat(newPath);
    return { ok: true, skipped: newPath };
  } catch (err: unknown) {
    if (errnoCode(err) !== 'ENOENT') {
      return { ok: false, warning: `lstat new ${item}: ${errMsg(err)}` };
    }
    // 新不存在 → 继续搬
  }

  // 跨盘符 EXDEV 时 fs.rename 抛 → 走 copy + rm fallback。userData 一般在
  //   %APPDATA% 同盘,跨盘场景少见(OneDrive 重定向 / 用户把 appData 挪到
  //   D 盘);但代码防御一下。
  try {
    if (oldStat.isDirectory()) {
      // 目录:试 rename,跨盘走 copy + rm。
      try {
        await fs.rename(oldPath, newPath);
      } catch (err: unknown) {
        if (errnoCode(err) !== 'EXDEV') throw err;
        // audit-r243(2026-10-21):copy 失败 ⇒ 清掉目标端半份残留。
        //   跨盘 fallback 的 copy 中途失败(ENOSPC / EIO / 断电)会在
        //   newPath 留下**半份**拷贝(部分子树)。旧实现只记 warning 就走人,
        //   后果是下一次启动:
        //     moveItem 看到 newPath **已存在** ⇒ 返回 {ok:true, skipped}
        //     ⇒ 没有 warning ⇒ hasFailure 仍为 false ⇒ itemsHandled 满 ⇒
        //     启动流程判定「新端已有对应副本」⇒ **删掉 source 端原件**。
        //   ⇒ 用户原始 settings.json / location.json 只剩那份截断副本 ——
        //     永久丢数据。
        //   修法:copy 失败时把目标端残留删掉,让下次启动「目标端不存在」
        //     ⇒ 重新从 source 搬 ⇒ source 始终是权威副本。
        //   只在 copy 失败时删 —— rename 成功路径不碰 newPath;
        //   copy 成功后的「删 source 失败」也**不**删(那时新端是好的,
        //   删了反而逼用户重搬一遍)。
        try {
          await fs.cp(oldPath, newPath, { recursive: true, errorOnExist: true, force: false });
        } catch (cpErr: unknown) {
          await fs.rm(newPath, { recursive: true, force: true }).catch(() => {
            /* 残留清不掉:下次启动重试,source 仍在,不算丢数据 */
          });
          throw cpErr;
        }
        await fs.rm(oldPath, { recursive: true, force: true });
      }
    } else {
      // 文件:同样 rename → cp + rm fallback。
      try {
        await fs.rename(oldPath, newPath);
      } catch (err: unknown) {
        if (errnoCode(err) !== 'EXDEV') throw err;
        // 同上:copy 失败 ⇒ 删掉截断的目标副本,别让下次启动把它当「已搬完」。
        try {
          await fs.copyFile(oldPath, newPath);
        } catch (cpErr: unknown) {
          await fs.rm(newPath, { force: true }).catch(() => {
            /* 同上:残留清不掉也无所谓,source 仍在 */
          });
          throw cpErr;
        }
        await fs.unlink(oldPath);
      }
    }
    return { ok: true, movedTo: newPath };
  } catch (err: unknown) {
    return { ok: false, warning: `move ${item}: ${errMsg(err)}` };
  }
}

/**
 * 删 source 端的 item。任一失败 swallow + warn(本步失败不应阻塞其它删;
 *   也不抛,启动期容错)。
 */
async function deleteItem(
  oldBase: string,
  item: string,
): Promise<{ deleted?: string; warning?: string }> {
  const oldPath = join(oldBase, item);
  try {
    await fs.lstat(oldPath);
  } catch (err: unknown) {
    if (errnoCode(err) === 'ENOENT') return {};
    return { warning: `lstat ${item} for delete: ${errMsg(err)}` };
  }
  try {
    await fs.rm(oldPath, { recursive: true, force: true });
    return { deleted: oldPath };
  } catch (err: unknown) {
    return { warning: `delete ${item}: ${errMsg(err)}` };
  }
}

/**
 * 主入口。调用方传 oldAppName(setName 之前的 app.getName());
 * helper 内部走 *全部失败的处理*——3 个全搬成功才删 source 端对应文件,
 * 任一失败保留 source 全部不动,等下次启动再试。
 */
export async function migrateOldDevUserData(oldAppName: string): Promise<MigrateReport> {
  // 防御:packaged 模式 appName 已是 productName,与 setName 后一致 →
  //   oldUserData === newUserData,下面 moveUserDataAppItems 直接 no-op,
  //   不影响 packaged 用户。
  const oldUserData = computeOldUserDataPath(oldAppName);
  const newUserData = app.getPath('userData');
  return migrateUserDataAppItems(oldUserData, newUserData);
}

/**
 * 核心搬迁逻辑 —— 老 userData → 新 userData 内 3 个应用文件。
 * 暴露成独立函数以便测试(测试不依赖 platform / electron app,直接传 sandbox
 *   路径)。
 */
export async function migrateUserDataAppItems(
  oldUserData: string,
  newUserData: string,
): Promise<MigrateReport> {
  const report: MigrateReport = { moved: [], skipped: [], deleted: [], warnings: [] };

  if (oldUserData === newUserData) {
    // 已在新位置(packaged / 第二次启动)。no-op。
    return report;
  }

  // 老 userData 整体不存在 → 全新用户,no-op。
  try {
    await fs.lstat(oldUserData);
  } catch (err: unknown) {
    if (errnoCode(err) === 'ENOENT') return report;
    report.warnings.push(`lstat oldUserData: ${errMsg(err)}`);
    return report;
  }

  log.info('App begin', { oldUserData, newUserData, items: APP_ITEMS });

  // 第一阶段:逐个搬迁。任一失败 → warnings + 整体放弃删 source。
  let hasFailure = false;
  // audit-r96:ENOENT 缺失项单独计数 —— 缺失 = 已核验「无 source 可丢」,
  //   与 moved/skipped 一样算「被处理过」。旧口径只数 moved+skipped,
  //   「1 skipped + 2 缺失」永远进不了第二阶段,stale 副本永久残留。
  let absentCount = 0;
  for (const item of APP_ITEMS) {
    const r = await moveItem(oldUserData, newUserData, item);
    if (r.warning) {
      log.warn('App move warning', { item, warning: r.warning });
      report.warnings.push(r.warning);
      hasFailure = true;
      // 不 break:继续检查其它 item,拿到全部警告一并入档。
    }
    if (r.movedTo) report.moved.push(r.movedTo);
    if (r.skipped) report.skipped.push(r.skipped);
    if (r.absent) absentCount++;
  }

  // 第二阶段:删 source 端 3 个应用文件。条件:
  //   - 0 warning(没有搬迁失败)
  //   - 每个 item 都至少被处理过(moved 或 skipped):证明新端有对应文件副本,
  //     删 source 不会丢数据
  //   skipped 场景下新端已有更新版本(如 location.ts 本轮启动写过新端
  //   location.json),此时 source 是 stale 数据,删它是清理而非丢数据;
  //   moved 场景下 source 已被 fs.rename 原子搬走,deleteItem 走 ENOENT
  //   兜底(deleted.length 不计已搬走的项)。
  //   任一失败 / warning / item 未处理 → 保留全部 source,等下次启动再试
  //   (同 migration-layout partial state 不删 source 的口径)。
  // audit-r96:缺失(ENOENT)项计入 handled —— 闸门语义是「证明新端有
  //   对应副本或 source 本无副本,删 source 不丢数据」。
  const itemsHandled = report.moved.length + report.skipped.length + absentCount;
  if (!hasFailure && itemsHandled === APP_ITEMS.length) {
    for (const item of APP_ITEMS) {
      const d = await deleteItem(oldUserData, item);
      if (d.deleted) report.deleted.push(d.deleted);
      if (d.warning) {
        log.warn('App delete warning', { item, warning: d.warning });
        report.warnings.push(d.warning);
      }
    }
  } else if (itemsHandled > 0) {
    log.warn('App partial state: source kept (will re-try on next launch)', {
      moved: report.moved,
      warnings: report.warnings,
    });
  }

  log.info('App summary', {
    moved: report.moved.length,
    skipped: report.skipped.length,
    deleted: report.deleted.length,
    warnings: report.warnings.length,
  });
  return report;
}
