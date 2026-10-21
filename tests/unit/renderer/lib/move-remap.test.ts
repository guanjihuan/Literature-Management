// tests/unit/renderer/lib/move-remap.test.ts
//
// 守卫(r175):lib/move-remap.ts —— 搬移后 id 重映射的两个纯函数。
//
// 这是 notes / literature 两域**共用**的一份实现(此前两个 store 各写
// 一份字节级相同的循环)。纯函数、无副作用 → 单测不必起 React 渲染,
// 直接测输入输出。
//
// 契约:
//   remapSelectedIds  —— 只换落在映射里的成员,其余原样;未命中返回 null
//   remapSelectedId   —— 单数选中态换 id;没命中返回 null
//
// r177:landedIdsAfterMove 已随「导入后不自动打开」退役(唯一生产调用方
//   是 NotesList.importFiles 的自动选中)。
import { describe, expect, it } from 'vitest';
import {
  remapSelectedId,
  remapSelectedIds,
  type MoveRemap,
} from '../../../../src/renderer/src/lib/move-remap';

function remap(pairs: Array<[string, string]>): MoveRemap {
  const m: MoveRemap = new Map();
  for (const [oldId, newId] of pairs) m.set(oldId, { id: newId });
  return m;
}

describe('move-remap 纯函数(r175)', () => {
  it('remapSelectedIds:命中成员换新 id,未命中的原样保留', () => {
    const sel = new Set(['a', 'b', 'z']);
    const next = remapSelectedIds(sel, remap([['a', 'a2'], ['b', 'b2']]));
    expect(next).not.toBeNull();
    expect([...(next as Set<string>)].sort()).toEqual(['a2', 'b2', 'z']);
    // 入参不能被就地改
    expect([...sel].sort()).toEqual(['a', 'b', 'z']);
  });

  it('remapSelectedIds:没有命中时返回 null(调用方据此跳过 setState)', () => {
    expect(remapSelectedIds(new Set(['x']), remap([['a', 'a2']]))).toBeNull();
  });

  it('remapSelectedIds:映射表为空时返回 null', () => {
    expect(remapSelectedIds(new Set(['a']), new Map())).toBeNull();
  });

  it('remapSelectedId:命中返回新 id,未命中 / 空值返回 null', () => {
    expect(remapSelectedId('a', remap([['a', 'a2']]))).toBe('a2');
    expect(remapSelectedId('b', remap([['a', 'a2']]))).toBeNull();
    expect(remapSelectedId(null, remap([['a', 'a2']]))).toBeNull();
  });
});
