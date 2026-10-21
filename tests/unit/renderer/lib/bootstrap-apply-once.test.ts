// tests/unit/renderer/lib/bootstrap-apply-once.test.ts
//
// 守卫(r206,2026-10-20):bootstrap 结果「应用且仅应用一次」的单点契约。
//
// 起因(r87):r85 的单飞修了「重复 IPC」,没修「重复应用」—— 两个 awaiter
// 拿到同一结果后**各自** applyBootstrapSettings + setState({paths,loaded})。
// pendingLayout 的消费在 applyPendingLayoutFallback 里
// `void api.updateSettings(...).then(removeItem)` —— key 清理是异步的,
// 同帧双 apply ⇒ 双 updateSettings 写(同值,LOW)。修:apply 收口到
// lib/bootstrap.ts 的 applyBootstrapOnce 单点。
//
// 契约三分支:
//   - r.ok 且尚未应用 → 'applied':applyBootstrapSettings + setState({paths, loaded:true});
//   - r.ok 但已应用(另一 continuation 先落地 / 测试直接置 loaded)
//     → 'already-applied':**零 store 写、零 IPC** —— 首落地值不被覆写;
//   - !r.ok → 'ipc-failed':**纯判定不碰 state**。调用方按各自职责处理
//     (main:log.warn + loaded=true 标记「本轮启动尝试过」;App:legacy
//     settings/paths pair 修复)。两个调用方都会拿到同一个 'ipc-failed',
//     修复只由 App 执行一次 —— 这是有意分工,不是守卫缺失。
//
// 隔离:本文件**不**用 vi.resetModules() —— applyBootstrapOnce 读写的
// paths store 是模块级 zustand 单例,resetModules 会造出**另一份**实例,
// 令「apply 写进去的 loaded」读不到(本轮第一版就踩了这个坑)。
// 改为每例显式 setState 复位 loaded。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BootstrapPayload, IpcResult } from '@shared/types';

const { applyBootstrapSettings } = vi.hoisted(() => ({ applyBootstrapSettings: vi.fn() }));
vi.mock('@renderer/store/settings', () => ({ applyBootstrapSettings }));

const PAYLOAD = {
  settings: { themePreset: 'default' } as unknown as BootstrapPayload['settings'],
  paths: { rootPath: '/tmp/x' } as unknown as BootstrapPayload['paths'],
} as BootstrapPayload;

const OK = { ok: true, data: PAYLOAD } as IpcResult<BootstrapPayload>;
const FAIL = { ok: false, code: 'INTERNAL', message: 'boom' } as IpcResult<BootstrapPayload>;

describe('bootstrap apply-once(r206)', () => {
  beforeEach(async () => {
    applyBootstrapSettings.mockReset();
    const { usePathsStore } = await import('@renderer/store/paths');
    usePathsStore.setState({ loaded: false, paths: null as never });
  });

  it('r.ok 且未加载 → applied,并写 settings + paths + loaded', async () => {
    const { applyBootstrapOnce } = await import('@renderer/lib/bootstrap');
    const { usePathsStore } = await import('@renderer/store/paths');

    const out = applyBootstrapOnce(OK);

    expect(out).toBe('applied');
    expect(applyBootstrapSettings).toHaveBeenCalledTimes(1);
    expect(applyBootstrapSettings).toHaveBeenCalledWith(PAYLOAD.settings);
    const st = usePathsStore.getState();
    expect(st.loaded).toBe(true);
    expect(st.paths).toEqual(PAYLOAD.paths);
  });

  it('已应用(loaded=true)→ already-applied,零 store 写', async () => {
    const { applyBootstrapOnce } = await import('@renderer/lib/bootstrap');
    const { usePathsStore } = await import('@renderer/store/paths');
    usePathsStore.setState({ loaded: true, paths: { rootPath: '/keep' } as never });

    const out = applyBootstrapOnce(OK);

    expect(out).toBe('already-applied');
    expect(applyBootstrapSettings).not.toHaveBeenCalled();
    // 首落地的值不被覆写
    expect(usePathsStore.getState().paths).toEqual({ rootPath: '/keep' });
  });

  it('!r.ok → ipc-failed,且**不碰 state**(loaded 仍为 false)', async () => {
    const { applyBootstrapOnce } = await import('@renderer/lib/bootstrap');
    const { usePathsStore } = await import('@renderer/store/paths');

    const out = applyBootstrapOnce(FAIL);

    expect(out).toBe('ipc-failed');
    expect(applyBootstrapSettings).not.toHaveBeenCalled();
    expect(usePathsStore.getState().loaded).toBe(false);
  });

  it('连续两次 apply 同一个结果:第二次是 already-applied(只写一次)', async () => {
    const { applyBootstrapOnce } = await import('@renderer/lib/bootstrap');

    expect(applyBootstrapOnce(OK)).toBe('applied');
    expect(applyBootstrapOnce(OK)).toBe('already-applied');
    expect(applyBootstrapSettings).toHaveBeenCalledTimes(1);
  });

  it('ipc-failed 不写 loaded —— 「本轮启动尝试过」由调用方自己置', async () => {
    // main.tsx 的语义是「失败也置 loaded=true」,但那是**调用方**的动作,
    // 不是 applyBootstrapOnce 的动作。本例锁住这个分工边界。
    const { applyBootstrapOnce } = await import('@renderer/lib/bootstrap');
    const { usePathsStore } = await import('@renderer/store/paths');

    applyBootstrapOnce(FAIL);

    expect(usePathsStore.getState().loaded).toBe(false);
  });
});
