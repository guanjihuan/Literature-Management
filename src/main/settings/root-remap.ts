// src/main/settings/root-remap.ts
//
// audit-r204:切换数据目录是「整库搬移」,不是「换个扫描根」。
//
// ── 背景(真实 bug,用户可见)──────────────────────────────────────────
//   文献 id = 'lit:' + toPosix(absPath) —— **id 与绝对路径强绑定**。
//   切数据目录时:
//     1. changeDataPath 是**复制**(旧目录原样保留,不是移动);
//     2. SQLite 库住在 userData/index/index.sqlite(全局,**不在**数据根
//        下)⇒ 切换**不会**产生新库,DB 里旧根下的文献行全部存活。
//   随后 literature service 重绑 → reload() 重扫新根:
//     - 新根下的文件算出**新 id** → 落进 disk-only 分支 → upsert 出新行;
//     - 旧行不在新根的 diskIdSet 里 → 落进 db-only 分支,而旧目录的文件
//       **还在**(复制不是移动)⇒ existsSync(旧 absPath) 为真 ⇒ 「保留」。
//   ⇒ 同一个 PDF 在 DB 里留下**两行**(旧 id + 新 id):
//     - 文献列表里**每个 PDF 出现两次**;
//     - 全文搜索返回**重复结果**;
//     - ★ 挂在旧 id 那条上 ⇒ 用户在新目录里看到的是「没收藏」的那条。
//
// ── 修法 ───────────────────────────────────────────────────────────
//   把切换当成一次**整库搬移**:在服务重扫**之前**,把 DB 里旧根下的每一行
//   文献的 id 重算成新根下的 id(单事务 renameResource,见 r201)。
//   于是重扫时新根的 diskIdSet **命中既有行** ⇒ 不再产生 disk-only 新行
//   ⇒ 不重复;★ 的 fileId / relPath 同步改写(favorites 落在新根的
//   favorites.md 里,必须在 favorites 服务重绑到新根**之后**改)。
//
//   笔记侧不需要改 id:note id = frontmatter id 或 relPath 的哈希,而
//   relPath 是**相对 notes/ 目录**的 ⇒ 换根不动。DB 里 note 行的 abs_path
//   会过期,但那一列对 note 从不被读回(见 resources-repo.rowToResource:
//   note 分支不取 abs_path)⇒ 无害,不在本轮范围内。
import { isAbsolute, join, relative, sep } from 'path';
import { listResources, renameResource } from '../db/resources-repo';
import { litResourceId } from '@shared/resource-id';
import { toPosix } from '../notes/path-mapping';
import { WORKSPACE_DATA_LAYOUT } from '@shared/types';
import type { LiteratureResource } from '@shared/types';
import { createLogger } from '../utils/logger';
import { errMsg } from '../utils/error';

const log = createLogger('root-remap');

/** 一条「id 因换根而变」的记录 —— 供收藏(favorites)同步改写。 */
export interface RootSwitchIdRemap {
  /** 变更前的 id(= 旧根下的绝对路径形态) */
  oldId: string;
  /** 变更后的 id(= 新根下的绝对路径形态) */
  newId: string;
  /** 新根下的绝对路径(同时写进 favorites entry 的 relPath) */
  path: string;
}

/**
 * absPath 是否位于 root 之下;是则返回相对路径,否则 null。
 *
 * 边界:
 *   - root 本身(相对路径为空串)不算「在根之下」;
 *   - 兄弟目录(`..` / `..\foo`)不算 —— 注意**不能**只判 startsWith('..'):
 *     名为 `..foo` 的兄弟目录会被误判成越界;
 *   - 跨盘符(Windows 上 relative 返回绝对路径)⇒ null。
 */
export function relUnderRoot(root: string, absPath: string): string | null {
  if (!root || !absPath) return null;
  const rel = relative(root, absPath);
  if (rel === '' || isAbsolute(rel)) return null;
  if (rel === '..' || rel.startsWith(`..${sep}`)) return null;
  return rel;
}

/**
 * 换根重算文献 id —— 把 DB 里「旧根下」的文献行改写成「新根下」的形态。
 *
 * 单行失败(DB 忙 / FTS 报错)不阻断其余行:失败的那行保持旧 id ⇒ 该文献在
 * 列表里会**多出一份**(旧 id 的保留行 + 新 id 的新行),但不会连累别的文献
 * 也重复。逐行记 error,便于事后从日志定位。
 *
 * @returns 成功改写的 id 映射表(供 favorites 同步改写 fileId / relPath)
 */
export function remapLiteratureIdsForRootSwitch(
  oldRoot: string,
  newRoot: string,
): RootSwitchIdRemap[] {
  const remaps: RootSwitchIdRemap[] = [];
  if (!oldRoot || !newRoot || oldRoot === newRoot) return remaps;

  const newLitDir = join(newRoot, WORKSPACE_DATA_LAYOUT.LITERATURE_DIR);
  // listResources('literature') 已按 kind 过滤,返回类型仍是 Resource 联合
  // (note | literature)—— TS 看不到运行时过滤,需 narrow。
  const rows = listResources('literature');
  for (const r of rows) {
    if (r.kind !== 'literature') continue;
    const rel = relUnderRoot(oldRoot, r.absPath);
    if (rel === null) continue; // 不在旧根下(别的库 / 手工导入的外部文件)
    const newAbs = join(newRoot, rel);
    const newId = litResourceId(toPosix(newAbs));
    if (newId === r.id) continue; // 已经是新根形态(幂等)
    const next: LiteratureResource = {
      ...r,
      id: newId,
      absPath: newAbs,
      // 文献的「文件夹归属」是相对 literature 根的 POSIX 路径 —— 换根后
      // 归属本身不变(目录结构照搬),但基准目录换了,重算一次保持自洽。
      relPath: toPosix(relative(newLitDir, newAbs)),
    };
    try {
      // 单事务「upsert 新行 + 删旧行」(r201)—— 中途失败不会留下两行。
      // body 传 '':文献的 FTS 正文一直是空的(正文抽取流水线尚未落地),
      // 传 '' 不会丢任何已索引内容。
      renameResource(r.id, next, '', newAbs);
    } catch (err: unknown) {
      log.error('Literature id remap failed', r.id, '->', newId, errMsg(err));
      continue;
    }
    remaps.push({ oldId: r.id, newId, path: newAbs });
  }

  if (remaps.length > 0) {
    log.info('Literature ids remapped for new data path', { count: remaps.length });
  }
  return remaps;
}
