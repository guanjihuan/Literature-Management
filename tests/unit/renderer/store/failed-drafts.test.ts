// tests/unit/renderer/store/failed-drafts.test.ts
//
// 守卫(r206,2026-10-20):笔记保存失败时的草稿缓冲(store/failed-drafts.ts)。
//
// 为什么值得锁:这个 Map 是**用户丢字前的最后一道保险** —— 保存失败
// (CONFLICT / IPC 断 / 磁盘满)时把 body/title 快照进来,用户重开面板时
// 还能捞回来。静默丢字是这类应用最不可接受的故障,且**不会报错**
// (失败路径本来就静默)。
//
// 两条硬不变式:
//   ① **模块级单例**(不是 ref):ref 随组件 unmount 消失,而「关面板 →
//      重开」正是最需要草稿活着的场景;组件级持有还会形成
//      store/notes → components/StandaloneNoteEditorCore → store/notes 的
//      循环依赖(r35 就是为这个把它抽到零依赖叶子模块的)。
//   ② **零 import**:本文件不许 import 任何东西 —— 一旦 import 了
//      store/ 之类的东西,循环依赖就可能重新长回来(而 layering 守卫只管
//      进程边界,管不到 renderer 内部)。这是 r206 加的**结构守卫**。
import { readFileSync } from 'fs';
import { join } from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearFailedDraft,
  getFailedDraft,
  putFailedDraft,
} from '@renderer/store/failed-drafts';

const SRC = join(process.cwd(), 'src/renderer/src/store/failed-drafts.ts');

describe('failed-drafts(r206)', () => {
  beforeEach(() => {
    // 清理上一例残留(模块级 Map 跨用例存活)
    for (const id of ['a', 'b', 'c']) clearFailedDraft(id);
  });

  it('put 之后 get 得到同一个草稿', () => {
    putFailedDraft('a', { body: 'body-1', title: 'title-1' });
    expect(getFailedDraft('a')).toEqual({ body: 'body-1', title: 'title-1' });
  });

  it('get 未暂存的 id → undefined', () => {
    expect(getFailedDraft('never-put')).toBeUndefined();
  });

  it('同一 id 重复 put 覆盖旧值(不追加、不排队)', () => {
    putFailedDraft('a', { body: 'old', title: 'old' });
    putFailedDraft('a', { body: 'new', title: 'new' });
    expect(getFailedDraft('a')).toEqual({ body: 'new', title: 'new' });
  });

  it('不同 id 各自独立', () => {
    putFailedDraft('a', { body: 'A', title: 'A' });
    putFailedDraft('b', { body: 'B', title: 'B' });
    expect(getFailedDraft('a')?.body).toBe('A');
    expect(getFailedDraft('b')?.body).toBe('B');
  });

  it('clear 之后 get → undefined', () => {
    putFailedDraft('a', { body: 'x', title: 'y' });
    clearFailedDraft('a');
    expect(getFailedDraft('a')).toBeUndefined();
  });

  it('clear 未暂存的 id 不抛(幂等)', () => {
    expect(() => clearFailedDraft('never-put')).not.toThrow();
  });

  it('空字符串 body / title 也照常存取(不因 falsy 被吞)', () => {
    putFailedDraft('a', { body: '', title: '' });
    expect(getFailedDraft('a')).toEqual({ body: '', title: '' });
  });

  it('草稿是**同一个对象引用**(不被悄悄拷贝/规范化)', () => {
    const draft = { body: 'B', title: 'T' };
    putFailedDraft('a', draft);
    expect(getFailedDraft('a')).toBe(draft);
  });

  it('模块级单例:重复 import 拿到同一份 Map', async () => {
    const again = await import('@renderer/store/failed-drafts');
    putFailedDraft('c', { body: 'C', title: 'C' });
    expect(again.getFailedDraft('c')).toEqual({ body: 'C', title: 'C' });
  });

  it('结构不变式:本文件零 import(不许长回循环依赖)', () => {
    const src = readFileSync(SRC, 'utf8');
    // 去掉注释行再找 import —— 注释里提到 import 是允许的
    const code = src
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .join('\n');
    const imports = code.match(/^\s*import\s.*$/gm) ?? [];
    expect(imports, `failed-drafts.ts 不许有 import(现状):\n${imports.join('\n')}`).toEqual([]);
  });
});
