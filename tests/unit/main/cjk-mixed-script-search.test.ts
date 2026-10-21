// tests/unit/main/cjk-mixed-script-search.test.ts
//
// 守 r208「中英混排查询 0 命中」契约。
//
// 现象(2026-10-20 内存库实测,真 SQLite + 真 FTS5):
//   文档正文:「本文介绍 CNN 图像分类模型 的基本原理。」
//   搜「CNN 模型」(带空格) → 1 条
//   搜「CNN模型」(不带空格) → **0 条**
//   同一篇文档,只是少打一个空格,结果从"搜得到"变成"搜不到"。
//
// 根因:r196 之后,含 CJK 的查询 token 一律被拼成**一个 FTS5 短语**
//   (「CNN模型」→「"CNN 模 型"」)。FTS5 短语要求 token **相邻**,而
//   索引侧把每个汉字切成了独立 token ⇒ 文档里必须出现连续的
//   「CNN 模 型」才命中。文档写的是「CNN 图像分类模型」——中间隔着
//   「图像分类」四个 token ⇒ 短语不成立 ⇒ 0 结果。
//   而带空格的写法被切成两个 token(CNN* AND "模 型")⇒ 能命中。
//
// 修法:混排 token 按**文字系统**切 run,每个 run 一个子句,子句之间
//   用空格(= FTS5 隐式 AND)连接 ⇒「CNN模型」与「CNN 模型」产生
//   完全相同的查询串,带不带空格不再影响结果。
//
// 本测锁四件事:
//   1. 混排 token 与「带空格」写法产生**完全相同**的查询串(核心不变量);
//   2. 混排 token 不再被当成一个整体短语;
//   3. 纯中文 / 纯拉丁的既有行为**不变**(不顺手放宽);
//   4. 端到端(真 SQLite + 真 FTS5):不写空格也能搜到、缺一侧不命中
//      (是 AND 不是 OR)、片段高亮正常且无 ZWSP 残留。
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

const { ZWSP, splitScriptRuns } = await import('../../../src/main/db/cjk-segment');
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

function insertNote(id: string, title: string, body: string): void {
  upsertResource(note(id, title), body, `/abs/${id}.md`);
}

describe('按文字系统切 run(r208 纯函数)', () => {
  it('连续汉字合成一个 run,汉字与拉丁各成一段', () => {
    expect(splitScriptRuns('模型')).toEqual([{ cjk: true, text: '模型' }]);
    expect(splitScriptRuns('CNN模型')).toEqual([
      { cjk: false, text: 'CNN' },
      { cjk: true, text: '模型' },
    ]);
    expect(splitScriptRuns('模型CNN')).toEqual([
      { cjk: true, text: '模型' },
      { cjk: false, text: 'CNN' },
    ]);
    expect(splitScriptRuns('Attention机制')).toEqual([
      { cjk: false, text: 'Attention' },
      { cjk: true, text: '机制' },
    ]);
  });

  it('纯拉丁 / 空串', () => {
    expect(splitScriptRuns('transformer')).toEqual([{ cjk: false, text: 'transformer' }]);
    expect(splitScriptRuns('')).toEqual([]);
  });
});

describe('查询串构造(r208)', () => {
  it('核心不变量:混排 token 与「带空格」写法产生完全相同的查询串', () => {
    expect(sanitizeFtsQuery('CNN模型')).toBe(sanitizeFtsQuery('CNN 模型'));
    expect(sanitizeFtsQuery('模型CNN')).toBe(sanitizeFtsQuery('模型 CNN'));
    expect(sanitizeFtsQuery('Attention机制')).toBe(sanitizeFtsQuery('Attention 机制'));
  });

  it('混排 token 不再被当成一个整体短语(否则要求跨文字系统相邻)', () => {
    expect(sanitizeFtsQuery('CNN模型')).not.toBe('"CNN 模 型"');
    expect(sanitizeFtsQuery('CNN模型')).toBe('CNN* "模 型"');
  });

  it('纯中文仍是短语(r196 行为不变)', () => {
    expect(sanitizeFtsQuery('学习')).toBe('"学 习"');
    expect(sanitizeFtsQuery('注意力')).toBe('"注 意 力"');
  });

  it('纯拉丁仍是前缀通配(旧行为不变)', () => {
    expect(sanitizeFtsQuery('transformer')).toBe('transformer*');
    expect(sanitizeFtsQuery('v1.2')).toBe('"v1.2"');
  });

  it('token 之间的空格仍是 AND(r196 行为不变)', () => {
    expect(sanitizeFtsQuery('学习 transformer')).toBe('"学 习" transformer*');
  });

  it('空查询返回空串', () => {
    expect(sanitizeFtsQuery('')).toBe('');
    expect(sanitizeFtsQuery('   ')).toBe('');
  });
});

describe('端到端:真 SQLite + 真 FTS5(r208)', () => {
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

  it('不写空格也能搜到(旧实现 0 结果)', () => {
    insertNote('note-1', '混合笔记', '本文介绍 CNN 图像分类模型 的基本原理。');
    expect(searchResources('CNN模型').map((h) => h.resource.id)).toEqual(['note-1']);
    // 带空格的写法一直能命中 —— 两者现在结果一致
    expect(searchResources('CNN 模型').map((h) => h.resource.id)).toEqual(['note-1']);
  });

  it('跨文字系统不相邻也能搜到(旧实现要求相邻)', () => {
    insertNote('note-1', '注意力机制', 'Attention 的应用很广，机制 相当复杂。');
    expect(searchResources('Attention机制').map((h) => h.resource.id)).toEqual(['note-1']);
  });

  it('缺一侧不命中 —— 是 AND 不是 OR', () => {
    insertNote('note-a', '卷积网络', 'CNN 是卷积神经网络的简称。');
    insertNote('note-b', '抽象模型', '模型 是对事物的抽象。');
    expect(searchResources('CNN模型')).toEqual([]);
  });

  it('片段带高亮标记,且不含 ZWSP 残留', () => {
    insertNote('note-1', '混合笔记', '本文介绍 CNN 图像分类模型 的基本原理。');
    const hit = searchResources('CNN模型')[0]!;
    expect(hit.snippet).toContain('<mark>');
    expect(hit.snippet).not.toContain(ZWSP);
  });
});
