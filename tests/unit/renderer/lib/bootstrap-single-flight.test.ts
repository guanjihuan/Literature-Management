// tests/unit/renderer/lib/bootstrap-single-flight.test.ts
//
// 守卫(r206,2026-10-20):bootstrap 的**单飞**(single-flight)契约。
//
// 起因(r85 recon):main.tsx 后台 IIFE 第一行发 bootstrap,App.tsx passive
// effect 又「幂等兜底」地看 usePathsStore.loaded 决定要不要再发 —— 但
// React passive effect flush(<16ms)永远早于 bootstrap IPC 往返(50-200ms),
// loaded 此刻必然还是 false,所以**每次冷启都并发两次 bootstrap IPC**
// (dev StrictMode 三次)。main.tsx 里那句「loaded 守卫保证不会跑 legacy
// fallback」是**不生效的假守卫**。
//
// 契约(本文件逐条钉):
//   - 并发调用命中同一 promise ⇒ 只发**一次** IPC;
//   - 成功结果(**含 ok:false 的合法回复**)被缓存 ⇒ 不重发 —— 与
//     main.tsx「失败后置 loaded=true」的「本轮启动尝试过」语义一致;
//   - rejection(桥未就绪 / IPC 抛)清缓存 ⇒ 瞬时 race 之后重调可再试
//     (这才是原注释「幂等兜底」想表达却没做到的行为);
//   - 桥缺失(api.bootstrap 不是函数)转成 **rejection** 而不是同步 throw
//     —— 符合 r83 契约(调用点带同线 typeof guard,Proxy 属性读安全)。
//
// 隔离手段:bootstrap.ts 的 inflight 是**模块级**变量 ⇒ 每例
// vi.resetModules() + 动态 import 拿全新模块实例。
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BootstrapPayload, IpcResult } from '@shared/types';

const OK_PAYLOAD = {
  settings: {} as BootstrapPayload['settings'],
  paths: {} as BootstrapPayload['paths'],
} as BootstrapPayload;

async function freshBootstrap() {
  vi.resetModules();
  return await import('@renderer/lib/bootstrap');
}

function setBridge(value: unknown): void {
  (window as unknown as { api?: unknown }).api = value;
}

afterEach(() => {
  setBridge(undefined);
  vi.restoreAllMocks();
});

describe('bootstrap 单飞(r206)', () => {
  it('并发调用只发一次 IPC', async () => {
    const mod = await freshBootstrap();
    const bootstrap = vi.fn().mockResolvedValue({ ok: true, data: OK_PAYLOAD } as IpcResult<BootstrapPayload>);
    setBridge({ bootstrap });

    const [a, b] = await Promise.all([mod.bootstrapOnce(), mod.bootstrapOnce()]);

    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(a).toBe(b); // 同一个 promise ⇒ 同一个结果对象
  });

  it('三个并发调用仍只发一次', async () => {
    const mod = await freshBootstrap();
    const bootstrap = vi.fn().mockResolvedValue({ ok: true, data: OK_PAYLOAD } as IpcResult<BootstrapPayload>);
    setBridge({ bootstrap });

    await Promise.all([mod.bootstrapOnce(), mod.bootstrapOnce(), mod.bootstrapOnce()]);

    expect(bootstrap).toHaveBeenCalledTimes(1);
  });

  it('成功结果被缓存:后续调用不再发 IPC', async () => {
    const mod = await freshBootstrap();
    const bootstrap = vi.fn().mockResolvedValue({ ok: true, data: OK_PAYLOAD } as IpcResult<BootstrapPayload>);
    setBridge({ bootstrap });

    await mod.bootstrapOnce();
    await mod.bootstrapOnce();

    expect(bootstrap).toHaveBeenCalledTimes(1);
  });

  it('ok:false 的合法回复也缓存(不重发)', async () => {
    const mod = await freshBootstrap();
    const bootstrap = vi
      .fn()
      .mockResolvedValue({ ok: false, code: 'INTERNAL', message: 'x' } as IpcResult<BootstrapPayload>);
    setBridge({ bootstrap });

    const first = await mod.bootstrapOnce();
    const second = await mod.bootstrapOnce();

    expect(bootstrap).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(first.ok).toBe(false);
  });

  it('rejection 清缓存:之后重调能再试(幂等兜底真的兜住了)', async () => {
    const mod = await freshBootstrap();
    const bootstrap = vi
      .fn()
      .mockRejectedValueOnce(new Error('bridge race'))
      .mockResolvedValueOnce({ ok: true, data: OK_PAYLOAD } as IpcResult<BootstrapPayload>);
    setBridge({ bootstrap });

    await expect(mod.bootstrapOnce()).rejects.toThrow('bridge race');
    const retry = await mod.bootstrapOnce();

    expect(bootstrap).toHaveBeenCalledTimes(2);
    expect(retry.ok).toBe(true);
  });

  it('桥缺失 ⇒ 返回 rejected promise(不是同步 throw)', async () => {
    const mod = await freshBootstrap();
    setBridge(undefined);

    // 同步 throw 会让调用点的 try/catch 之外代码炸掉;契约要求是 rejection。
    let promise: Promise<IpcResult<BootstrapPayload>> | null = null;
    expect(() => {
      promise = mod.bootstrapOnce();
    }).not.toThrow();
    await expect(promise!).rejects.toThrow(/bridge missing/);
  });

  it('桥在但方法不是函数 ⇒ 同样转成 rejection', async () => {
    const mod = await freshBootstrap();
    setBridge({ bootstrap: 'not-a-function' });

    await expect(mod.bootstrapOnce()).rejects.toThrow(/bridge missing/);
  });

  it('单飞是**跨调用**的:第二个 awaiter 拿到的还是第一次的结果', async () => {
    const mod = await freshBootstrap();
    const bootstrap = vi.fn().mockResolvedValue({ ok: true, data: OK_PAYLOAD } as IpcResult<BootstrapPayload>);
    setBridge({ bootstrap });

    const p1 = mod.bootstrapOnce();
    const p2 = mod.bootstrapOnce();
    expect(p1).toBe(p2); // 连 promise 引用都相同
    await p1;
    await p2;
    expect(bootstrap).toHaveBeenCalledTimes(1);
  });
});
