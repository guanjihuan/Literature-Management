// tests/unit/main/utils/errno-code.test.ts
//
// 守 errnoCode 的收窄契约(2026-10-20,r201):
//
//   unknown → string | undefined,判据是**own property** 且值是 string。
//
// 为什么是 helper 而不是 inline `(err as { code?: unknown }).code`:
//   inline 让 code 保持 unknown,`code === 'ENOENT'` 在 number / Symbol / null
//   上都严格不等 —— 运行时行为其实**等价**,但契约不显式;helper 把
//   "不是 string 的 code 一律落 undefined"这条写成类型,读者不用再推。
//
// 本文件锁三条:
//   1. own string code → 原样返回;
//   2. 非 string code(number / null / undefined / Symbol / 对象)→ undefined;
//   3. **原型链上的 code 不算** —— 契约写的是 own property,`Object.prototype`
//      上挂一个 code 就让所有对象都"有 code"是经典事故。
//
// 同族:errPayloadStr → tests/unit/main/utils/error-payload-str.test.ts
//       error.ts 全量 → tests/unit/utils/error.test.ts
import { describe, expect, it } from 'vitest';

import { errnoCode } from '../../../../src/main/utils/error';

describe('errnoCode — own string code 收窄(r201)', () => {
  it('own string code → 原样返回', () => {
    expect(errnoCode({ code: 'ENOENT' })).toBe('ENOENT');
    expect(errnoCode({ code: 'EACCES' })).toBe('EACCES');
    expect(errnoCode({ code: '' })).toBe('');
  });

  it('own code 但不是 string → undefined', () => {
    expect(errnoCode({ code: 42 })).toBeUndefined();
    expect(errnoCode({ code: null })).toBeUndefined();
    expect(errnoCode({ code: undefined })).toBeUndefined();
    expect(errnoCode({ code: Symbol('E') })).toBeUndefined();
    expect(errnoCode({ code: { nested: true } })).toBeUndefined();
  });

  it('没有 code 字段 → undefined', () => {
    expect(errnoCode({})).toBeUndefined();
    expect(errnoCode({ errno: -2 })).toBeUndefined();
  });

  it('原型链上的 code → undefined(own property 收紧)', () => {
    // 契约写的是 own property。`Object.prototype.code` 一旦被挂上,
    // 用 `'code' in err` 判据会让**每一个**对象都"有 code"。
    const proto = { code: 'INHERITED' } as Record<string, unknown>;
    const child = Object.create(proto) as Record<string, unknown>;
    expect(errnoCode(child)).toBeUndefined();
    expect(errnoCode(Object.create({}) as Record<string, unknown>)).toBeUndefined();
  });

  it('null-proto 对象上的 own code 仍能被读到(hasOwnProperty.call 兼容)', () => {
    const np = Object.create(null) as Record<string, unknown>;
    np.code = 'ENOENT';
    expect(errnoCode(np)).toBe('ENOENT');
  });

  it('非对象(字符串 / 数字 / null / undefined / 布尔)→ undefined', () => {
    expect(errnoCode('ENOENT')).toBeUndefined();
    expect(errnoCode(42)).toBeUndefined();
    expect(errnoCode(null)).toBeUndefined();
    expect(errnoCode(undefined)).toBeUndefined();
    expect(errnoCode(true)).toBeUndefined();
  });

  it('NodeJS.ErrnoException 形态(真实 fs 错误)→ code 原样', () => {
    const e = new Error('ENOENT: no such file') as NodeJS.ErrnoException;
    e.code = 'ENOENT';
    expect(errnoCode(e)).toBe('ENOENT');
  });
});
