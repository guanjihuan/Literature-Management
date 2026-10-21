// OS 拖入 .md → 解析 frontmatter → 创建笔记 + 写 body。单文件导入
// (renderer 循环发 IPC,主进程由 writeLock 串行化);复用 standalone.createNote +
// writeNote。5MB 上限走 MAX_NOTE_BODY_BYTES 共享常量。
import { promises as fs, realpathSync } from 'fs';
import { lstat } from 'fs/promises';
import { basename, extname, resolve } from 'path';
import matter from 'gray-matter';
import type { NotesImportResult } from '@shared/api-types';
import { createLogger } from '../utils/logger';
import { LibraryError, errMsg } from '../utils/error';
import { tr } from '../i18n';
import { safeCloseFh } from '../utils/safe-write';
import { isCaseInsensitiveFs } from '../utils/platform';
import { createNote, writeNote } from './standalone';
import { cleanTags, cleanTitle } from '../utils/frontmatter';
import { MAX_NOTE_BODY_BYTES as MAX_IMPORT_BYTES } from '../ipc/path-limits';

const log = createLogger('notes-import');

/** 从 OS 拖入的 .md 文件创建新笔记。
 *
 * @param sourcePath  OS 文件绝对路径(renderer 通过 File.path 拿到,Electron 30 可用)
 * @param dataPath    当前设置的数据目录(createNote 的目标)
 * @returns           导入统计(成功时 copied=1,失败时 errors[0] 携带 reason)
 */
/**
 * 从 OS 拖入的 .md 文件创建新笔记。
 *
 * @param sourcePath  OS 绝对路径(renderer 通过 File.path / webUtils 拿)
 * @param dataPath    当前数据目录(createNote 的目标)
 * @returns           导入统计(copied/skipped/errors + createdIds 列表)
 */
export async function importNoteFromFile(
  sourcePath: string,
  dataPath: string,
): Promise<NotesImportResult> {
  // 异步 lstat:同步 lstat 阻塞事件循环 ~5-30ms,改 fs.promises.lstat 让 libuv worker
  // 处理;用 lstat 不 stat 正确识别 symlink(防 follow 越界)。lstat 失败走 skipped
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(sourcePath);
  } catch (err: unknown) {
    log.warn('lstat failed, skipping', sourcePath, errMsg(err));
    return { copied: 0, skipped: 1, errors: [{ source: sourcePath, reason: errMsg(err) }] };
  }

  if (stat.isSymbolicLink()) {
    return { copied: 0, skipped: 1, errors: [] };
  }
  if (!stat.isFile()) {
    return { copied: 0, skipped: 1, errors: [] };
  }
  // audit-r151:TOCTOU 防 symlink-swap —— lstat 后 attacker 可在 lstat/open 之间把
  //   普通文件换成 symlink → /etc/passwd。Node 的 fs.constants.O_NOFOLLOW 不存在,
  //   用「打开后比对 inode」收紧(见下方 open 块内的 r197 段)。
  //
  // audit-r197:旧实现用 `realpathSync(sourcePath) !== sourcePath` 判「被 symlink
  //   重定向」,这在 Windows 上**恒为真**:realpathSync 永远返**反斜杠**形态,而
  //   sourcePath 可能是**正斜杠**形态(笔记被搬动过一次后 relPath 就是 POSIX
  //   形态)⇒ 只要路径形态对不上就静默 skip,用户看到「拖进来没反应」。
  //   文献侧在 r175 已查清并改成 inode/dev 比对,笔记侧这次跟上(两域同款)。
  //   真正的判定挪到 open 之后(拿到 fd 绑定的 fhStat 才可信)——
  //   见下面 open 块里的同名注释。

  // 后缀白名单(.md / .markdown),大小写不敏感 — 主进程最后一道防线,renderer 可能
  // 因 bug / 注入绕过 UI 层 endsWith(.md) 预判
  // rawExt 保留原始大小写:basename(path, ext) 大小写敏感,后续 validator 要求
  // lowercase '.md',传 '.md' 不会剥掉 '.MD' 后缀
  const rawExt = extname(sourcePath);
  const ext = rawExt.toLowerCase();
  if (ext !== '.md' && ext !== '.markdown') {
    throw new LibraryError('IO_ERROR', tr('notes.importNotMd', { name: basename(sourcePath) }));
  }

  // size 绑到 fh.stat(TOCTOU-004):lstat 拿到的 size 在 lstat 与 readFile 之间可能被替换,
// fd 解析 symlink 后绑到目标 inode,后续 stat/read 从同一 fd 走,size 校验才可信

  // gray-matter 解析失败时降级:raw 当 body,filename 当 title —— 不抛,让用户内容能导入。
  // 极端损坏(non-UTF-8)的 .md 抛真错误向上冒泡
  let raw: string;
  let fh: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    fh = await fs.open(sourcePath, 'r');
    const fhStat = await fh.stat();
    if (!fhStat.isFile()) {
      log.warn('import: source not regular file, skipping', sourcePath);
      return { copied: 0, skipped: 1, errors: [] };
    }
    // r197:TOCTOU 防 symlink-swap —— inode/dev 比对(与 literature/import.ts 同款)。
    //   lstat 拿到的 st 与「打开后 fd 绑定的」fhStat 是同一个文件 ⇒ ino/dev 相同。
    //   文件在 lstat→open 之间被换成 symlink / 别的文件 ⇒ ino/dev 变了 ⇒ 拒收。
    //   inode 不可用(ino 与 dev 均为 0,少数网络 FS)时退回归一化 realpath 比对。
    const inodeUsable = stat.ino !== 0 || stat.dev !== 0;
    if (inodeUsable) {
      if (fhStat.ino !== stat.ino || fhStat.dev !== stat.dev) {
        log.warn('import: source replaced between lstat and open, skipping', sourcePath);
        return { copied: 0, skipped: 1, errors: [] };
      }
    } else {
      const real = realpathSync(sourcePath);
      const norm = (p: string): string => {
        const posix = p.split('\\').join('/');
        return isCaseInsensitiveFs ? posix.toLowerCase() : posix;
      };
      if (norm(real) !== norm(resolve(sourcePath))) {
        log.warn('import: source is a symlink (realpath divergence), skipping', sourcePath);
        return { copied: 0, skipped: 1, errors: [] };
      }
    }
    if (fhStat.size > MAX_IMPORT_BYTES) {
      throw new LibraryError('IO_ERROR', tr('notes.importTooLarge', { size: fhStat.size }));
    }
    raw = await fh.readFile('utf-8');
  } catch (err: unknown) {
    throw new LibraryError('IO_ERROR', tr('notes.importFailed', { reason: errMsg(err) }));
  } finally {
    await safeCloseFh(fh, 'fh.close failed during notes import', log, { path: sourcePath });
  }

  let body = raw;
  let titleFromFm: string | undefined;
  let tagsFromFm: string[] | undefined;
  // r197:源 frontmatter 的**其余**字段原样带过去(doi / year / author /
  //   citekey / status / …)。旧实现只挑 title + tags 两个键,其余全丢 ——
  //   用户从 Obsidian / Zotero / Obsidian 插件导出的笔记,那些研究元数据
  //   进了应用就消失(正文里没有、frontmatter 里也没有,等于**永久丢失**)。
  //   与「保存时保留用户手写 frontmatter」是同一条契约(2026-10-04 起
  //   writeNote 用 existingFm 垫底),导入是这条契约的入口缺口。
  const extraFm: Record<string, unknown> = {};
  // audit 2026-09-16 r21:M15 — frontmatter 解析失败时既 log 又 surface 给 UI。
  //   之前只 log.warn,用户拖入一个 .md 没出现笔记也不知道为什么。
  //   errors[] 让 renderer toast「导入成功但 frontmatter 解析失败」,内容
  //   仍按"全文当 body"降级导入(语义不变)。
  const parseWarnings: string[] = [];
  try {
    const parsed = matter(raw);
    body = parsed.content;
    const fm = parsed.data as Record<string, unknown>;
    // cleanTitle 200-char 截断:与 readNote/scanNotes 同源,防源 .md 里 1MB title 无 cap 进入
    const cleanedTitle = cleanTitle(fm);
    if (cleanedTitle !== null) titleFromFm = cleanedTitle;
    tagsFromFm = cleanTags(fm) ?? undefined;
    // 其余字段:title / tags 走各自的清洗路径,id / created / updated 由
    //   writeNote 统一管(见 standalone.ts writeNote 的 fm 组装段)——
    //   这五个键不在此处搬运,避免「源文件的 id 覆盖掉按 relPath 重算的 id」。
    for (const [k, v] of Object.entries(fm)) {
      if (k === 'title' || k === 'tags' || k === 'id' || k === 'created' || k === 'updated') continue;
      extraFm[k] = v;
    }
  } catch (err: unknown) {
    const reason = errMsg(err);
    parseWarnings.push(`frontmatter: ${reason}`);
    log.warn('frontmatter parse failed, importing as plain body', sourcePath, reason);
  }

  // basename(去 ext)传 validator,内部会再补一次 .md 后缀(createNote 需要它)
  // 用 rawExt 不 lowercase:basename 大小写敏感,传 '.md' 不会剥掉 '.MD'
  const sourceBase = basename(sourcePath, rawExt);
  const note = await createNote(dataPath, sourceBase);

  // preserveExisting 保留 createNote 写的 created 字段,updated 由 writeNote 自动刷新
  // tags 仅在 frontmatter 显式给时才传(undefined → preserveExisting 兜底,避免空 tags 写成 null)
  const fm: Record<string, unknown> = { ...extraFm };
  if (titleFromFm !== undefined) fm['title'] = titleFromFm;
  if (tagsFromFm !== undefined) fm['tags'] = tagsFromFm;
  await writeNote(dataPath, note.relPath, body, fm, { preserveExisting: true });

  // copied=1(导入本身成功);createdIds 让 NotesList 对最后一条自动 select + focus + scroll
  // r175:createdRelPaths —— 主进程用它把导入的笔记登记进 NotesService.byId
  //   + resources 表(旧实现导入完全绕开 service,导入的笔记在本次会话内
  //   永远不进 byId:renderer 紧接着的「移入当前文件夹」必 NOT_FOUND,
  //   而 resources 表缺行 → 全局搜索永远搜不到这条笔记)。
  if (parseWarnings.length > 0) {
    return {
      copied: 1,
      skipped: 0,
      errors: [],
      warnings: parseWarnings,
      createdIds: [note.id],
      createdRelPaths: [note.relPath],
    };
  }
  return {
    copied: 1,
    skipped: 0,
    errors: [],
    createdIds: [note.id],
    createdRelPaths: [note.relPath],
  };
}
