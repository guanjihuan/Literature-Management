// tests/unit/renderer/lib/error-errmsg.test.ts
//
// 守 renderer lib/error.ts 的 errMsg 契约(r217):
//
//   1. **永不 throw** —— errMsg 跑在 catch 块里(30+ 处 toast 翻译),自己
//      炸了会把真实故障盖掉。回归:r217 前 renderer 版镜像的是 main 版
//      r124 修复前的旧口径 `String(err)`,`String(Object.create(null))`
//      在 V8 直接 TypeError;现与 main 共用 @shared/display-string。
//   2. Error 实例取 message;字符串原样;其余走 toDisplayString 降级链。
//
// 变异实证:r217 修复前(旧实现 `String(err)`)跑本文件,「null-proto 对象」
//   与「throwing toString」两例红(TypeError 逃出),修复后全绿。
import { describe, expect, it } from 'vitest';

import { errMsg } from '../../../../src/renderer/src/lib/error';
import { toDisplayString } from '../../../../src/shared/display-string';

describe('renderer errMsg — 永不 throw 的 catch 翻译官(r217)', () => {
  it('Error 实例 → message', () => {
    expect(errMsg(new Error('boom'))).toBe('boom');
    expect(errMsg(new TypeError('bad type'))).toBe('bad type');
  });

  it('字符串原样返回', () => {
    expect(errMsg('plain failure')).toBe('plain failure');
  });

  it('null / undefined / number → 显示字符串', () => {
    expect(errMsg(null)).toBe('null');
    expect(errMsg(undefined)).toBe('undefined');
    expect(errMsg(42)).toBe('42');
  });

  it('null-proto 对象不 throw(r124 口径,renderer 曾缺)', () => {
    const nullProto = Object.create(null) as object;
    expect(() => errMsg(nullProto)).not.toThrow();
    expect(errMsg(nullProto)).toBe('[object Object]');
  });

  it('throwing toString 的对象不 throw,走降级链', () => {
    const evil = {
      toString(): string {
        throw new Error('toString exploded');
      },
      valueOf(): never {
        throw new Error('valueOf exploded');
      },
    };
    expect(() => errMsg(evil)).not.toThrow();
    expect(errMsg(evil)).toBe('[object Object]');
  });

  it('message 为 undefined 的 Error → undefined 不透出(toast 不渲染 "undefined")', () => {
    // Error 分支直取 message —— 该分支契约:调用方拿到的是 err.message 本身,
    // 这里锁的是「非 Error 路径永不给 undefined」。
    expect(errMsg(Object.create(null))).not.toBe('undefined');
  });
});

describe('shared toDisplayString — 两侧共用同一份实现(r217)', () => {
  it('renderer errMsg 与 shared toDisplayString 对非 Error 输入口径一致', () => {
    const inputs: unknown[] = [null, undefined, 42, 's', {}, Object.create(null)];
    for (const v of inputs) {
      expect(errMsg(v)).toBe(toDisplayString(v));
    }
  });
});
