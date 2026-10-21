// 文献拖入导入(audit-r71)—— OS 拖入任意文件(PDF / docx / txt / md …)拷贝进
// <rootPath>/literature/ 并生成 resources 表 lit 行所需的信息。
//
// 与 notes/import.ts 的关系:复用同一套安全骨架(lstat 不 follow symlink →
// symlink/非普通文件拒绝 → fd-bind stat 拿可信 size → size cap),但**拷贝是
// 二进制安全的 fs.copyFile(COPYFILE_EXCL)**,不是 notes 的 readFile('utf-8')
// + 重写 —— 后者对 PDF 等二进制天然走不通(见 importNoteFromFile:80)。
// 后缀白名单在这里**刻意不存在**:「任意文件入库为文献」就是本模块的语义,
// UI 层也不过滤。
//
// id 体系注记(与 0005 迁移行并存):新行 id = litResourceId(absPath),
// repo colsOf 的 lit 分支把 rel_path 也写成 absPath(resources-repo.ts:204-214,
// root 概念 R63 未落地的退化)—— search 命中回推 id 时两代行都满足
// `id === litResourceId(rel_path)`,自洽。fs 调用一律用 absPath 原始分隔符,
// **不要**用 id(id 里的 `\` 已被 litResourceId 归一为 `/`)。
import { constants, promises as fs, realpathSync } from 'fs';
import { lstat } from 'fs/promises';
import { basename, extname, join, resolve } from 'path';
import type { LiteratureImportResult } from '@shared/api-types';
import { WORKSPACE_DATA_LAYOUT } from '../../shared/types';
import { litResourceId } from '../../shared/resource-id';
import { createLogger } from '../utils/logger';
import { errMsg, errnoCode, LibraryError } from '../utils/error';
import { isCaseInsensitiveFs } from '../utils/platform';
import { safeCloseFh, safeTrash } from '../utils/safe-write';
import { isInsideAnyRoot } from '../ipc/paths';
import { MAX_LIBRARY_IMPORT_BYTES } from '../ipc/path-limits';
import { tr } from '../i18n';

const log = createLogger('literature-import');

/** 文献文件的物理落点目录(拷入式导入的目标根)。 */
export function literatureDir(rootPath: string): string {
  return join(rootPath, WORKSPACE_DATA_LAYOUT.LITERATURE_DIR);
}

/**
 * 把 OS 拖入的文件拷贝进 <rootPath>/literature/,返回 lit 行的全部字段来源。
 *
 * 撞名策略:COPYFILE_EXCL 原子探占,O_EXCL 报 EEXIST 时自动 `name (1).ext`
 * 递增重试(上限 1000 ——  pathological 场景直接报错,不无限循环)。
 *
 * @param sourcePath OS 绝对路径(renderer 经 webUtils.getPathForFile 取得)
 * @param rootPath   当前工作目录根(getRootPath())
 */
export async function importLiteratureFile(
  sourcePath: string,
  rootPath: string,
): Promise<LiteratureImportResult> {
  const name = basename(sourcePath);

  // lstat 不 follow:防 symlink 指向 root 外大文件 / 特殊文件被拷进来。
  // 与 notes/import.ts 不同,这里失败直接 throw —— notes 是批量循环可以
  // skipped++,文献导入单文件 IPC,失败必须 surface 给用户(toast)。
  let st: Awaited<ReturnType<typeof lstat>>;
  try {
    st = await lstat(sourcePath);
  } catch (err: unknown) {
    throw new LibraryError(
      'IO_ERROR',
      tr('literature.importFailed', { name, reason: errMsg(err) }),
      err,
    );
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new LibraryError('VALIDATION', tr('literature.importNotRegularFile', { name }));
  }
  // audit-r151:TOCTOU 防 symlink-swap —— 与 notes/import.ts 同款。
  //   lstat 后 attacker 在 lstat/open 之间把普通文件换成 symlink → 任意路径,
  //   fs.open follow 后会把 symlink target 拷进 <rootPath>/literature/。
  //
  // audit-r175 (2026-10-19) —— 旧实现用 `realpathSync(sourcePath) !== sourcePath`
  //   判「文件被 symlink 重定向」,这在 Windows 上**恒为真**:
  //   realpathSync 永远返**反斜杠**形态,而 sourcePath 可能是**正斜杠**
  //   形态(LiteratureService.moveFile 把行的 absPath 存成 toPosix(...))→
  //   只要文献被搬动过一次,再复制/粘贴它就报「不是普通文件,无法作为
  //   文献导入」。实锤(本机 Node):realpathSync('C:/x/native.txt') →
  //   'C:\\x\\native.txt' ≠ 输入。从没搬过的根目录文献正常,所以现象是
  //   「搬过之后就废了」。
  //
  //   换成**inode 比对**(lstat 拿到的 st vs 打开后 fd 绑定的 fhStat):
  //   跨分隔符形态 / 跨大小写都稳定,又真的能识别「文件被换成 symlink」
  //   (ino/dev 变了)。realpath 只在 inode 不可用(ino 与 dev 均为 0,
  //   少数网络 FS)时作为兜底,且比的是**归一化后**的路径。
  //   失败语义与 notes/import.ts 对齐 —— 同样失败走 IO_ERROR(单文件 IPC,
  //   与 lstat 失败的 throw 路径同形态)。

  // size 绑到 fh.stat(TOCTOU-004 同 notes/import.ts:71-73):lstat 的 size 在
  // lstat→open 之间可能已被换;fd 绑 inode 后的 stat 才是可信数字。
  let fh: Awaited<ReturnType<typeof fs.open>> | null = null;
  let srcSize = 0;
  try {
    fh = await fs.open(sourcePath, 'r');
    const fhStat = await fh.stat();
    if (!fhStat.isFile()) {
      throw new LibraryError('VALIDATION', tr('literature.importNotRegularFile', { name }));
    }
    // r175:文件在 lstat→open 之间被换成 symlink / 别的文件 → 拒收。
    //   ino/dev 有一方为 0(少数 FS 不提供)→ 退回归一化 realpath 比对。
    const inodeUsable = st.ino !== 0 || st.dev !== 0;
    if (inodeUsable) {
      if (fhStat.ino !== st.ino || fhStat.dev !== st.dev) {
        throw new LibraryError('VALIDATION', tr('literature.importNotRegularFile', { name }));
      }
    } else {
      const real = realpathSync(sourcePath);
      const norm = (p: string): string => {
        const posix = p.split('\\').join('/');
        return isCaseInsensitiveFs ? posix.toLowerCase() : posix;
      };
      if (norm(real) !== norm(resolve(sourcePath))) {
        throw new LibraryError('VALIDATION', tr('literature.importNotRegularFile', { name }));
      }
    }
    if (fhStat.size > MAX_LIBRARY_IMPORT_BYTES) {
      throw new LibraryError(
        'TOO_LARGE',
        tr('literature.importTooLarge', { name, size: fhStat.size }),
        undefined,
        fhStat.size,
      );
    }
    srcSize = fhStat.size;
  } catch (err: unknown) {
    if (err instanceof LibraryError) throw err;
    throw new LibraryError(
      'IO_ERROR',
      tr('literature.importFailed', { name, reason: errMsg(err) }),
      err,
    );
  } finally {
    await safeCloseFh(fh, 'fh.close failed during literature import', log, { path: sourcePath });
  }

  const dir = literatureDir(rootPath);
  await fs.mkdir(dir, { recursive: true });

  const ext = extname(sourcePath);
  const base = basename(sourcePath, ext);
  let dst = join(dir, name);
  let renamed = false;
  let copied = false;
  for (let n = 1; n <= 1000; n++) {
    try {
      await fs.copyFile(sourcePath, dst, constants.COPYFILE_EXCL);
      copied = true;
      break;
    } catch (err: unknown) {
      if (errnoCode(err) !== 'EEXIST') {
        // audit-r243(2026-10-21):**删掉拷贝失败留下的半份文件**。
        //   fs.copyFile 先创建/截断 dst 再拷内容,中途失败(ENOSPC / EIO /
        //   断电)会留下一个**截断的** dst。旧实现直接抛错,那份半截文件
        //   留在 literature/ 里 ⇒ chokidar 'add' ⇒ reload 把当正常文献
        //   收进 byId + DB ⇒ 用户列表里出现一个打不开的「文献」,还占着
        //   磁盘空间(下方的 size 校验分支会 rm dst,但 copy 失败这条路径
        //   根本走不到那里)。
        //   只在「非 EEXIST」分支删 —— EEXIST 说明 dst 是**别人已有的文件**
        //   (下面要换名重试),删了就是毁用户数据。
        await fs.rm(dst, { force: true }).catch(() => {
          /* 残留清不掉:reload 会按 size/mtime 收进索引,用户手动删即可 */
        });
        throw new LibraryError(
          'IO_ERROR',
          tr('literature.importFailed', { name, reason: errMsg(err) }),
          err,
        );
      }
      dst = join(dir, `${base} (${n})${ext}`);
      renamed = true;
    }
  }
  if (!copied) {
    throw new LibraryError(
      'CONFLICT',
      tr('literature.importFailed', { name, reason: `name collision over ${1000} tries` }),
    );
  }

  // 拷贝后校验:copyFile 按路径重开源(fd 闸到 copy 之间仍有 TOCTOU 窗口),
  // dst 尺寸 ≠ srcSize 说明源在窗口内被换 → 废弃 dst 报错,不落半吊子文件。
  const dstStat = await fs.stat(dst);
  if (dstStat.size !== srcSize) {
    await fs.rm(dst, { force: true });
    throw new LibraryError(
      'IO_ERROR',
      tr('literature.importFailed', { name, reason: 'size changed during copy' }),
    );
  }

  return {
    id: litResourceId(dst),
    absPath: dst,
    filename: basename(dst),
    size: dstStat.size,
    mtime: dstStat.mtimeMs,
    renamed,
  };
}

/**
 * 删文献行时按需物理删文件——只有位于 <rootPath>/literature/ 内(拖入导入
 * 拷出来的行)才动文件;0005 迁移行指向用户旧库路径,只删行不动文件。
 *
 * audit-r175 (2026-10-19) —— 删除走**系统回收站**(electron shell.trashItem),
 * 与笔记域完全一致(notes 侧 r155+ 已改 safeTrash)。旧实现是 fs.unlink
 * 硬删:文献多为 PDF / docx(用户手里往往只有这一份原文),误删即永久丢失,
 * 没有任何找回途径;而同一栏里的笔记删除却能进回收站 —— 两侧行为不一致,
 * 既违反用户「文献和笔记的操作要对应」的诉求,也是一条真实的数据丢失路径。
 *
 * 错误语义:
 *   - ENOENT 容忍(文件已经没了 = 目标已达成)—— safeTrash 内部已吞
 *   - 其它失败(典型:PDF 被阅读器锁着 / 回收站不可用)→ throw,调用方
 *     **保留行**并报错给用户;顺序契约是 removeLiteratureFile 先、
 *     deleteResource 后,宁可留 orphan 行也不静默吞文件
 *   - root 外路径直接返回 false(未动文件),不算错误
 */
export async function removeLiteratureFile(absPath: string, rootPath: string): Promise<boolean> {
  const dir = literatureDir(rootPath);
  if (!isInsideAnyRoot([dir], absPath, { caseInsensitive: isCaseInsensitiveFs })) {
    return false;
  }
  try {
    // safeTrash:走 electron shell.trashItem(Win 回收站 / macOS Trash /
    // Linux XDG trash),用户可从系统回收站恢复;ENOENT 内部吞掉。
    // 越界 / symlink / 非普通文件由 safeTrash 拒收(AppError),这里统一
    // 包成 LibraryError(IO_ERROR) —— 文献域文案保持在这一域内。
    await safeTrash(absPath);
  } catch (err: unknown) {
    throw new LibraryError(
      'IO_ERROR',
      tr('literature.removeFailed', { name: basename(absPath), reason: errMsg(err) }),
      err,
    );
  }
  return true;
}
