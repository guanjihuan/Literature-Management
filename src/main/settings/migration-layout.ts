// Layout 迁移 v2:分层布局(dataPath/data/...)→ 扁平布局(dataPath/...)。
// v3 分层曾导致 data/data/ 双层 ENOENT,回滚到扁平。
// 幂等:老存在 & 新不存在才搬;失败只 warn 不抛(数据安全 > layout 一致)。
// 原子 rename(Windows 不跨盘符无问题)。
import { promises as fs } from 'fs';
import { join } from 'path';
import { safeRename } from '../utils/safe-write';
import { createLogger } from '../utils/logger';
import { errnoCode, errMsg } from '../utils/error';

const log = createLogger('migration-layout');

interface MigrationResult {
  moved: string[];
  warnings: string[];
}

/** 老布局 → 新布局。dataPath 相对路径(POSIX) */
const OLD_LAYOUT_DIRS: { oldRel: string; newRel: string }[] = [
  // 显式写字符串不用 layout 常量:常量改名后重跑迁移会把已迁好的目录再搬一遍
  // workspace 排最后:含 favorites/ 子目录,原子 rename 内部子结构整体跟走
  { oldRel: 'data/notes', newRel: 'notes' },
  { oldRel: 'data/workspace', newRel: 'workspace' },
];

/** 主入口:启动期调用一次 */
export async function migrateDataLayoutV2(dataPath: string): Promise<MigrationResult> {
  const result: MigrationResult = { moved: [], warnings: [] };

  // 互不依赖,并发跑节省 1 次 stat 延迟(典型 10-30ms HDD / AV-on-Windows)
  try {
    await Promise.all(
      OLD_LAYOUT_DIRS.map(async ({ oldRel, newRel }) => {
        try {
          await migrateDirectory(dataPath, oldRel, newRel, result);
        } catch (err: unknown) {
          log.warn('Layout v2: migrateDirectory failed', { oldRel, err: errMsg(err) });
          result.warnings.push(`${oldRel} failed: ${errMsg(err)}`);
        }
      }),
    );
  } catch (err: unknown) {
    log.error('Layout migration v2 failed (continuing with original)', errMsg(err));
  }

  if (result.moved.length > 0 || result.warnings.length > 0) {
    log.info('Layout migration v2 summary', JSON.stringify(result, null, 2));
  }
  return result;
}

/** 把 dataPath/<oldRel> 整个搬到 dataPath/<newRel>。幂等:目标存在则 skip(rename 不覆盖) */
async function migrateDirectory(
  dataPath: string,
  oldRel: string,
  newRel: string,
  result: MigrationResult,
): Promise<void> {
  const oldPath = join(dataPath, oldRel);
  const newPath = join(dataPath, newRel);

  let oldStat;
  try {
    // lstat 不 follow symlink — 升级期 stat 与 safeRename 之间可被另一进程
    // 替换为 symlink(云盘冲突合并 / 用户误操作),rename 会搬走 swap 后的
    // symlink target,跨出 dataPath 边界
    oldStat = await fs.lstat(oldPath);
  } catch (err: unknown) {
    if (errnoCode(err) === 'ENOENT') return; // 老位置不存在 → 无需迁移
    log.warn('Layout v2: stat old dir failed', { oldPath, err: errMsg(err) });
    result.warnings.push(`stat ${oldRel} failed`);
    return;
  }

  if (oldStat.isSymbolicLink()) {
    // symlink 不 follow,跳过(可能是误迁移留下的)
    log.warn('Layout v2: old path is symlink, skipping', { oldPath });
    result.warnings.push(`${oldRel} is a symlink`);
    return;
  }

  if (!oldStat.isDirectory()) {
    // 老位置存在但不是目录(用户误放同名文件)→ 跳过,留给运维
    log.warn('Layout v2: old path is not a directory, skipping', { oldPath });
    result.warnings.push(`${oldRel} is not a directory`);
    return;
  }

  // 目标检查
  try {
    const newStat = await fs.stat(newPath);
    if (!newStat.isDirectory()) {
      log.warn('Layout v2: new path is not a directory, skipping', { newPath });
      result.warnings.push(`${newRel} exists and is not a directory`);
      return;
    }
    // 保守三分支,永不猜测哪份是权威:
    //   a) 目标非空 → 两份都有内容 → 一律不删,警告让用户决定
    //   b) 目标为空 → 必然是迁移残留空壳 → 删壳再 rename
    //   c) 目标不存在 → 直接 rename
    // r32 旧实现 stat(newPath) 成功就无条件 rm -rf oldPath,曾造成「首启必丢笔记」
    // (ensureWorkspaceDirs 先跑留空 notes/ → 命中分支删 v3 真数据);删逻辑原样保留
    // 的话任何调换启动顺序都会重犯
    const newEntries = await fs.readdir(newPath);
    if (newEntries.length > 0) {
      log.warn('Layout v2: both old and new are non-empty, keeping both (no auto-delete)', {
        oldPath,
        newPath,
        newCount: newEntries.length,
      });
      result.warnings.push(
        `${oldRel}/ and ${newRel}/ both contain files — kept both, merge or delete one manually`,
      );
      return;
    }
    // 删空壳后落到下方 rename
    log.info('Layout v2: new path is an empty dir, removing it so old content can move in', {
      oldPath,
      newPath,
    });
    try {
      await fs.rmdir(newPath);
    } catch (rmErr: unknown) {
      log.warn('Layout v2: failed to remove empty new dir', { newPath, err: errMsg(rmErr) });
      result.warnings.push(`cannot remove empty ${newRel}/ (${errMsg(rmErr)}); old kept`);
      return;
    }
  } catch (err: unknown) {
    if (errnoCode(err) !== 'ENOENT') {
      log.warn('Layout v2: stat new dir failed', { newPath, err: errMsg(err) });
      result.warnings.push(`stat ${newRel} failed`);
      return;
    }
    // newPath 不存在 → 直接搬
  }

  // newRel 是 'notes' / 'workspace',直接落在 dataPath 根下,无需先 mkdir 中间层
  try {
    // safeRename 内部 assertInsideAllowedRoot,源和目标都在 dataPath 内
    await safeRename(oldPath, newPath);
    log.info('Layout v2: moved', oldRel, '→', newRel);
    result.moved.push(`${oldRel}/ → ${newRel}/`);
  } catch (err: unknown) {
    log.error('Layout v2: rename failed', { oldPath, newPath, err: errMsg(err) });
    result.warnings.push(`rename ${oldRel} → ${newRel} failed`);
    // 失败不动源,下次启动重试(老目录仍在)
  }
}
