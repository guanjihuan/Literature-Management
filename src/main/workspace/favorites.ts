// 独立收藏 — 单文件收藏 ★ 文献列表(显示分组但不提供 CRUD)
// 重构 (2026-08-28):原 collection 模块已删除,「收藏分组」功能并入 favorites —
//   每个 entry 可以是 kind: 'file'(★ 单文件)或 kind: 'group'(多文件分组 + 描述)。
//   老 schema(无 kind 字段)= 视为 kind: 'file',与历史数据兼容。
// 重构 (2026-09 V1.4):group CRUD(createGroup/deleteGroup/addItemToGroup/...
//   removeItemFromGroup/setGroupDescription)整体下线 —— favorites 分组只读,
//   ★ toggle 与 chip 过滤由 LibraryList 提供(audit-r71 删 LibraryList,
//   r72 起由 LiteratureList 提供)。IPC + preload + api + 服务方法
//   全删。分组数据仍由 normalizeEntries 解析,V2.0 需要管理 UI 时再 wire 起来。
// 数据落在 <rootPath>/workspace/favorites/favorites.md(SSOT =
//   WORKSPACE_DATA_LAYOUT.FAVORITES_FILE,运行时 join(getRootPath(), …) 拼出;
//   audit-r124:原文「data/workspace/favorites/…」是相对默认父目录的写法,
//   恰在默认配置下成立(location.ts:rootPath 默认 = <Documents>/ResearchHub/data),
//   但用户改库位置后 data/ 一级并不存在 —— 权威锚应为 rootPath)
//   - frontmatter.entries: 权威源(应用读这个)
//   - body: 人类可读的星标清单 + 分组列表
// 路径走 WORKSPACE_DATA_LAYOUT 单一真相源
import { EventEmitter } from 'events';
import { join } from 'path';
import matter from 'gray-matter';
import type { FavoritesEntry, FavoritesFileEntry, FavoritesGroupEntry } from '@shared/types';
import { WORKSPACE_DATA_LAYOUT, SCHEMA_VERSION } from '@shared/types';
import { getRootPath } from '../utils/safe-write';
import { AppError, ValidationError } from '../utils/error';
import { AtomicFile } from '../utils/atomic-file';
import { newShortId } from '../utils/short-id';
import { asFrontmatter } from '../utils/frontmatter';
import { createLogger } from '../utils/logger';

const log = createLogger('favorites');

interface FavoritesFileShape {
  schemaVersion: number;
  entries: FavoritesEntry[];
  updatedAt: string;
}

// 重构 (2026-09 V1.4 + audit round 17):FavoritesEntry 直接用 @shared/types 的版本,
//   本地不再 re-export — 之前 `export type FavoritesEntry = ...` 与 shared 重名,
//   迁移模块从 ./favorites import 这个别名是循环依赖风险。删后类型在文件内部仍可
// 用(隐式从 shared import 拿),无需重新声明。

export class FavoritesService extends EventEmitter {
  private file: AtomicFile<FavoritesFileShape> | null = null;

  async start(): Promise<void> {
    // audit 2026-10-01:幂等守卫 —— 与 NotesService.start() 的
    // `if (this.started) return` 对齐。旧实现没有守卫,二次 start() 会
    // `new AtomicFile` 覆盖 this.file,**上一个实例的 in-flight writeQueue
    // 失去引用**(它上面的 'changed' 订阅也一并丢掉)。本项目当前只在启动
    // 路径调一次,所以没暴露;但只要将来出现第二条启动路径(迁移后重启 /
    // 手动 retry),就会静默丢事件 + 丢待写数据。
    if (this.file) return;
    const filePath = join(getRootPath(), WORKSPACE_DATA_LAYOUT.FAVORITES_FILE);
    this.file = new AtomicFile<FavoritesFileShape>({
      filePath,
      defaultValue: {
        schemaVersion: SCHEMA_VERSION.FAVORITES,
        entries: [],
        updatedAt: new Date().toISOString(),
      },
      // audit round 14 (2026-09-15):CQ-007 — 用 asFrontmatter helper 替代
      //   inline `v as unknown as Record<string, unknown>` cast。frontmatter.ts
      //   集中维护 gray-matter 类型适配,改 helper 一处即可,本文件不再读一行
      //   强类型断言。
      serialize: (v) => matter.stringify(buildBody(v), asFrontmatter(v)),
      parse: (raw) => {
        const parsed = matter(raw);
        // gray-matter + js-yaml 可能把 ISO 字符串解析成 Date;这里用 unknown 兜底
        const fm = parsed.data as {
          updatedAt?: unknown;
          schemaVersion?: unknown;
          entries?: unknown;
        };
        // r196:entries 形态非法 → **抛错**,让 AtomicFile.start() 走 quarantine
        //   分支(把原文件 rename 成 `<file>.corrupt-<ts>` 保留内容)。
        //
        //   旧实现 `Array.isArray(fm.entries) ? fm.entries : []` 把「手编时把
        //   entries 写成映射 / 留空 / 写成字符串」一律降级成**空列表**,
        //   而解析**不抛错** ⇒ quarantine 不触发 ⇒ 下一次 ★ toggle 就拿空
        //   内存态 persist 覆盖整个文件 ⇒ 用户的收藏**永久消失**,磁盘上
        //   没有任何 .corrupt 备份、没有任何日志痕迹(只有一条 warn)。
        //
        //   favorites.md 是设计成**支持手编**的(文件头注),形态非法是
        //   「用户手滑」而不是「应用没写好」⇒ 宁可让收藏功能本次不可用
        //   (quarantine 后内存态回落空列表),也不能静默销毁用户数据 ——
        //   与 AtomicFile 那句「宁可让这个功能暂时不可用,也不能静默销毁
        //   用户数据」同一条原则。
        if (fm.entries !== undefined && !Array.isArray(fm.entries)) {
          throw new Error(
            'favorites.md frontmatter.entries must be an array — refusing to load ' +
              '(the file will be quarantined as .corrupt-*)',
          );
        }
        const entries = Array.isArray(fm.entries) ? fm.entries : [];
        const updatedAt = asIsoString(fm.updatedAt);
        // 重构 (2026-08-28):用 normalizeEntries 替代 inline isValidEntry —— 现在
        // 是 union 类型,需要给老 schema(无 kind 字段)打 'file' 标,并把 group.items
        // 数组内每条都规整为完整 FavoritesFileEntry。
        const normalized = normalizeEntries(entries);
        return {
          schemaVersion:
            typeof fm.schemaVersion === 'number' ? fm.schemaVersion : SCHEMA_VERSION.FAVORITES,
          entries: normalized,
          updatedAt: updatedAt ?? new Date().toISOString(),
        };
      },
      onChange: (v) => this.emit('changed', v),
      logScope: 'favorites',
    });
    await this.file.start();
    log.info('Favorites loaded', this.file.get().entries.length, 'entries');
  }

  /** 返回完整 entry 列表(供 UI 渲染标题/路径)。
   *  重构 (2026-09 round 21):删原 list() 返回 string[] 的 API —— production 全部走
   *  listEntries()(renderer 在 store 内 filter kind === 'file' 派生 favoritedFileIds),
   *  无 caller 直接调 list()。测试侧通过 listEntries().filter(...).map(...) 一行替换。 */
  listEntries(): FavoritesEntry[] {
    if (!this.file) return [];
    return this.file.get().entries;
  }

  /** 切换收藏态:已收藏则移除,未收藏则加入。返回新的收藏态。
   *  重构 (2026-08-28):只动 file kind —— group 是用户创建的分组容器,
   *  不该被单文件 ★ 操作影响。
   *  audit 2026-09-10:start / validation 失败抛 AppError / ValidationError —— 旧
   *    实现裸 Error 走 wrap.ts → INTERNAL,用户看到通用内部错误。favorites 启
   *    动期是"应用刚 boot 还没就绪"语义,跟真正的内部错误不能混。 */
  async toggle(fileId: string, info?: { title?: string; relPath?: string }): Promise<boolean> {
    if (!this.file) throw new AppError('NOT_READY', 'favorites service not started');
    if (!fileId) throw new ValidationError('fileId is required', 'fileId');
    let nowFavorited = false;
    await this.file.update((curr) => {
      const existing = curr.entries.find((e) => e.kind === 'file' && e.fileId === fileId);
      if (existing) {
        nowFavorited = false;
        return {
          ...curr,
          entries: curr.entries.filter((e) => !(e.kind === 'file' && e.fileId === fileId)),
          updatedAt: new Date().toISOString(),
        };
      }
      // audit 2026-09-10:加新条目时要求 info 至少有一个非空字段 ——
      //   之前任何 fileId 都能成功加入,即便 title / relPath 都是空。
      //   真实事件:renderer stale UI(用户点过 ★ 但文件已 chokidar 删除)
      //   → toggle(fileId) 写入 favorites.md 一条空 title/relPath 记录,
      //   UI 用 favoritedFileIds Set 显示 ★ 但 favorites 列表因为 title 空
      //   显示为空,孤儿记录永远占着 disk。下次清理逻辑也没有,只能手动
      //   编辑 .md 文件。
      //   修法:title 和 relPath 同时为空 → throw ValidationError,让 UI 显式
      //   不显示 ★ 给无法填充元数据的文件,或允许「仅 fileId」时把现有 entry
      //   当孤儿(下一步)。
      // audit-r151:trim 后判断 —— 原实现 `'   '.length > 0` 视为非空,纯空白
      //   title 写进 favorites.md 渲染成「·  」不可读条目;trim 后既识别纯空白
      //   又与 buildBody 渲染时 trim 行为对齐,避免「输入空格通过 + 显示被截」
      //   的语义不一致。
      const titleRaw = info?.title ?? '';
      const relPathRaw = info?.relPath ?? '';
      const title = titleRaw.trim();
      const relPath = relPathRaw.trim();
      if (!title && !relPath) {
        throw new ValidationError(
          'Cannot add favorite without title or relPath — caller must provide real file metadata',
          'fileId',
        );
      }
      nowFavorited = true;
      const entry: FavoritesFileEntry = {
        kind: 'file',
        id: newShortId(),
        fileId,
        title,
        relPath,
        addedAt: new Date().toISOString(),
      };
      return {
        ...curr,
        entries: [entry, ...curr.entries],
        updatedAt: new Date().toISOString(),
      };
    });
    return nowFavorited;
  }

  /**
   * r198:资源被删除(移入回收站)后,清掉它的收藏条目。
   *
   * 背景:删除路径一直**只**动文件 + DB 行,不动 favorites.md ⇒ 文件没了,
   *   收藏条目还留着(孤儿)。三个后果:
   *   1. favorites.md 无限增长(每个删掉的 ★ 文献留一条);
   *   2. **★ 状态错位**:文献 id = 'lit:'+toPosix(absPath) —— 把同一个
   *      文件从原路径再导入一次 ⇒ id 相同 ⇒ 新行**继承**旧 ★,用户看到
   *      一个自己没点过的星;再点一下是「取消收藏」(toggle 语义),用户
   *      反而更困惑;
   *   3. notes 域同样有孤儿(虽然还没有笔记 ★ 的 UI,但 favorites.md 是
   *      设计上可手工编辑的文件,老版本 / 手改都可能留下笔记条目)。
   *
   * 幂等:不存在的 id 直接跳过;集合里没有命中项时**不写盘**(避免每次
   * 删除都无谓地重写 favorites.md)。只动 kind==='file' 的条目 —— group
   * 是用户自建的容器,不该被单文件删除牵连。
   */
  async removeIds(ids: string[]): Promise<number> {
    if (!this.file) return 0;
    const set = new Set(ids.filter((id) => typeof id === 'string' && id.length > 0));
    if (set.size === 0) return 0;
    // 先看有没有命中 —— 没有就不进 update(update 无条件 persist)。
    const hasHit = this.file
      .get()
      .entries.some((e) => e.kind === 'file' && set.has(e.fileId));
    if (!hasHit) return 0;
    let changed = 0;
    await this.file.update((curr) => {
      const kept = curr.entries.filter((e) => {
        if (e.kind !== 'file' || !set.has(e.fileId)) return true;
        changed++;
        return false;
      });
      if (changed === 0) return curr;
      return { ...curr, entries: kept, updatedAt: new Date().toISOString() };
    });
    log.info('Favorites entries removed for deleted resources', { changed });
    return changed;
  }

  async stop(): Promise<void> {
    // audit 2026-10-01:排空写队列后**清掉 this.file**。
    //   旧实现只 `await this.file.stop()`(那只是等 AtomicFile 的 writeQueue
    //   flush,不是「卸载」),this.file 仍非 null → toggle() 开头的
    //   `if (!this.file) throw NOT_READY` 守卫在「已停止」之后依然不生效:
    //   退出流程中 stop() 之后抵达的 IPC toggle 仍会照常写盘。
    //   与 NotesService 的 started=false 语义对齐(它 stop 后 byId.clear() 且
    //   started=false,caller 侧立刻进入明确的「已停」态)。
    if (this.file) {
      await this.file.stop();
      this.file = null;
    }
  }

  /**
   * r182:资源 id 变更后,把收藏条目里的 fileId 跟着改 —— 否则用户的 ★ 静默
   * 消失(favorites.md 里还留着旧 id,但 UI 按 id 过滤,旧 id 再也不会命中
   * 任何一行 ⇒ 收藏列表里那条记录变成永远点不亮的孤儿)。
   *
   * 触发场景(全是「id 与路径强绑定」的操作):
   *   - 文献搬进/搬出文件夹:lit id = 'lit:'+toPosix(absPath),路径变 id 变;
   *   - 文件夹改名 / 跨目录搬移:子树里每个文献的 id 全变;
   *   - 笔记改名 / 跨文件夹搬移:fm.id = SHA-256(relPath) 前 16 位,路径变 id 变。
   *
   * pathMap 可选:同时改写 entry.relPath(收藏面板显示的路径)。各域存的东西
   *   不一样 —— literature 侧 renderer 存的是**绝对路径**(LiteratureList
   *   handleToggleFavorite 传 r.absPath),notes 侧存的是相对 notes/ 的
   *   relPath;调用方按域给对即可。缺省只改 fileId(★ 的显示只认 fileId)。
   *
   * 返回改写条数(0 = 没有收藏指向这些 id,或服务未启动)。
   */
  async remapIds(map: Map<string, string>, pathMap?: Map<string, string>): Promise<number> {
    if (!this.file) return 0;
    if (map.size === 0) return 0;
    // 先干读一遍:AtomicFile.update 每次都会 persist,没命中还写一次盘
    //   (mtime 抖动 + 无谓的 'changed' 广播 → renderer 白刷一次)
    let hit = 0;
    for (const e of this.file.get().entries) {
      if (e.kind === 'file' && map.has(e.fileId)) hit++;
    }
    if (hit === 0) return 0;

    let changed = 0;
    await this.file.update((curr) => {
      let dirty = false;
      const entries = curr.entries.map((e) => {
        if (e.kind !== 'file') return e;
        const newId = map.get(e.fileId);
        if (newId === undefined) return e;
        const newPath = pathMap?.get(e.fileId);
        if (newId === e.fileId && (newPath === undefined || newPath === e.relPath)) return e;
        dirty = true;
        changed++;
        return { ...e, fileId: newId, relPath: newPath ?? e.relPath };
      });
      if (!dirty) return curr;
      return { ...curr, entries, updatedAt: new Date().toISOString() };
    });
    log.info('Favorites ids remapped', { changed });
    return changed;
  }
}

/** 一条「资源 id 变更」记录 —— 供 remapFavoriteIds 消费。 */
export interface FavoriteIdRemap {
  /** 变更前的 id(与 favorites.md 里 entry.fileId 同形) */
  oldId: string;
  /** 变更后的 id */
  newId: string;
  /** 新的展示路径(写进 entry.relPath);缺省则保留原值 */
  path?: string;
}

/**
 * r182:便捷入口 —— 把 id 变更表喂给 favorites 服务。
 *   幂等:oldId === newId 的条目直接跳过;服务未启动(测试环境 / 早于启动
 *   序)时静默返回 0(此时也还没有任何收藏数据可改)。
 */
export async function remapFavoriteIds(items: FavoriteIdRemap[]): Promise<number> {
  if (items.length === 0) return 0;
  const map = new Map<string, string>();
  const pathMap = new Map<string, string>();
  for (const it of items) {
    if (!it.oldId || !it.newId || it.oldId === it.newId) continue;
    map.set(it.oldId, it.newId);
    if (it.path !== undefined) pathMap.set(it.oldId, it.path);
  }
  if (map.size === 0) return 0;
  return getFavoritesService().remapIds(map, pathMap);
}

/**
 * r198:便捷入口 —— 资源被删除后清掉它的收藏条目。
 *   与 remapFavoriteIds 同款语义:服务未启动(测试环境 / 早于启动序)时
 *   静默返回 0(此时也还没有任何收藏数据可清)。
 */
export async function removeFavoriteIds(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  return getFavoritesService().removeIds(ids);
}

function asIsoString(v: unknown): string | null {
  // audit 2026-10-01:MEDIUM — string 分支原先**原样返回、不做合法性校验**。
  //   favorites.md 在这个项目里是设计上就支持手工编辑的(见文件头注),而
  //   YAML 里的 `addedAt: 2024年1月1日` 会被解析成 string,V8 的 Date 解析不了
  //   它 → 后面 buildBody 的 `new Date(e.addedAt).toISOString()` 抛 RangeError。
  //   而 serialize 是 AtomicFile.persist 的**第一条语句**、在 writeQueue 临界
  //   区里,抛错时 this.current 不会被替换 → 内存态持续带毒,此后**每一次**
  //   toggle 都失败,且没有任何自愈路径(只能手改文件)。用户看到的还是通用
  //   内部错误,完全指不到「你手写的那行日期格式不对」。
  //
  //   修:这里就校验掉。校验不过返回 null,交给调用方 `?? new Date().toISOString()`
  //   回落 —— 与 Date 分支的既有语义一致(无效就用现在)。
  if (typeof v === 'string') {
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : v;
  }
  if (v instanceof Date && !isNaN(v.getTime())) return v.toISOString();
  return null;
}

/**
 * 渲染 addedAt 为 `YYYY-MM-DD HH:mm`,非法值回落到原字符串。
 *
 * audit 2026-10-01:与 asIsoString 同源的兜底。即便 asIsoString 已经在 parse
 *   阶段挡住了非法值,buildBody 仍直接 `new Date(...).toISOString()` —— 任何
 *   绕过 normalize 的路径(或将来新增的 entry 来源)都会让它抛 RangeError,
 *   而那会把整个收藏文件写成"毒状态"。这里不让它抛。
 */
function formatAddedAt(s: string): string {
  const d = new Date(s);
  if (isNaN(d.getTime())) return String(s);
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

// 重构 (2026-08-28):parse-time normalize —— 给老 schema entry 补 kind 字段 + group
// items 内部归一化。老 favorites 文件可能没有 `kind` 字段;parse 时把每条 entry
// 都打上 'file' 标。group.items 数组内每条都需要 file 五字段,缺字段的直接丢掉,
// 不静默保留半残数据。
//
// audit 2026-10-04:MEDIUM —— 「缺字段就丢」在这里是**数据丢失**,不是无害的清理。
//   favorites.md 是设计成**支持手编**的(文件头注明「人类可读优先」),而 YAML 会
//   把看起来像字符串的值解析成别的类型:`title: 2024` → number,`id: 12` → number。
//   旧实现对四个字段全部要求 `typeof === 'string'`,于是这类条目被 `continue`
//   静默丢弃;`parse` 又不抛错,`AtomicFile.start()` 的 quarantine 也不会触发。
//   真正的杀伤在**下一次 toggle**:persist → buildBody 用内存态重写整个文件,
//   被丢的条目从磁盘上永久消失,没有 quarantine、没有 toast、没有任何痕迹。
//
//   修法(分级,尽量不丢):
//     - `title` 接受任意原始类型并 String() 化(数字年份是最常见的误写);
//     - `id` 缺失/非字符串时用 `fileId` 顶上(两者都来自同一条 entry,不是编造);
//     - 只有 `fileId` / `relPath` 这类**无法重建的身份字段**缺失时才丢,且必须
//       留下 warn 日志(原来连日志都没有)。
function coerceText(v: unknown): string | null {
  if (typeof v === 'string') return v;
  // YAML 会把 `2024` / `true` 解析成 number / boolean;手编场景下它们就是文本
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

function normalizeEntries(entries: unknown): FavoritesEntry[] {
  if (!Array.isArray(entries)) return [];
  const out: FavoritesEntry[] = [];
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const o = e as Record<string, unknown>;
    const kind = o['kind'] === 'group' ? 'group' : 'file';
    if (kind === 'file') {
      const addedAt = asIsoString(o.addedAt) ?? new Date().toISOString();
      const fileId = coerceText(o.fileId);
      const title = coerceText(o.title);
      const relPath = coerceText(o.relPath);
      // id 是内部标识(serialize 时原样写出),缺失时用 fileId 顶上
      const id = coerceText(o.id) ?? fileId;
      if (fileId && title !== null && relPath !== null && id) {
        out.push({ kind: 'file', id, fileId, title, relPath, addedAt });
      } else {
        log.warn('Dropping malformed favorites file entry (hand-edited?)', {
          hasId: typeof o.id === 'string',
          fileId: typeof o.fileId,
          title: typeof o.title,
          relPath: typeof o.relPath,
        });
      }
    } else {
      // group
      // group
      //
      // audit 2026-10-04:group 的标量字段也放宽。旧实现要求 id/name/description/
      // createdAt/updatedAt **全部**是 string,任何一项不合规就把**整组连同它
      // 里面所有条目**一起丢掉 —— 而「手编时忘了写 description」远比「title 写成
      // 数字」常见(它看起来就是可选字段)。丢一组的损失远大于丢一条。
      const gId = coerceText(o.id) ?? coerceText(o.name);
      const gName = coerceText(o.name);
      if (gId && gName) {
        const rawItems = Array.isArray(o.items) ? o.items : [];
        const items: FavoritesFileEntry[] = [];
        for (const it of rawItems) {
          if (!it || typeof it !== 'object') continue;
          const r = it as Record<string, unknown>;
          const itemAddedAt = asIsoString(r.addedAt) ?? new Date().toISOString();
          // 与顶层 file entry 同款处理(见 normalizeEntries 头注)
          const itemFileId = coerceText(r.fileId);
          const itemTitle = coerceText(r.title);
          const itemRelPath = coerceText(r.relPath);
          const itemId = coerceText(r.id) ?? itemFileId;
          if (itemFileId && itemTitle !== null && itemRelPath !== null && itemId) {
            items.push({
              kind: 'file',
              id: itemId,
              fileId: itemFileId,
              title: itemTitle,
              relPath: itemRelPath,
              addedAt: itemAddedAt,
            });
          } else {
            log.warn('Dropping malformed favorites group item (hand-edited?)', {
              hasId: typeof r.id === 'string',
              fileId: typeof r.fileId,
              title: typeof r.title,
              relPath: typeof r.relPath,
            });
          }
        }
        out.push({
          kind: 'group',
          id: gId,
          name: gName,
          // 缺失/非字符串时兜底,不因此丢掉整组
          description: coerceText(o.description) ?? '',
          items,
          createdAt: asIsoString(o.createdAt) ?? new Date().toISOString(),
          updatedAt: asIsoString(o.updatedAt) ?? new Date().toISOString(),
        });
      } else {
        log.warn('Dropping malformed favorites group (hand-edited?)', {
          hasId: typeof o.id === 'string',
          name: typeof o.name,
        });
      }
    }
  }
  return out;
}

// 重构 (2026-09):buildBody / normalizeEntries 改回 module-private —— 原 export
//   是给 migration.ts V3 把老 data/collections/ 合并进 favorites.md 复用。
//   migration.ts 2026-09 V1.4 整体下线后,这两个 export 无外部 caller,内部
//   caller(serialize / parse 走同一份实现)始终存在,export 失去意义。
// audit 2026-09 (V1.9):补一笔 —— 之前导出是为了 V3 migration 共享实现;
//   V3 下线后只 favorites.ts 内部用,export 是 dead export。改回 function
//   关键字,所有现有 caller(serialize / parseEntries 内部)继续走同一份实现。
function buildBody(state: FavoritesFileShape): string {
  const lines: string[] = [];
  lines.push('# 收藏');
  lines.push('');
  if (state.entries.length === 0) {
    lines.push('> 尚未收藏任何文献');
    lines.push('');
    return lines.join('\n');
  }
  // 重构 (2026-08-28):group 单独一段,file 走原表格
  const files = state.entries.filter((e): e is FavoritesFileEntry => e.kind === 'file');
  const groups = state.entries.filter((e): e is FavoritesGroupEntry => e.kind === 'group');
  if (files.length > 0) {
    lines.push(`## 星标 (${files.length})`);
    lines.push('');
    lines.push('| 收藏时间 | 标题 | 路径 |');
    lines.push('|---|---|---|');
    for (const e of files) {
      const t = formatAddedAt(e.addedAt);
      const title = e.title.replace(/\|/g, '\\|').replace(/\n/g, ' ');
      const rel = e.relPath.replace(/\|/g, '\\|');
      lines.push(`| ${t} | ${title} | \`${rel}\` |`);
    }
    lines.push('');
  }
  for (const g of groups) {
    lines.push(`## 分组 · ${g.name} (${g.items.length})`);
    if (g.description) lines.push(`> ${g.description}`);
    lines.push('');
    if (g.items.length === 0) {
      lines.push('_(空)_');
      lines.push('');
      continue;
    }
    lines.push('| 收藏时间 | 标题 | 路径 |');
    lines.push('|---|---|---|');
    for (const e of g.items) {
      const t = formatAddedAt(e.addedAt);
      const title = e.title.replace(/\|/g, '\\|').replace(/\n/g, ' ');
      const rel = e.relPath.replace(/\|/g, '\\|');
      lines.push(`| ${t} | ${title} | \`${rel}\` |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

let _instance: FavoritesService | null = null;
export function getFavoritesService(): FavoritesService {
  if (!_instance) _instance = new FavoritesService();
  return _instance;
}
