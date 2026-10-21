// tests/unit/main/db-update-resource-stat.test.ts
//
// 守 r211 新增的 `updateResourceStat` 契约:**只更 stat 两列,不碰 FTS**。
//
// 为什么需要它(而不是直接用现成的 upsertResource):
//   upsertResource 的语义是「FTS DELETE → 主表 upsert → FTS INSERT」,
//   body 由 caller 给。刷 stat 的 caller 手上只有 '' ⇒ 将来抽过正文
//   (indexed_at ≠ 0)的文献,正文会被**清空** ⇒ 全文搜索再也搜不到。
//   刷 stat 是「文件元数据变了」,与索引面无关 ⇒ 必须有一条**只动主表**
//   的写路径。
//
// 本测(真 SQLite + 真 FTS5)锁三件事:
//   1. size / mtime 被更新;
//   2. FTS 里的正文**原样保留**(仍能搜到)—— 这是本函数存在的理由;
//   3. FTS 行数不变(不产生重复 / 孤儿索引行)。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { LiteratureResource, ResourceId } from '../../../src/shared/types';

type Db = import('better-sqlite3').Database;

// 主进程 db 句柄由 sqlite.ts 的 getDB 提供 —— 测试里换成内存库。
const { dbRef } = vi.hoisted(() => ({ dbRef: { current: null as Db | null } }));
vi.mock('../../../src/main/db/sqlite', () => ({
  getDB: () => {
    if (!dbRef.current) throw new Error('test db not initialized');
    return dbRef.current;
  },
}));

const { upsertResource, getResource, searchResources, updateResourceStat } = await import(
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

const LIT_ID = 'lit:/tmp/paper.pdf' as ResourceId;

function litRow(): LiteratureResource {
  return {
    kind: 'literature',
    id: LIT_ID,
    title: '注意力机制',
    mtime: 1,
    size: 1,
    indexedAt: 42,
    absPath: '/tmp/paper.pdf',
    rootId: null,
    extractStatus: 'ok',
  };
}

describe('updateResourceStat:只更 stat 两列,不碰 FTS(r211)', () => {
  beforeEach(async () => {
    dbRef.current = await openDb();
    applyMigrations(dbRef.current, MIGRATIONS_DIR);
  });

  afterEach(() => {
    dbRef.current?.close();
    dbRef.current = null;
  });

  it('size / mtime 被更新', () => {
    upsertResource(litRow(), 'transformer 注意力机制的正文', '/tmp/paper.pdf');

    updateResourceStat(LIT_ID, 4096, 1_700_000_000_000);

    const row = getResource(LIT_ID);
    expect(row?.size).toBe(4096);
    expect(row?.mtime).toBe(1_700_000_000_000);
  });

  it('FTS 正文原样保留(刷 stat 不许清索引面)', () => {
    upsertResource(litRow(), 'transformer 注意力机制的正文', '/tmp/paper.pdf');
    expect(searchResources('transformer')).toHaveLength(1);

    updateResourceStat(LIT_ID, 4096, 1_700_000_000_000);

    expect(searchResources('transformer')).toHaveLength(1);
    // 「正文」只出现在 body 里(title 是「注意力机制」)⇒ 命中即证明 body 还在
    expect(searchResources('正文')).toHaveLength(1);
  });

  it('FTS 行数不变(不产生重复 / 孤儿索引行)', () => {
    upsertResource(litRow(), 'transformer 注意力机制的正文', '/tmp/paper.pdf');

    updateResourceStat(LIT_ID, 4096, 1_700_000_000_000);

    const db = dbRef.current!;
    const count = db.prepare('SELECT count(*) AS c FROM resources_fts WHERE id = ?').get(LIT_ID) as {
      c: number;
    };
    expect(count.c).toBe(1);
  });

  it('行不存在时静默无操作(不抛错)', () => {
    expect(() => updateResourceStat('lit:/nope.pdf' as ResourceId, 1, 1)).not.toThrow();
  });
});
