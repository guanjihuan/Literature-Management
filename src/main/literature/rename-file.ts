// src/main/literature/rename-file.ts
//
// r187:文献**单文件**重命名的纯逻辑层(计划 + 落盘两步)。
//
// 为什么单独成文件:重命名有三件容易出错、且**互相独立**的判定 ——
//   1. 新文件名的合法性(不能带路径分隔符 / 盘符 / 保留字符);
//   2. 「不改扩展名」的补全规则(用户只敲词干时按原扩展名补齐);
//   3. **不能覆盖已存在的文件**(数据丢失红线)。
// 塞进 service 类里会和 moveFile / moveDir 的搬移逻辑糊在一起,
// 复用与单测都吃亏;这里做成两个纯函数,service 只负责编排。
//
// 关键不变式:
//   - 目标已存在 ⇒ 抛 VALIDATION,**绝不**覆盖(Windows fs.rename 走
//     MoveFileExW(MOVEFILE_REPLACE_EXISTING),静默替换目标文件 —— 用户
//     的另一份 PDF 直接没了,这是数据丢失)。
//   - 仅大小写重命名('a.pdf' → 'A.pdf')在 Windows 上是合法操作,目标
//     「看起来存在」其实是同一个文件 ⇒ 用 dev/ino 判定同一文件后放行。
//   - 目录归属不变:只在**原目录**内改文件名(与 notes 侧 r175 的
//     「重命名只改文件名,保留所在目录」同约定)。

import { promises as fs } from 'fs';
import { basename, dirname, extname, join } from 'path';
import { LibraryError } from '../utils/error';
import { errMsg } from '../utils/error';
import { retryOnWindowsTransient } from '../utils/retry-transient';
import { tr } from '../i18n';
// audit 2026-10-21:Win32 命名规则收成**一份**(shared/win32-name.ts)——
//   本文件原先手抄了一份保留设备名 Set + 内联的字符正则,notes 域抄了
//   另一份,文件夹名那处没抄(⇒ 死夹,P1-1)。现在三处同源。
import {
  hasControlChars,
  hasTrailingDotOrSpace,
  hasWin32ForbiddenChars,
  isReservedDeviceName,
} from '@shared/win32-name';

/** 单个文件名长度上限(与 ext4 的 255 字节 NAME_MAX 对齐)。 */
const MAX_FILENAME_LEN = 255;

export interface LiteratureRenamePlan {
  /** 改名前的绝对路径。 */
  oldAbs: string;
  /** 改名后的绝对路径(同目录,只换文件名)。 */
  newAbs: string;
  /** 实际落地的文件名(含扩展名)。 */
  newFilename: string;
  /** 是否只改了大小写(目标路径与旧路径在大小写不敏感比较下相同)。 */
  caseOnly: boolean;
}

/**
 * 校验 + 拼装重命名计划(纯函数,不碰磁盘)。
 *
 * @param oldAbs 改名前的绝对路径(决定目录与原扩展名)
 * @param rawInput 用户输入(完整文件名,或只给词干)
 */
export function planLiteratureRename(oldAbs: string, rawInput: string): LiteratureRenamePlan {
  const input = rawInput.trim();
  if (input === '') {
    throw new LibraryError('VALIDATION', tr('literature.renameInvalidName', { name: input }));
  }
  if (input.length > MAX_FILENAME_LEN) {
    throw new LibraryError(
      'VALIDATION',
      tr('literature.renameInvalidName', { name: input.slice(0, 40) }),
    );
  }
  // 路径分隔符 / 盘符 / 相对段 —— 一律拒收:重命名**只改文件名**,不改位置。
  if (/[\\/]/.test(input) || /^[A-Za-z]:/.test(input)) {
    throw new LibraryError('VALIDATION', tr('literature.renameInvalidName', { name: input }));
  }
  // 控制字符 + Win32 保留字符 <>:"|?*(路径分隔符上面已单独拒)
  if (hasWin32ForbiddenChars(input) || hasControlChars(input)) {
    throw new LibraryError('VALIDATION', tr('literature.renameInvalidName', { name: input }));
  }
  // '.' / '..' 与「结尾带点/空格」在 Win32 上非法(会被静默截断)。
  if (input === '.' || input === '..' || hasTrailingDotOrSpace(input)) {
    throw new LibraryError('VALIDATION', tr('literature.renameInvalidName', { name: input }));
  }
  // Windows 保留设备名(按**词干**判 —— 'CON.txt' 在 Win32 一样非法)。
  if (isReservedDeviceName(input)) {
    throw new LibraryError('VALIDATION', tr('literature.renameInvalidName', { name: input }));
  }

  // 扩展名补全:用户只敲词干('paper')时按**原**扩展名补齐('.pdf');
  // 用户显式给了扩展名('paper.docx')就照用 —— 文献可以是 pdf/epub/...
  // 多种格式,不能像 notes 那样一律 .md。
  const oldExt = extname(oldAbs);
  let newFilename = input;
  if (extname(input) === '') {
    newFilename = oldExt ? `${input}${oldExt}` : input;
  }

  // 保留**原路径的分隔符风格**:库里 absPath 有两种形态(导入写的是 OS
  //   原生路径,搬移写的是 POSIX 化形态 —— 见 service 的 importFile /
  //   moveFile)。改名不该顺手把风格换掉(否则同一目录里的行一半 'C:\'、
  //   一半 'C:/',肉眼看不出来但搜索/去重会挑花眼)。
  //   做法:切掉旧 basename,原样接上新文件名。
  const base = basename(oldAbs);
  const prefix = oldAbs.slice(0, oldAbs.length - base.length);
  const newAbs = prefix + newFilename;
  const caseOnly =
    newAbs !== oldAbs && newAbs.toLowerCase() === oldAbs.toLowerCase();
  return { oldAbs, newAbs, newFilename, caseOnly };
}

/**
 * 两个路径是否指向**同一个**文件(用于「仅大小写重命名」判定)。
 * 先比路径(Windows 大小写不敏感),再比 dev/ino(同文件的两条硬链接)。
 */
async function isSameFile(a: string, b: string): Promise<boolean> {
  if (a === b) return true;
  const norm = (p: string): string => p.replace(/[\\/]+$/, '').toLowerCase();
  if (norm(a) === norm(b)) return true;
  try {
    const [sa, sb] = await Promise.all([fs.lstat(a), fs.lstat(b)]);
    return sa.dev === sb.dev && sa.ino === sb.ino && sa.ino !== 0;
  } catch {
    return false;
  }
}

/**
 * 落盘:预检目标不存在 → fs.rename(带 Windows 瞬时占用退避重试)。
 *
 * 预检存在的原因:fs.rename 在目标已存在时**从不**抛 EEXIST(Windows 走
 * MoveFileExW(MOVEFILE_REPLACE_EXISTING),POSIX 是 rename(2)),两者都
 * 静默替换目标文件 —— 直接 rename 等于「把用户另一份同名 PDF 覆盖掉」。
 * 所以先 lstat 拦下,真撞名时抛 VALIDATION,交给 UI 提示用户改名。
 */
export async function performLiteratureRename(plan: LiteratureRenamePlan): Promise<void> {
  const { oldAbs, newAbs, newFilename } = plan;
  if (newAbs === oldAbs) return; // 完全同名 → no-op
  const targetExists = await fs.lstat(newAbs).then(
    () => true,
    () => false,
  );
  if (targetExists) {
    // 仅大小写重命名:目标就是源文件本身(Win32 大小写不敏感)→ 放行。
    if (!plan.caseOnly || !(await isSameFile(oldAbs, newAbs))) {
      throw new LibraryError(
        'VALIDATION',
        tr('literature.renameTargetExists', { name: newFilename }),
      );
    }
    await renameCaseOnly(oldAbs, newAbs, newFilename);
    return;
  }
  await renameOnDisk(oldAbs, newAbs, newFilename);
}

/**
 * 仅大小写重命名 —— 两步走:先改成临时名,再改成目标名。
 *
 * 为什么不能一步到位:Win32 的 MoveFileExW(MOVEFILE_REPLACE_EXISTING)对
 *   「同一文件、仅大小写不同」的目标会当成「目标已存在」而失败(报
 *   EEXIST / EPERM),用户在资源管理器里能做的改名,在 fs.rename 这层
 *   反而做不了。两步走把「撞名」这一中间态消掉,两个 rename 各自的目标
 *   都不存在。
 *
 * 回滚:第二步失败时把临时名改回原名(源文件不丢);第一步失败直接抛。
 */
async function renameCaseOnly(
  oldAbs: string,
  newAbs: string,
  newFilename: string,
): Promise<void> {
  const dir = dirname(oldAbs);
  const tmp = join(dir, `.rkms-rename-${process.pid}-${Date.now()}`);
  await renameOnDisk(oldAbs, tmp, basename(tmp));
  try {
    await renameOnDisk(tmp, newAbs, newFilename);
  } catch (err: unknown) {
    // 回滚:把临时名改回原名(尽力而为 —— 回滚也失败就只能靠 chokidar
    //   的 reload 自愈,但那要等磁盘状态变化)。
    try {
      await fs.rename(tmp, oldAbs);
    } catch {
      // 吞掉回滚异常:原始错误更有信息量,回滚失败由 reload 自愈。
    }
    throw err;
  }
}

async function renameOnDisk(
  oldAbs: string,
  newAbs: string,
  newFilename: string,
): Promise<void> {
  try {
    await retryOnWindowsTransient(
      () => fs.rename(oldAbs, newAbs),
      () => Promise.resolve(),
    );
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT') {
      throw new LibraryError('NOT_FOUND', tr('literature.notFound', { id: basename(oldAbs) }));
    }
    if (code === 'EEXIST' || code === 'ENOTEMPTY') {
      throw new LibraryError(
        'VALIDATION',
        tr('literature.renameTargetExists', { name: newFilename }),
      );
    }
    throw new LibraryError(
      'IO_ERROR',
      tr('literature.renameFailed', { name: newFilename, reason: errMsg(err) }),
    );
  }
}
