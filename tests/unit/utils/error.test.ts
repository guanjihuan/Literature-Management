// tests/unit/utils/error.test.ts
//
// 守 main/utils/error.ts 的「翻译官」契约(2026-10-20,r201):
//
//   1. 所有 helper **永不 throw** —— 它们跑在 catch 块里,自己炸了等于把
//      真实故障升级成 unhandledRejection(src/main/index.ts 的全局网会
//      unhandledRejection → showFatalDialog + app.quit())。用户看不到真错,
//      反而暴露 helper 自己的 bug。
//   2. errPayload.message 永远是 string(回归 C3R52:曾经直接透传 err.message,
//      而 message 为 undefined 的 Error 会让下游 toast 渲染出 "undefined")。
//   3. AppError / LibraryError / ValidationError 的 code / cause / name 形状 ——
//      wrap.ts 按 code 选错误通道,name 出现在结构化日志里。
//
// 同族另有两条专用测(拆分理由:源文件注释里三处 🔒 指针各指一个文件):
//   errnoCode     → tests/unit/main/utils/errno-code.test.ts
//   errPayloadStr → tests/unit/main/utils/error-payload-str.test.ts
import { describe, expect, it } from 'vitest';

import {
  AppError,
  LibraryError,
  ValidationError,
  errMsg,
  errPayload,
  toDisplayString,
} from '../../../src/main/utils/error';

describe('toDisplayString — 永不 throw 的显示态转换(r201)', () => {
  it('原始值按 String() 语义转换', () => {
    expect(toDisplayString('abc')).toBe('abc');
    expect(toDisplayString(42)).toBe('42');
    expect(toDisplayString(null)).toBe('null');
    expect(toDisplayString(undefined)).toBe('undefined');
    expect(toDisplayString(Symbol('s'))).toBe('Symbol(s)');
  });

  it('普通对象 → [object Object]', () => {
    expect(toDisplayString({})).toBe('[object Object]');
    expect(toDisplayString({ a: 1 })).toBe('[object Object]');
  });

  it('null-proto 对象:String() 本会抛 → 降级到 [object Object]', () => {
    // String(Object.create(null)) 在 V8 直接 TypeError(缺 toString/valueOf)
    const nullProto = Object.create(null) as Record<string, unknown>;
    expect(() => String(nullProto)).toThrow();
    expect(toDisplayString(nullProto)).toBe('[object Object]');
  });

  it('throwing toString/valueOf 的对象 → 降级到 [object Object]', () => {
    const hostile = {
      toString() {
        throw new Error('nope');
      },
      valueOf() {
        throw new Error('nope');
      },
    };
    expect(toDisplayString(hostile)).toBe('[object Object]');
  });

  it('连 Object.prototype.toString 都抛的 Proxy → [unstringifiable error]', () => {
    // 两档降级都失效时的最终常量兜底:保证日志里有一行可读的文本,
    // 而不是让 helper 自己炸掉。
    const evil = new Proxy(
      {},
      {
        get(_t, p) {
          if (p === Symbol.toStringTag) throw new Error('boom');
          return undefined;
        },
      },
    );
    expect(toDisplayString(evil)).toBe('[unstringifiable error]');
  });
});

describe('errMsg — 人类可读消息(r201)', () => {
  it('Error → err.message', () => {
    expect(errMsg(new Error('boom'))).toBe('boom');
  });

  it('字符串原样返回', () => {
    expect(errMsg('plain')).toBe('plain');
  });

  it('null / undefined → 对应字面量,永不为 undefined', () => {
    expect(errMsg(null)).toBe('null');
    expect(errMsg(undefined)).toBe('undefined');
  });

  it('普通对象 → [object Object]', () => {
    expect(errMsg({})).toBe('[object Object]');
  });

  it('null-proto 对象不炸', () => {
    expect(() => errMsg(Object.create(null))).not.toThrow();
    expect(errMsg(Object.create(null))).toBe('[object Object]');
  });
});

describe('errPayload — 结构化日志载荷(r201)', () => {
  it('Error 带 stack → { message, stack }', () => {
    const e = new Error('boom');
    const p = errPayload(e);
    expect(p.message).toBe('boom');
    expect(p.stack).toBe(e.stack);
  });

  it('Error 无 stack → 只有 message,且**不带** stack 键', () => {
    const e = new Error('boom');
    Object.defineProperty(e, 'stack', { value: undefined, configurable: true });
    const p = errPayload(e);
    expect(p.message).toBe('boom');
    expect('stack' in p).toBe(false);
  });

  it('非 Error → { message: String(err) },且永远不带 stack 键', () => {
    expect(errPayload('str')).toEqual({ message: 'str' });
    expect(errPayload(null)).toEqual({ message: 'null' });
    expect('stack' in errPayload({})).toBe(false);
  });

  it('REGRESSION (C3R52):message 永远是 string,从不 undefined', () => {
    // 空 message 的 Error.message 是 '' 而不是 undefined —— 两者在 toast
    // 渲染里表现完全不同(空白 vs "undefined")。
    const p = errPayload(new Error(''));
    expect(typeof p.message).toBe('string');
    expect(p.message).toBe('');
  });

  it('cause 链被完整展开(每层都有 message)', () => {
    const a = new Error('A');
    const b = new Error('B', { cause: a });
    const c = new Error('C', { cause: b });
    const p = errPayload(c);
    expect(p.message).toBe('C');
    expect(p.cause?.message).toBe('B');
    expect(p.cause?.cause?.message).toBe('A');
    expect(p.cause?.cause?.cause).toBeUndefined();
  });

  it('cause === null / undefined → 不产出 cause 节点(无 "Caused by: null" 噪音)', () => {
    const e = new Error('x', { cause: null });
    expect(errPayload(e).cause).toBeUndefined();
  });

  it('cause 环引用 → 终止而非栈溢出', () => {
    const e = new Error('loop') as Error & { cause?: unknown };
    e.cause = e;
    expect(() => errPayload(e)).not.toThrow();
    expect(errPayload(e).message).toBe('loop');
  });
});

describe('AppError / LibraryError / ValidationError(r201)', () => {
  it('AppError:code + message + name', () => {
    const e = new AppError('MY_CODE', 'msg');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('MY_CODE');
    expect(e.message).toBe('msg');
    expect(e.name).toBe('AppError');
  });

  it('AppError:cause 透传到标准 Error.cause(IPC structured-clone 之前就可见)', () => {
    const cause = new Error('root');
    const e = new AppError('MY_CODE', 'msg', cause);
    expect(e.cause).toBe(cause);
  });

  it('AppError:cause 缺省 → cause 为 undefined(不挂 undefined 键)', () => {
    const e = new AppError('MY_CODE', 'msg');
    expect(e.cause).toBeUndefined();
  });

  it('LibraryError:code 在白名单内 + name + size', () => {
    const e = new LibraryError('IO_ERROR', 'io', undefined, 42);
    expect(e).toBeInstanceOf(AppError);
    expect(e.code).toBe('IO_ERROR');
    expect(e.name).toBe('LibraryError');
    expect(e.size).toBe(42);
  });

  it('ValidationError:code 恒为 VALIDATION + field 透传', () => {
    const e = new ValidationError('bad', 'title');
    expect(e).toBeInstanceOf(AppError);
    expect(e.code).toBe('VALIDATION');
    expect(e.field).toBe('title');
    expect(e.name).toBe('ValidationError');
  });
});
