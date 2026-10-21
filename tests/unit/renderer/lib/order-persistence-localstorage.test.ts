// tests/unit/renderer/lib/order-persistence-localstorage.test.ts
//
// 守 order-persistence.ts 的「永不抛」契约(2026-10-20,r197)。
//
// store/notes.ts + store/literature.ts 的初始 state 里有
// `displayOrderById: loadOrder('note')` —— **模块 init 时**就调 loadOrder。
// 旧实现的 `typeof localStorage === 'undefined'` 探测在 try/catch **外面**:
//
//   - Chromium 对不透明 origin(file:// / 隐私模式 / 站点数据被禁)访问
//     localStorage 会抛 SecurityError,而 `typeof` 只挡 ReferenceError,
//     **不挡 getter 抛异常** → 探测本身就炸。
//   - localStorage.getItem 也在 try/catch 外面 → quota / 禁用 → 同样炸。
//
// 后果不是「排序没保存」这种小痛:store 模块 init 抛 ⇒ 整个 store 模块
// 加载失败 ⇒ 整个侧栏/列表白屏,且用户完全不知道原因。
//
// store 里的注释已经写着「任何 throw 都被 loadOrder 内部防御吞掉,返回 {}
// 兜底」—— 那条不变式此前**代码并没有兑现**。本测把注释变成可执行契约。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadOrder, saveOrder } from '../../../../src/renderer/src/lib/order-persistence';

type G = { localStorage?: Storage };

function setLocalStorage(value: unknown): void {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      return value;
    },
  });
}

describe('order-persistence localStorage 不可用(r197)', () => {
  let original: PropertyDescriptor | undefined;

  beforeEach(() => {
    original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  });

  afterEach(() => {
    if (original) {
      Object.defineProperty(globalThis, 'localStorage', original);
    } else {
      Reflect.deleteProperty(globalThis as G, 'localStorage');
    }
  });

  it('访问 localStorage 本身抛异常 → loadOrder 返 {} 不抛', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError: localStorage is disabled');
      },
    });
    expect(() => loadOrder('note')).not.toThrow();
    expect(loadOrder('note')).toEqual({});
  });

  it('访问 localStorage 本身抛异常 → saveOrder 不抛', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError: localStorage is disabled');
      },
    });
    expect(() => saveOrder('note', { a: 1 })).not.toThrow();
  });

  it('getItem 抛异常(配额/禁用)→ loadOrder 返 {} 不抛', () => {
    setLocalStorage({
      getItem: () => {
        throw new Error('quota exceeded');
      },
      setItem: () => {
        throw new Error('quota exceeded');
      },
    } as unknown as Storage);
    expect(() => loadOrder('literature')).not.toThrow();
    expect(loadOrder('literature')).toEqual({});
  });

  it('setItem 抛异常 → saveOrder 静默吞掉', () => {
    setLocalStorage({
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
    } as unknown as Storage);
    expect(() => saveOrder('note', { a: 1 })).not.toThrow();
  });

  it('localStorage 完全不存在 → 仍返 {} / 不抛', () => {
    Reflect.deleteProperty(globalThis as G, 'localStorage');
    expect(loadOrder('note')).toEqual({});
    expect(() => saveOrder('note', { a: 1 })).not.toThrow();
  });

  it('正常路径不变:读回写进去的排序', () => {
    const store = new Map<string, string>();
    setLocalStorage({
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    } as unknown as Storage);
    saveOrder('note', { 'n1': 1, 'n2': 2 });
    expect(loadOrder('note')).toEqual({ n1: 1, n2: 2 });
  });
});
