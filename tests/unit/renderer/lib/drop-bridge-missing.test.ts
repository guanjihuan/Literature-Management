// tests/unit/renderer/lib/drop-bridge-missing.test.ts
//
// 守 drop.ts 的降级契约(2026-10-20,r197):
//
//   「拿不到 OS 绝对路径就返 '' / 退回 f.path,绝不抛」。
//
// 桥缺失有两种形态,旧实现只挡了第一种:
//   ① 桥**不存在** → api Proxy.get 返 undefined → `api.getPathForFile(file)`
//      抛 TypeError(not a function)。r81 已 guard 住「属性读取」。
//   ② 桥**存在但调用抛异常**(preload 实现变化 / 测试替身 / 第三方注入)
//      → 异常一路逃出 getDroppedFilePath → 下面的 legacy f.path 兜底
//      永远走不到,整条 drop 流程炸掉。r197 补上这层。
//
// 不 mock api 模块:必须用真实 Proxy(旧 drop.test.ts 的 vi.mock 恰好绕开了
// 这条路径,才让缺口活到今天)。这里直接改写 window.api —— api Proxy 在
// 每次属性读取时实时取 window.api 的当前值。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Api } from '@shared/api-types';

import { getDroppedFilePath, collectDroppedPaths } from '../../../../src/renderer/src/lib/drop';

const originalApi = (globalThis as { window?: Window }).window?.api;

function fakeFile(name: string, legacyPath?: string): File {
  const f = { name } as unknown as File;
  if (legacyPath !== undefined) {
    (f as unknown as { path?: string }).path = legacyPath;
  }
  return f;
}

describe('getDroppedFilePath 桥异常降级(r197)', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: { api: Api } }).window.api = {
      getPathForFile: () => {
        throw new Error('bridge exploded');
      },
    } as unknown as Api;
  });

  afterEach(() => {
    (globalThis as unknown as { window: { api: Api } }).window.api = originalApi as Api;
  });

  it('桥调用抛异常时退回 legacy file.path(不抛)', () => {
    const f = fakeFile('note.md', '/legacy/note.md');
    expect(() => getDroppedFilePath(f)).not.toThrow();
    expect(getDroppedFilePath(f)).toBe('/legacy/note.md');
  });

  it('桥调用抛异常且无 legacy path → 返空串(跳过此 file)', () => {
    expect(getDroppedFilePath(fakeFile('note.md'))).toBe('');
  });

  it('桥方法缺失(属性是 undefined)→ 同样走 legacy 兜底', () => {
    (globalThis as unknown as { window: { api: Api } }).window.api = {} as unknown as Api;
    expect(getDroppedFilePath(fakeFile('note.md', '/legacy/note.md'))).toBe('/legacy/note.md');
    expect(getDroppedFilePath(fakeFile('note.md'))).toBe('');
  });

  it('collectDroppedPaths:整批降级不炸,空路径被过滤掉', () => {
    const files = [fakeFile('a.md', '/legacy/a.md'), fakeFile('b.md'), fakeFile('c.md', '/legacy/c.md')];
    expect(collectDroppedPaths(files)).toEqual(['/legacy/a.md', '/legacy/c.md']);
  });

  it('桥调用抛异常时,legacy path 优先于抛异常(顺序契约不变)', () => {
    // 主路径优先级:webUtils > f.path。桥异常时 webUtils 视为「拿不到」。
    const f = fakeFile('note.md', '/legacy/note.md');
    expect(getDroppedFilePath(f)).toBe('/legacy/note.md');
  });
});
