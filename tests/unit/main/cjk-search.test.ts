// tests/unit/main/cjk-search.test.ts
//
// 守 r196「中文全文搜索失效」契约。
//
// 现象:FTS5 的 unicode61 分词器把**连续的中文串**当成一个 token
//   (unicode61 不区分文字系统 —— 汉字是 Unicode 字母)。
//   实测(内存库 + unicode61 remove_diacritics 2):
//     搜「学习」  → 0 行
//     搜「机制」  → 0 行
//     搜「注意力」→ 只有恰好在整串开头的那行能命中
//   也就是中文笔记的全文搜索基本不可用(英文搜索正常,掩盖了问题)。
//
// 修法(索引侧 + 查询侧对称):
//   索引侧:写 FTS 时在汉字之间插 ZWSP(U+200B)⇒ 每个汉字独立成 token;
//   查询侧:中文查询改用 FTS5 短语("学 习")⇒ 要求 token 相邻;
//   存量:迁移 0009 用 cjk_seg() 重分词。
//
// 本测锁四件事:
//   1. 分词纯函数行为(含幂等 —— 迁移重跑不能累积 ZWSP);
//   2. 查询串构造(拉丁行为**不变**,中文改短语);
//   3. 端到端:真 SQLite + 真 FTS5 —— 中文子串能搜到、片段干净、
//      拉丁前缀匹配没被改坏;
//   4. 迁移 0009:存量(未分词)行在迁移后**能**被中文搜到。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { NoteResource, ResourceId } from '../../../src/shared/types';

type Db = import('better-sqlite3').Database;

// 主进程 db 句柄由 sqlite.ts 的 getDB 提供 —— 测试里换成内存库。
const { dbRef } = vi.hoisted(() => ({ dbRef: { current: null as Db | null } }));
vi.mock('../../../src/main/db/sqlite', () => ({
  getDB: () => {
    if (!dbRef.current) throw new Error('test db not initialized');
    return dbRef.current;
  },
}));

const {
  ZWSP,
  segmentCjk,
  stripZwsp,
  hasCjk,
  isCjkChar,
  segmentQueryToken,
} = await import('../../../src/main/db/cjk-segment');
const { sanitizeFtsQuery, upsertResource, searchResources } = await import(
  '../../../src/main/db/resources-repo'
);
const { applyMigrations } = await import('../../../src/main/db/migrator');

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../../src/main/db/migrations', import.meta.url),
);

async function openDb(): Promise<Db> {
  const mod = (await import('better-sqlite3')) as unknown as { default: new (p: string) => Db };
  return new mod.default(':memory:');
}

function note(id: string, title: string): NoteResource {
  return {
    kind: 'note',
    id: id as ResourceId,
    title,
    relPath: `${id}.md`,
    tags: [],
    size: 1,
    mtime: 1,
    indexedAt: 1,
  };
}

/** 走真实写路径(upsertResource)插入一条中文笔记。 */
function insertNote(id: string, title: string, body: string): void {
  upsertResource(note(id, title), body, `/abs/${id}.md`);
}

describe('CJK 分词纯函数(r196)', () => {
  it('汉字之间插入 ZWSP', () => {
    expect(segmentCjk('深度学习')).toBe(
      ['深', '度', '学', '习'].join(ZWSP),
    );
  });

  it('CJK↔拉丁边界也断开(否则整串是一个 token,两边都搜不到)', () => {
    expect(segmentCjk('Attention机制')).toBe(['Attention', '机', '制'].join(ZWSP));
  });

  it('纯拉丁文本不被改写', () => {
    expect(segmentCjk('attention is all you need')).toBe('attention is all you need');
  });

  it('幂等:重复分词结果不变(迁移 0009 重跑不能累积 ZWSP)', () => {
    const once = segmentCjk('深度学习 Attention 机制');
    expect(segmentCjk(once)).toBe(once);
  });

  it('stripZwsp 能把分词文本还原成原文', () => {
    expect(stripZwsp(segmentCjk('深度学习'))).toBe('深度学习');
  });

  it('空串安全', () => {
    expect(segmentCjk('')).toBe('');
    expect(stripZwsp('')).toBe('');
  });

  it('CJK 判定:汉字/假名/谚文是,拉丁与数字不是', () => {
    expect(isCjkChar('学')).toBe(true);
    expect(isCjkChar('あ')).toBe(true);
    expect(isCjkChar('한')).toBe(true);
    expect(isCjkChar('a')).toBe(false);
    expect(isCjkChar('1')).toBe(false);
    expect(hasCjk('attention 机制')).toBe(true);
    expect(hasCjk('attention only')).toBe(false);
  });

  it('查询侧切词:汉字逐字,非 CJK 连续段整体保留', () => {
    expect(segmentQueryToken('学习')).toEqual(['学', '习']);
    expect(segmentQueryToken('机器学习')).toEqual(['机', '器', '学', '习']);
    expect(segmentQueryToken('Attention机制')).toEqual(['Attention', '机', '制']);
  });
});

describe('查询串构造(r196)', () => {
  it('中文 → FTS5 短语(每个汉字一个 token)', () => {
    expect(sanitizeFtsQuery('学习')).toBe('"学 习"');
    expect(sanitizeFtsQuery('注意力')).toBe('"注 意 力"');
  });

  it('拉丁 → 前缀通配(旧行为不变)', () => {
    expect(sanitizeFtsQuery('transformer')).toBe('transformer*');
  });

  it('含特殊字符的拉丁 token → 引号短语(旧行为不变)', () => {
    expect(sanitizeFtsQuery('v1.2')).toBe('"v1.2"');
  });

  it('FTS5 保留字兜底不变', () => {
    expect(sanitizeFtsQuery('and')).toBe('a*');
  });

  it('中英混排查询:中文短语 + 拉丁前缀', () => {
    expect(sanitizeFtsQuery('学习 transformer')).toBe('"学 习" transformer*');
  });

  it('空查询返回空串', () => {
    expect(sanitizeFtsQuery('')).toBe('');
    expect(sanitizeFtsQuery('   ')).toBe('');
  });
});

describe('端到端:真 SQLite + 真 FTS5(r196)', () => {
  let db: Db;
  beforeEach(async () => {
    db = await openDb();
    applyMigrations(db, MIGRATIONS_DIR);
    dbRef.current = db;
  });
  afterEach(() => {
    dbRef.current = null;
    db.close();
  });

  it('中文词内子串能搜到(旧实现 0 结果)', () => {
    insertNote('note-1', '深度学习综述', '本文介绍注意力机制的基本原理。');
    expect(searchResources('注意力').map((h) => h.resource.id)).toEqual(['note-1']);
    expect(searchResources('机制').map((h) => h.resource.id)).toEqual(['note-1']);
    expect(searchResources('学习').map((h) => h.resource.id)).toEqual(['note-1']);
  });

  it('片段带高亮标记,且不含 ZWSP 残留', () => {
    insertNote('note-1', '深度学习综述', '本文介绍注意力机制的基本原理。');
    const hit = searchResources('注意力')[0]!;
    expect(hit.snippet).toContain('<mark>注意力</mark>');
    expect(hit.snippet).not.toContain(ZWSP);
    expect(hit.snippet).toBe('本文介绍<mark>注意力</mark>机制的基本原理。');
  });

  it('中文标题也能搜到', () => {
    insertNote('note-1', '深度学习综述', '正文');
    expect(searchResources('综述').map((h) => h.resource.id)).toEqual(['note-1']);
  });

  it('中英混排:中文侧与英文侧各自可搜', () => {
    insertNote('note-1', '注意力机制', 'Attention is all you need. 注意力机制的核心。');
    expect(searchResources('注意力').map((h) => h.resource.id)).toEqual(['note-1']);
    expect(searchResources('attention').map((h) => h.resource.id)).toEqual(['note-1']);
  });

  it('拉丁前缀匹配未被改坏', () => {
    insertNote('note-1', 'Transformer', 'transformer architectures are popular.');
    expect(searchResources('transform').map((h) => h.resource.id)).toEqual(['note-1']);
    expect(searchResources('architecture').map((h) => h.resource.id)).toEqual(['note-1']);
  });

  it('未分词的行搜不到 —— 证明分词是命中的关键(旧行为的对照)', () => {
    // 直接塞未分词的 FTS 行(模拟 r196 之前写入的索引)
    db.prepare(
      `INSERT INTO resources (id, kind, title, rel_path, abs_path, size, mtime, indexed_at, extract_status, tags)
       VALUES ('note-raw', 'note', '注意力机制', 'raw.md', '/abs/raw.md', 1, 1, 1, 'ok', '[]')`,
    ).run();
    db.prepare(
      `INSERT INTO resources_fts (rowid, id, kind, title, body)
       SELECT rowid, id, kind, title, '本文介绍注意力机制。' FROM resources WHERE id = 'note-raw'`,
    ).run();
    expect(searchResources('注意力')).toEqual([]);
  });
});

describe('迁移 0009:存量行重分词(r196)', () => {
  let db: Db;
  beforeEach(async () => {
    db = await openDb();
    // 先停在 v8(0009 之前)
    applyMigrations(db, MIGRATIONS_DIR, 8);
    dbRef.current = db;
  });
  afterEach(() => {
    dbRef.current = null;
    db.close();
  });

  it('迁移前:未分词的存量行搜不到中文子串', () => {
    db.prepare(
      `INSERT INTO resources (id, kind, title, rel_path, abs_path, size, mtime, indexed_at, extract_status, tags)
       VALUES ('note-old', 'note', '注意力机制', 'old.md', '/abs/old.md', 1, 1, 1, 'ok', '[]')`,
    ).run();
    db.prepare(
      `INSERT INTO resources_fts (rowid, id, kind, title, body)
       SELECT rowid, id, kind, title, '本文介绍注意力机制。' FROM resources WHERE id = 'note-old'`,
    ).run();
    expect(searchResources('注意力')).toEqual([]);
  });

  it('迁移后:存量行能被中文搜到,且版本号推进到 9', () => {
    db.prepare(
      `INSERT INTO resources (id, kind, title, rel_path, abs_path, size, mtime, indexed_at, extract_status, tags)
       VALUES ('note-old', 'note', '注意力机制', 'old.md', '/abs/old.md', 1, 1, 1, 'ok', '[]')`,
    ).run();
    db.prepare(
      `INSERT INTO resources_fts (rowid, id, kind, title, body)
       SELECT rowid, id, kind, title, '本文介绍注意力机制。' FROM resources WHERE id = 'note-old'`,
    ).run();

    applyMigrations(db, MIGRATIONS_DIR);

    expect(db.pragma('user_version', { simple: true })).toBe(9);
    const hits = searchResources('注意力');
    expect(hits.map((h) => h.resource.id)).toEqual(['note-old']);
    expect(hits[0]!.snippet).not.toContain(ZWSP);
  });

  it('迁移幂等:再跑一次不累积 ZWSP', () => {
    db.prepare(
      `INSERT INTO resources (id, kind, title, rel_path, abs_path, size, mtime, indexed_at, extract_status, tags)
       VALUES ('note-old', 'note', '注意力机制', 'old.md', '/abs/old.md', 1, 1, 1, 'ok', '[]')`,
    ).run();
    db.prepare(
      `INSERT INTO resources_fts (rowid, id, kind, title, body)
       SELECT rowid, id, kind, title, '本文介绍注意力机制。' FROM resources WHERE id = 'note-old'`,
    ).run();
    applyMigrations(db, MIGRATIONS_DIR);
    const after = db
      .prepare(`SELECT body FROM resources_fts WHERE id = 'note-old'`)
      .get() as { body: string };
    // 强制重跑 0009:把 user_version 拨回去
    db.pragma('user_version = 8');
    applyMigrations(db, MIGRATIONS_DIR);
    const again = db
      .prepare(`SELECT body FROM resources_fts WHERE id = 'note-old'`)
      .get() as { body: string };
    expect(again.body).toBe(after.body);
  });
});
