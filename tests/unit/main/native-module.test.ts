// tests/unit/main/native-module.test.ts
//
// 守卫:当前测试运行器下 better-sqlite3 原生模块必须真的能加载并读写。
//
// 为什么要有这条(2026-10-19 实地复现):
//   better-sqlite3 不是 N-API,一个 .node 只对应一个 ABI —— Electron 30.5 用
//   ABI 123,系统 Node 24 用 ABI 137,两者共用同一个
//   node_modules/better-sqlite3/build/Release/better_sqlite3.node。
//   旧 pretest 钩子为了跑测试会**破坏性重建**这份模块(把 app 那份覆盖成
//   Node 版),Windows 上文件被运行中的 electron 进程锁住 → EBUSY →
//   整条 `npm run test:run` 中止,哪怕测试本身全绿。
//
//   现在 scripts/run-tests.cjs 改成自适应:能用系统 Node 加载就用系统 Node,
//   否则用 Electron 自带 Node 跑(ELECTRON_RUN_AS_NODE=1),测试与 app 共用
//   同一份原生模块,不再有互相覆盖。
//
//   这条测试锁住「跑测试的那条路线下原生模块可用」这个前提 ——
//   将来谁再把 pretest 换回 `npm rebuild better-sqlite3`,或让 CI 换回
//   裸 `npx vitest run`,这条会以「模块加载失败 + 该用哪条命令」的形式立刻
//   暴露,而不是变成一堆莫名其妙的 SQLITE_CANTOPEN。
//
// 兼容性:两条路线下本用例都应通过 ——
//   - 系统 Node 路线:模块是 Node ABI 版(或 napi 通用版),直接可加载
//   - Electron 路线:模块是 Electron ABI 版,Electron 自带 Node 可加载
import { describe, expect, it } from 'vitest';

interface TestDb {
  exec(sql: string): void;
  close(): void;
  prepare(sql: string): {
    run(...args: unknown[]): { changes: number };
    get(...args: unknown[]): unknown;
  };
  pragma(sql: string): unknown;
}

type DatabaseCtor = new (path: string) => TestDb;

const ABI_HINT = [
  '[native-module] 当前测试运行器加载不了 better-sqlite3 原生模块。',
  '  better-sqlite3 不是 N-API,一个 .node 只对应一个 ABI(Electron / 系统 Node 各一份),',
  '  两份共用 node_modules/better-sqlite3/build/Release/better_sqlite3.node。',
  '  请用 `npm run test:run` —— scripts/run-tests.cjs 会自动挑能加载的那条路线',
  '  (系统 Node 直跑,或 Electron 自带 Node 跑 ELECTRON_RUN_AS_NODE=1);',
  '  裸 `npx vitest run` 会用系统 Node,而此刻那份 .node 可能是 Electron ABI 的。',
].join('\n');

/**
 * 打开内存库。注意:**原生 binding 是构造时才加载的**(require 只是拿到
 * JS 包装),所以 import 成功不代表 ABI 匹配 —— 必须在 new Database() 外面
 * 兜 try/catch,否则报的是难懂的 "NODE_MODULE_VERSION 123 vs 137"。
 */
async function openMemoryDb(): Promise<TestDb> {
  let ctor: DatabaseCtor | undefined;
  try {
    const mod = (await import('better-sqlite3')) as unknown as { default: DatabaseCtor };
    ctor = mod.default;
    return new ctor(':memory:');
  } catch (err) {
    expect.fail(
      `${ABI_HINT}\n  原始错误:${err instanceof Error ? err.message : String(err)}`,
    );
    throw err; // eslint-disable-line no-unreachable -- expect.fail 已抛,仅为满足类型
  }
}

describe('better-sqlite3 原生模块', () => {
  it('能打开内存库、建表、写入并读回', async () => {
    const db = await openMemoryDb();
    try {
      db.exec('create table t (a integer primary key, b text not null)');
      const ins = db.prepare('insert into t (b) values (?)');
      const res = ins.run('hello');
      expect(res.changes).toBe(1);
      const row = db.prepare('select a, b from t where a = ?').get(1) as {
        a: number;
        b: string;
      };
      expect(row).toEqual({ a: 1, b: 'hello' });
    } finally {
      db.close();
    }
  });

  it('pragma 可用(主进程依赖 journal_mode / foreign_keys 的行为)', async () => {
    const db = await openMemoryDb();
    try {
      // journal_mode 在内存库上恒为 memory,这里只断言 pragma 调用本身可用
      expect(() => db.pragma('journal_mode')).not.toThrow();
      expect(() => db.pragma('foreign_keys = ON')).not.toThrow();
      const fk = db.pragma('foreign_keys') as Array<{ foreign_keys: number }>;
      expect(fk[0]?.foreign_keys).toBe(1);
    } finally {
      db.close();
    }
  });
});
