// tests/unit/main/utils/error-payload-str.test.ts
//
// 守 errPayloadStr 的单行日志契约(2026-10-20,r201):
//
//   unknown → string,永不 undefined、永不 throw。
//
// 它是 errPayload 的"字符串版",直接喂 log.error / IPC 错误消息。关键点:
//   1. Error 有 stack → "message\nstack";无 stack → 只有 message。
//   2. cause 链拼成 "…\nCaused by: …",让根因在日志里**可见**
//      (AppError / ValidationError 都用 { cause } 把根因传下去)。
//   3. cause 为 null / undefined → 不拼,避免 "Caused by: null" 噪音。
//   4. cause 环引用 → 截断成 '[Circular cause]',**不**无限递归。
//   5. 永不返回 undefined —— toast / dialog 渲染要稳定。
//
// 同族:errnoCode → tests/unit/main/utils/errno-code.test.ts
//       error.ts 全量 → tests/unit/utils/error.test.ts
import { describe, expect, it } from 'vitest';

import { errPayloadStr } from '../../../../src/main/utils/error';

describe('errPayloadStr — 单行日志串(r201)', () => {
  it('Error 带 stack → message + "\\n" + stack', () => {
    const e = new Error('boom');
    const s = errPayloadStr(e);
    expect(s).toBe(`boom\n${e.stack}`);
    expect(s.startsWith('boom\n')).toBe(true);
  });

  it('Error 无 stack → 只有 message', () => {
    const e = new Error('boom');
    Object.defineProperty(e, 'stack', { value: undefined, configurable: true });
    expect(errPayloadStr(e)).toBe('boom');
  });

  it('字符串原样返回', () => {
    expect(errPayloadStr('plain')).toBe('plain');
  });

  it('null / undefined → 字面量,永不 undefined', () => {
    expect(errPayloadStr(null)).toBe('null');
    expect(errPayloadStr(undefined)).toBe('undefined');
    expect(typeof errPayloadStr(new Error('x'))).toBe('string');
  });

  it('普通对象 → [object Object]', () => {
    expect(errPayloadStr({})).toBe('[object Object]');
  });

  it('null-proto 对象不炸(降级链兜住)', () => {
    expect(() => errPayloadStr(Object.create(null))).not.toThrow();
    expect(errPayloadStr(Object.create(null))).toBe('[object Object]');
  });

  it('cause 链被拼成 "Caused by:" 序列', () => {
    const a = new Error('A');
    const b = new Error('B', { cause: a });
    const c = new Error('C', { cause: b });
    const s = errPayloadStr(c);
    expect(s.startsWith('C\n')).toBe(true);
    expect(s).toContain('Caused by: B\n');
    expect(s).toContain('Caused by: A\n');
  });

  it('cause === null → 不拼 "Caused by: null"', () => {
    const e = new Error('x', { cause: null });
    expect(errPayloadStr(e)).not.toContain('Caused by');
  });

  it('cause 环引用 → 截断为 [Circular cause],不栈溢出', () => {
    const e = new Error('loop') as Error & { cause?: unknown };
    e.cause = e;
    let s = '';
    expect(() => {
      s = errPayloadStr(e);
    }).not.toThrow();
    expect(s).toContain('[Circular cause]');
  });

  it('互相引用的两节点环 → 同样终止', () => {
    const a = new Error('A') as Error & { cause?: unknown };
    const b = new Error('B', { cause: a });
    a.cause = b;
    let s = '';
    expect(() => {
      s = errPayloadStr(a);
    }).not.toThrow();
    expect(s).toContain('[Circular cause]');
  });
});
