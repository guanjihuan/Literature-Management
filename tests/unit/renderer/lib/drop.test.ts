// tests/unit/renderer/lib/drop.test.ts
//
// 守 src/renderer/src/lib/drop.ts 的三条契约(指针原在
// src/renderer/src/components/notes/NotesList.tsx 的「🔒(守卫缺失)」标记里,
// 本文件补齐后该标记已摘除 —— 见 tests/unit/main/lint/stale-test-reference.test.ts
// 的反向守卫:引用的测试已存在却还留着 🔒 标记 ⇒ 红)。
//
//   A. getDroppedFilePath —— 路径提取的**优先级**与「拿不到返空串」:
//        webUtils.getPathForFile 优先 > legacy File.path 兜底 > ''
//   B. collectDroppedPaths —— 顺序保留(与原 FileList 下标对得上)、过滤空串
//   C. classifyDroppedNotesFiles —— 笔记面板**三桶**分类:
//        paths / invalidTypeNames / noPathNames 严格互斥,
//        「看起来是 .md 但拿不到 OS 路径」必须**独立成桶**(不能被「非 .md」吞掉)
//
// 与既有 drop-bridge-missing.test.ts 的分工:那一份专门锁「桥缺失/桥抛异常」
// 的降级路径(不 mock api 模块);本文件锁**正常路径**下的语义与优先级。
// 两份都不 vi.mock api 模块 —— 直接改写 window.api,api Proxy 每次属性
// 读取实时取 window.api 当前值(见 src/renderer/src/lib/api.ts 头注)。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Api } from '@shared/api-types';

import {
  classifyDroppedNotesFiles,
  collectDroppedPaths,
  getDroppedFilePath,
} from '../../../../src/renderer/src/lib/drop';

const originalApi = (globalThis as { window?: Window }).window?.api;

/** 造一个只有 name(+ 可选 legacy path)的 File 替身。 */
function fakeFile(name: string, legacyPath?: string): File {
  const f = { name } as unknown as File;
  if (legacyPath !== undefined) {
    (f as unknown as { path?: string }).path = legacyPath;
  }
  return f;
}

/** 用 map 装一个 getPathForFile:命中返回路径,未命中返回 null。 */
function installBridge(paths: Record<string, string | null>): void {
  (globalThis as unknown as { window: { api: Api } }).window.api = {
    getPathForFile: (file: File) => paths[file.name] ?? null,
  } as unknown as Api;
}

beforeEach(() => {
  installBridge({});
});

afterEach(() => {
  (globalThis as unknown as { window: { api: Api } }).window.api = originalApi as Api;
});

describe('getDroppedFilePath 路径提取优先级', () => {
  it('优先用 webUtils.getPathForFile', () => {
    installBridge({ 'a.md': '/from/webutils/a.md' });
    const f = fakeFile('a.md', '/legacy/a.md');
    expect(getDroppedFilePath(f)).toBe('/from/webutils/a.md');
  });

  it('webUtils 返回空串 → 退回 legacy file.path', () => {
    installBridge({ 'a.md': '' });
    expect(getDroppedFilePath(fakeFile('a.md', '/legacy/a.md'))).toBe('/legacy/a.md');
  });

  it('webUtils 返回 null → 退回 legacy file.path', () => {
    installBridge({ 'a.md': null });
    expect(getDroppedFilePath(fakeFile('a.md', '/legacy/a.md'))).toBe('/legacy/a.md');
  });

  it('webUtils 桥缺失 → 退回 legacy file.path', () => {
    (globalThis as unknown as { window: { api: Api } }).window.api = {} as unknown as Api;
    expect(getDroppedFilePath(fakeFile('a.md', '/legacy/a.md'))).toBe('/legacy/a.md');
  });

  it('两路都拿不到 → 返空串(绝不抛,也绝不返回 undefined)', () => {
    expect(getDroppedFilePath(fakeFile('a.md'))).toBe('');
  });

  it('legacy path 是空串 → 同样视为拿不到', () => {
    expect(getDroppedFilePath(fakeFile('a.md', ''))).toBe('');
  });
});

describe('collectDroppedPaths 批量版', () => {
  it('顺序保留(与原 FileList 下标对得上)', () => {
    installBridge({
      'a.md': '/p/a.md',
      'b.md': '/p/b.md',
      'c.md': '/p/c.md',
    });
    const paths = collectDroppedPaths([fakeFile('a.md'), fakeFile('b.md'), fakeFile('c.md')]);
    expect(paths).toEqual(['/p/a.md', '/p/b.md', '/p/c.md']);
  });

  it('过滤掉拿不到路径的文件,其余顺序不变', () => {
    installBridge({ 'a.md': '/p/a.md', 'c.md': '/p/c.md' });
    const paths = collectDroppedPaths([fakeFile('a.md'), fakeFile('b.md'), fakeFile('c.md')]);
    expect(paths).toEqual(['/p/a.md', '/p/c.md']);
  });

  it('空数组 → 空数组', () => {
    expect(collectDroppedPaths([])).toEqual([]);
  });
});

describe('classifyDroppedNotesFiles 三桶分类', () => {
  it('.md → paths 桶', () => {
    installBridge({ 'a.md': '/p/a.md' });
    expect(classifyDroppedNotesFiles([fakeFile('a.md')])).toEqual({
      paths: ['/p/a.md'],
      invalidTypeNames: [],
      noPathNames: [],
    });
  });

  it('.markdown 也算合法后缀', () => {
    installBridge({ 'a.markdown': '/p/a.markdown' });
    expect(classifyDroppedNotesFiles([fakeFile('a.markdown')]).paths).toEqual(['/p/a.markdown']);
  });

  it('后缀大小写不敏感(.MD / .MarkDown 都算 .md)', () => {
    installBridge({ 'A.MD': '/p/A.MD', 'B.MarkDown': '/p/B.MarkDown' });
    const r = classifyDroppedNotesFiles([fakeFile('A.MD'), fakeFile('B.MarkDown')]);
    expect(r.paths).toEqual(['/p/A.MD', '/p/B.MarkDown']);
    expect(r.invalidTypeNames).toEqual([]);
    expect(r.noPathNames).toEqual([]);
  });

  it('非 .md/.markdown → invalidTypeNames 桶(不查路径)', () => {
    installBridge({ 'a.txt': '/p/a.txt' });
    const r = classifyDroppedNotesFiles([fakeFile('a.txt')]);
    expect(r.paths).toEqual([]);
    expect(r.invalidTypeNames).toEqual(['a.txt']);
    expect(r.noPathNames).toEqual([]);
  });

  it('.md 但拿不到 OS 路径 → noPathNames 桶(独立成桶,不被「非 .md」吞掉)', () => {
    installBridge({}); // 桥给不出路径
    const r = classifyDroppedNotesFiles([fakeFile('lost.md')]);
    expect(r.paths).toEqual([]);
    expect(r.invalidTypeNames).toEqual([]);
    expect(r.noPathNames).toEqual(['lost.md']);
  });

  it('三桶互斥:一个文件只落一个桶', () => {
    installBridge({ 'ok.md': '/p/ok.md' });
    const r = classifyDroppedNotesFiles([
      fakeFile('ok.md'),
      fakeFile('bad.txt'),
      fakeFile('lost.md'),
    ]);
    expect(r).toEqual({
      paths: ['/p/ok.md'],
      invalidTypeNames: ['bad.txt'],
      noPathNames: ['lost.md'],
    });
    // 三桶元素总数 = 输入文件数 ⇒ 无重复归属
    expect(r.paths.length + r.invalidTypeNames.length + r.noPathNames.length).toBe(3);
  });

  it('空输入 → 三桶全空', () => {
    expect(classifyDroppedNotesFiles([])).toEqual({
      paths: [],
      invalidTypeNames: [],
      noPathNames: [],
    });
  });

  it('空名字文件按「非 .md」处理(名字为空 ⇒ 不匹配 .md 后缀)', () => {
    // 源码里 `noPathNames.push(f.name || '')` 的 `|| ''` 是**防御性**兜底:
    // noPath 桶的前提是后缀已是 .md ⇒ 名字必然非空 ⇒ 该分支实际不可达。
    // 这里锁「空名字不落 noPath 桶」这一侧,免得哪天有人把兜底挪到
    // invalidType 桶导致 toast 渲染出空行。
    installBridge({});
    const r = classifyDroppedNotesFiles([fakeFile('')]);
    expect(r.noPathNames).toEqual([]);
    expect(r.invalidTypeNames).toEqual(['']);
  });
});
