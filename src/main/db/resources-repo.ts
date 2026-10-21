// audit-r64:resources / resources_fts 的唯一读写口
// 取代 sqlite.ts 的 FilesRepo / NotesRepo / searchAll
//
// FTS 同步模型:application-managed,无触发器
//   - resources_fts 是普通 FTS5 表,DELETE WHERE rowid=? 即可移除 token
//   - 每个写路径单事务内做 FTS DELETE → 主表 upsert → FTS INSERT
//   - 禁止对本表发 'rebuild'(普通表上 = 清空索引)
//
// 单表红利:bm25 分母统一,跨 kind 排序可比
//
// r196:CJK 分词契约(索引侧)
//   写 FTS 时,title / body 会先经 segmentCjk 切分(汉字之间插 ZWSP),
//   因为 unicode61 会把整串中文当**一个** token ⇒ 中文词内子串搜不到。
//   查询侧由 sanitizeFtsQuery 改用 FTS5 短语,片段返回前洗掉 ZWSP。
//   详见 src/main/db/cjk-segment.ts。**主表 resources 的 title/body 不分词**
//   (主表是数据面,FTS 表才是索引面)。
//
// r208:中英混排查询契约(查询侧)
//   含 CJK 的 token 按文字系统切 run,每个 run 一个子句,子句间是隐式 AND。
//   ⇒ 「CNN模型」与「CNN 模型」产生完全相同的查询串,带不带空格不影响结果。
import type Database from 'better-sqlite3';
import type { Statement } from 'better-sqlite3';
import { getDB } from './sqlite';
import { errMsg } from '../utils/error';
import { createLogger } from '../utils/logger';
import type {
  LiteratureResource,
  NoteResource,
  Resource,
  ResourceId,
  ResourceKind,
} from '@shared/types';
// r194:高亮标记常量(值导入)—— snippet() 的标记必须与渲染侧解析用的
//   格式同源,见 shared/types.ts 的契约注释。
import { SEARCH_SNIPPET_MARK_CLOSE, SEARCH_SNIPPET_MARK_OPEN } from '@shared/types';
// r196:CJK 分词(索引侧切分 / 查询侧短语 / 展示侧清洗)
import {
  hasCjk,
  segmentCjk,
  segmentQueryToken,
  splitScriptRuns,
  stripZwsp,
} from './cjk-segment';

const log = createLogger('resources-repo');

interface ResourceRow {
  id: string;
  kind: string;
  title: string;
  rel_path: string;
  abs_path: string;
  root_id: string | null;
  size: number;
  mtime: number;
  indexed_at: number;
  extract_status: string;
  page_count: number | null;
  tags: string;
}

function parseTags(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

export function rowToResource(row: ResourceRow): Resource {
  const base = {
    id: row.id as ResourceId,
    title: row.title,
    mtime: row.mtime,
    size: row.size,
    indexedAt: row.indexed_at,
  };
  if (row.kind === 'note') {
    const note: NoteResource = {
      ...base,
      kind: 'note',
      relPath: row.rel_path,
      tags: parseTags(row.tags),
    };
    return note;
  }
  const lit: LiteratureResource = {
    ...base,
    kind: 'literature',
    absPath: row.abs_path,
    rootId: row.root_id,
    extractStatus: row.extract_status as LiteratureResource['extractStatus'],
    pageCount: row.page_count ?? undefined,
  };
  return lit;
}

// statement/tx 按 db 实例身份缓存:closeDB → 换新句柄时旧缓存自动失效,
// 避免 db → repo → db 的环依赖
interface TxSet {
  upsert: (id: string, kind: string, title: string, relPath: string, absPath: string,
    rootId: string | null, size: number, mtime: number, indexedAt: number,
    extractStatus: string, pageCount: number | null, tags: string, body: string) => void;
  remove: (id: string) => void;
  rename: (prevId: string, id: string, kind: string, title: string, relPath: string,
    absPath: string, rootId: string | null, size: number, mtime: number, indexedAt: number,
    extractStatus: string, pageCount: number | null, tags: string, body: string) => void;
}

let cache: { db: Database.Database; stmts: Map<string, Statement>; tx: TxSet } | null = null;

function prep(sql: string): Statement {
  const db = getDB();
  if (!cache || cache.db !== db) {
    cache = { db, stmts: new Map(), tx: buildTx(db) };
  }
  let s = cache.stmts.get(sql);
  if (!s) {
    s = db.prepare(sql);
    cache.stmts.set(sql, s);
  }
  return s;
}

function requireTx(): TxSet {
  const db = getDB();
  if (!cache || cache.db !== db) {
    cache = { db, stmts: new Map(), tx: buildTx(db) };
  }
  return cache.tx;
}

const UPSERT_MAIN_SQL = `
  INSERT INTO resources (id, kind, title, rel_path, abs_path, root_id,
                         size, mtime, indexed_at, extract_status, page_count, tags)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    kind=excluded.kind,
    title=excluded.title,
    rel_path=excluded.rel_path,
    abs_path=excluded.abs_path,
    root_id=excluded.root_id,
    size=excluded.size,
    mtime=excluded.mtime,
    indexed_at=excluded.indexed_at,
    extract_status=excluded.extract_status,
    page_count=excluded.page_count,
    tags=excluded.tags
`;
const DEL_FTS_SQL = `DELETE FROM resources_fts WHERE rowid = (SELECT rowid FROM resources WHERE id = ?)`;
const INS_FTS_SQL = `INSERT INTO resources_fts (rowid, id, kind, title, body)
  VALUES ((SELECT rowid FROM resources WHERE id = ?), ?, ?, ?, ?)`;
const DEL_MAIN_SQL = `DELETE FROM resources WHERE id = ?`;

function buildTx(db: Database.Database): TxSet {
  const upsertMain = db.prepare(UPSERT_MAIN_SQL);
  const delFts = db.prepare(DEL_FTS_SQL);
  const insFts = db.prepare(INS_FTS_SQL);
  const delMain = db.prepare(DEL_MAIN_SQL);

  type Cols = [
    id: string, kind: string, title: string, relPath: string, absPath: string,
    rootId: string | null, size: number, mtime: number, indexedAt: number,
    extractStatus: string, pageCount: number | null, tags: string, body: string,
  ];
  const upsertOne = (c: Cols): void => {
    // 顺序硬约束:FTS DELETE 先(按 rowid 精确移除旧 token),主表 upsert 次之,
    // FTS INSERT 最后拿 upsert 后的 rowid;ON CONFLICT DO UPDATE 不改变 rowid
    delFts.run(c[0]);
    upsertMain.run(...c.slice(0, 12));
    // r196:写进 FTS 的 title / body 先做 CJK 分词(汉字之间插 ZWSP)。
    //   unicode61 不分文字系统 —— 整串中文会被当成**一个** token,
    //   导致「学习」「机制」这类词内子串 0 命中。主表拿到的是**原文**
    //   (c[2] 不分词),数据面与索引面分工明确。
    insFts.run(c[0], c[0], c[1], segmentCjk(c[2]), segmentCjk(c[12]));
  };
  const removeOne = (id: string): void => {
    delFts.run(id);
    delMain.run(id);
  };

  return {
    upsert: db.transaction((...c: Cols) => upsertOne(c)),
    remove: db.transaction((id: string) => removeOne(id)),
    rename: db.transaction((prevId: string, ...c: Cols) => {
      // 不变量:upsert 新行 + 删旧行必须同事务,崩溃不留 orphan
      // r161 disk-folder:folder_id 列已删,upsertOne 写完整新行,删旧行无
      //   folder 归属搬运负担(物理 relPath 即组织层,rename 后新行 relPath
      //   直接是组织位置的真相)
      upsertOne(c);
      removeOne(prevId);
    }),
  };
}

function colsOf(r: Resource, absPath: string, body: string): Parameters<TxSet['upsert']> {
  if (r.kind === 'note') {
    return [
      r.id, 'note', r.title, r.relPath, absPath, null,
      r.size, r.mtime, r.indexedAt, 'ok', null, JSON.stringify(r.tags), body,
    ];
  }
  return [
    r.id, 'literature', r.title, litRelPath(r), r.absPath, r.rootId,
    r.size, r.mtime, r.indexedAt, r.extractStatus, r.pageCount ?? null, '[]', body,
  ];
}

// literature 的 rel_path 存相对所属 root;root 概念 R63 落地,当前 caller 只能给 absPath
// 这里先退化为 absPath 本身,保证 NOT NULL 约束
function litRelPath(r: LiteratureResource): string {
  return r.absPath;
}

/**
 * upsert 一条 resource + 同步 FTS body。单事务;FTS 抛错整体回滚。
 *
 * @param absPath note 的绝对路径由 caller 算(repo 不反向依赖 notes/db ← notes 单向)
 */
export function upsertResource(r: Resource, body: string, absPath: string): void {
  try {
    requireTx().upsert(...colsOf(r, absPath, body));
  } catch (err: unknown) {
    log.error('upsertResource transaction failed for', r.id, errMsg(err));
    throw err;
  }
}

export function deleteResource(id: ResourceId): void {
  requireTx().remove(id);
}

/**
 * 只更新主表的 size / mtime —— **不碰 FTS**。
 *
 * r211:文献文件在磁盘上被替换(重下 / 同步盘覆盖 / 备份还原)后,reload
 *   需要把行上的 stat 刷成磁盘真值。走 upsertResource 是不行的:那条路
 *   的语义是「FTS DELETE → 主表 upsert → FTS INSERT」,body 由 caller 给
 *   —— 刷 stat 的 caller 手上只有 '' ⇒ 将来抽过正文(indexed_at ≠ 0)的
 *   文献正文会被**清空**,全文搜索再也搜不到。刷 stat 是「文件元数据变了」,
 *   与索引面无关 ⇒ 必须有一条**只动主表**的写路径。
 *
 * 幂等:值没变时也照样执行一次 UPDATE(调用方自己判过差异,不重复调)。
 * 行不存在时静默无操作(0 行受影响,不抛错)。
 */
export function updateResourceStat(id: ResourceId, size: number, mtime: number): void {
  prep(`UPDATE resources SET size = ?, mtime = ? WHERE id = ?`).run(size, mtime, id);
}

/**
 * rename(id 变化 = relPath 变化)的事务化同步:upsert 新行 + 删旧行同事务。
 * body 必须随新行重喂 FTS(title/body 都可能随 rename 变)。
 */
export function renameResource(prevId: ResourceId, r: Resource, body: string, absPath: string): void {
  // audit-r101:prevId === r.id(同名确认路径:rename dialog 输入带 .md 后缀的
  //   原名,normalize 后 relPath 不变,renameNote 早返当前 note,IPC 仍调本
  //   函数)→ 不能走 rename tx:upsertOne 之后 removeOne(prevId) 会把刚写入
  //   的行整行删除(主表 + FTS 双删,笔记从列表/搜索消失,toast 却报成功;
  //   磁盘文件无恙、无 watcher 事件,要等下次启动 resync 差集自愈)。
  //   同 id rename 语义 = 纯 upsert(幂等覆盖,FTS 先删后插不留孤儿)。
  if (prevId === r.id) {
    upsertResource(r, body, absPath);
    return;
  }
  try {
    requireTx().rename(prevId, ...colsOf(r, absPath, body));
  } catch (err: unknown) {
    log.error('renameResource transaction failed for', r.id, errMsg(err));
    throw err;
  }
}

export function getResource(id: ResourceId): Resource | null {
  const row = prep(`SELECT * FROM resources WHERE id = ?`).get(id) as ResourceRow | undefined;
  return row ? rowToResource(row) : null;
}

export function listResources(kind?: ResourceKind): Resource[] {
  const rows = (
    kind
      ? prep(`SELECT * FROM resources WHERE kind = ? ORDER BY rel_path`).all(kind)
      : prep(`SELECT * FROM resources ORDER BY kind, rel_path`).all()
  ) as ResourceRow[];
  return rows.map(rowToResource);
}

/** 轻量 rel_path 收集,resync 差集用。 */
export function listResourceRelPaths(kind: ResourceKind): string[] {
  return prep(`SELECT rel_path FROM resources WHERE kind = ?`).pluck().all(kind) as string[];
}

/**
 * indexed_at = 0 = FTS body 未填;NotesService.resyncIfNeeded 捡这些重读磁盘回填。
 */
export function listStaleIndexIds(kind: ResourceKind): ResourceId[] {
  return prep(`SELECT id FROM resources WHERE kind = ? AND indexed_at = 0`)
    .pluck()
    .all(kind) as ResourceId[];
}

export interface ResourceHit {
  resource: Resource;
  snippet: string; // <mark> 标记高亮
  score: number;
}

// r196:snippet() 的窗口长度(单位 = token)。
//   索引侧 CJK 按**单字**分词 ⇒ 中文正文里 1 token ≈ 1 个汉字(≈2 显示列);
//   拉丁正文里 1 token ≈ 1 个词(≈6 显示列)。窗口若都用 12,中文预览只有
//   ~24 显示列(拉丁的一半),上下文被砍得只剩几个字。故按查询是否含 CJK
//   分档:中文查询给 40 token(≈80 显示列),拉丁维持 12(与 r194 前一致,
//   不改动既有拉丁行为的观感)。
const SNIPPET_TOKENS_CJK = 40;
const SNIPPET_TOKENS_LATIN = 12;

/**
 * 单表 MATCH + snippet + bm25。bm25 分母统一,跨 kind ORDER BY score 合法。
 * snippet 优先 body,body 空回退 title(0005 迁移行 body='' 时 title 片段仍可用)。
 */
export function searchResources(
  query: string,
  opts: { kind?: ResourceKind; limit?: number } = {},
): ResourceHit[] {
  const q = sanitizeFtsQuery(query);
  if (!q) return [];
  const limit = opts.limit ?? 50;
  const kindFilter = opts.kind ? `AND r.kind = ?` : '';
  const snippetTokens = hasCjk(query) ? SNIPPET_TOKENS_CJK : SNIPPET_TOKENS_LATIN;
  // r194:高亮标记的字面量走共享常量(shared/types.ts)—— 主进程写死的
  //   '<mark>' 与渲染进程解析用的格式必须是同一份,否则高亮静默失效。
  //   标记本身是**协议**而非展示:渲染侧按标记切分后用 React 元素渲染,
  //   绝不能 dangerouslySetInnerHTML(片段原文来自用户笔记正文)。
  // r196:窗口长度改成绑定参数(实测 FTS5 接受参数化的 nToken),好让
  //   「中文查询给更宽的窗口」不必复制一份 SQL。
  const rows = prep(
    `
    SELECT r.*,
           snippet(resources_fts, 2, '${SEARCH_SNIPPET_MARK_OPEN}', '${SEARCH_SNIPPET_MARK_CLOSE}', '...', ?) AS t_snip,
           snippet(resources_fts, 3, '${SEARCH_SNIPPET_MARK_OPEN}', '${SEARCH_SNIPPET_MARK_CLOSE}', '...', ?) AS b_snip,
           bm25(resources_fts) AS score
    FROM resources_fts
    JOIN resources r ON r.rowid = resources_fts.rowid
    WHERE resources_fts MATCH ?
    ${kindFilter}
    ORDER BY score
    LIMIT ?
  `,
  ).all(
    snippetTokens,
    snippetTokens,
    ...(opts.kind ? [q, opts.kind, limit] : [q, limit]),
  ) as Array<ResourceRow & { t_snip: string; b_snip: string; score: number }>;
  return rows.map((h) => ({
    resource: rowToResource(h),
    // 命中可能在 title(列 2)或 body(列 3);优先取**带高亮**的那段
    // (COALESCE 按"非空"优先会错取 body 的开头原文,丢掉 title 的高亮)。
    // r196:片段里的 ZWSP 是索引侧分词的副产品 —— 展示前洗掉,否则用户
    //   会看到一串不可见字符(复制出去也是坏的)。
    snippet: stripZwsp(h.t_snip.includes('<mark>') ? h.t_snip : h.b_snip),
    score: h.score,
  }));
}

// FTS5 query 清洗 — from sqlite.ts
// audit 2026-09-10:FTS5 保留字 AND/OR/NOT/NEAR 会让 sanitize 后的 "and*" 报 syntax error
const FTS5_RESERVED = new Set(['and', 'or', 'not', 'near']);
const FTS5_FALLBACK_TOKEN = 'a';

/**
 * FTS5 bareword 安全字符:Unicode 字母/数字/下划线。
 * 含其它字符的 token 必须整体加引号,否则 fts5 报 syntax error。
 */
const FTS5_BAREWORD_SAFE_RE = /^[\p{L}\p{N}_]+$/u;

/**
 * CJK 串 → FTS5 短语(逐字 token,要求相邻)。
 *
 * r196:索引侧把汉字逐字切开,查询侧必须**对称**地切开:「学习」→ `"学 习"`,
 *   FTS5 短语要求两个 token 相邻 ⇒ 命中所有含「学习」的文本且保序。
 *   短语内不加前缀通配(FTS5 的前缀语义只作用于短语最后一个 token,
 *   对中文会产生「学习* 命中 习题」这类反直觉结果)。
 */
function cjkPhrase(text: string): string {
  const parts = segmentQueryToken(text);
  return parts.length ? `"${parts.join(' ')}"` : '';
}

/**
 * 拉丁串 → 前缀通配(bareword)或引号短语(含特殊字符)。
 *
 * 沿用旧行为 —— 纯 bareword 加前缀通配(`abc*` 命中 abcd),
 * 含特殊字符的加引号当短语(`"v1.2"` 精确命中,见 audit 2026-10-04)。
 */
function latinTerm(text: string): string {
  return FTS5_BAREWORD_SAFE_RE.test(text) ? `${text}*` : `"${text}"`;
}

/**
 * 把一个查询 token 变成 FTS5 表达式片段。
 *
 * r208:token 按**文字系统**切成若干 run,每个 run 一个子句,子句之间用
 *   空格(= FTS5 的隐式 AND)连接。
 *
 *   '学习'      → "学 习"              (单 run ⇒ 一个短语,行为同 r196)
 *   'transformer' → transformer*        (单 run ⇒ 前缀通配,行为同旧版)
 *   'CNN模型'   → CNN* "模 型"          (混排 ⇒ 两个子句,AND)
 *
 * 为什么要改混排:旧实现把混排 token 整体当**一个短语**(「CNN 模 型」),
 *   而 FTS5 短语要求 token **相邻** ⇒ 文档里必须出现「CNN模型」且中间
 *   不能夹别的汉字才命中。用户写「CNN模型」(不空格)常常搜不到,写
 *   「CNN 模型」(带空格)却搜得到 —— 同一篇文档,两种写法结果不同。
 *   改成按 run 拆子句后,「CNN模型」与「CNN 模型」产生**完全相同**的
 *   查询串(见 ARCHITECTURE §5.6),带不带空格不再影响结果。
 *
 * 注:混排拆分只会**放宽**命中范围(短语形式蕴含 AND 形式:短语命中
 *   ⇒ 两侧 token 必然相邻 ⇒ AND 必然成立),不会漏掉原本能命中的文档。
 */
function fts5Term(token: string): string {
  const runs = splitScriptRuns(token);
  if (!runs.length) return '';
  const clauses = runs
    .map((r) => (r.cjk ? cjkPhrase(r.text) : latinTerm(r.text)))
    .filter(Boolean);
  return clauses.join(' ');
}

export function sanitizeFtsQuery(q: string): string {
  const trimmed = q.trim();
  if (!trimmed) return '';
  const tokens = trimmed
    .replace(/"/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(/[^\p{L}\p{N}_\-.]/gu, ''))
    .filter(Boolean)
    .map((t) => (FTS5_RESERVED.has(t.toLowerCase()) ? FTS5_FALLBACK_TOKEN : t));
  if (!tokens.length) return '';
  // audit 2026-10-04:加引号判据从「含 '-'」改成「含任何非 bareword 安全字符」
  //   旧实现漏 '.' '/',含点的 token 拼成 v1.2* 直接 syntax error(DOI 也中招)
  //   用白名单判,新增字符默认被引号兜住,不会再漏
  //   用引号而非删点:删点把 v1.2 变成 v12,索引里没有,静默 0 条;引号按短语匹配能正确命中
  return tokens.map(fts5Term).join(' ');
}
