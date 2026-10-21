// tests/unit/renderer/lib/toast-duration-contract.test.ts
//
// 守 audit r252:toast 的**自动消失时长**不得被「带着 key 的 undefined」
// 打穿(否则 toast 0 毫秒闪没,用户根本来不及看)。
//
// 旧实现的坑(实测复现):
//   store 里 `{ id: newId(), duration: DEFAULT_DURATION[t.type], ...t }`
//   —— `...t` 排在**后面** ⇒ 只要调用方**带着 duration 这个 key**(哪怕值是
//   undefined),默认值就被覆盖成 undefined。
//   而 IPC 那条路恰好如此:ToastPushPayload.duration 是**可选**字段 →
//   preload 守卫放行 undefined → renderer 侧再写一遍
//   `duration: payload.duration`(key 存在、值 undefined)
//   ⇒ ToastItem 里 `toast.duration <= 0` 对 undefined 求值为 false(不早退)
//   ⇒ `setTimeout(dismiss, undefined)` ≈ 0ms ⇒ **toast 一闪就没**。
//
// 本测锁三条:
//   1. 不传 duration ⇒ 走该类型的默认时长;
//   2. 传 `duration: undefined`(key 在!)⇒ **仍**走默认时长(本轮的 bug);
//   3. 传 `duration: 0` ⇒ 保持 0(「不自动消失」的合法值,不能用 `||` 兜底)。
import { describe, expect, it, beforeEach } from 'vitest';
import { useToast } from '../../../../src/renderer/src/lib/toast';

describe('toast 时长契约(r252)', () => {
  beforeEach(() => {
    useToast.setState({ toasts: [] });
  });

  it('不传 duration ⇒ 走该类型的默认时长', () => {
    useToast.getState().show({ type: 'error', message: 'm' });
    useToast.getState().show({ type: 'info', message: 'm' });
    const [err, info] = useToast.getState().toasts;
    expect(err?.duration).toBe(6000);
    expect(info?.duration).toBe(3500);
  });

  it('传 duration: undefined(key 在!)⇒ 默认时长必须存活(旧实现这里被覆盖成 undefined)', () => {
    // 这就是 IPC 那条路:payload.duration 可选 ⇒ undefined ⇒ key 存在。
    const payload: { type: 'error'; message: string; duration?: number } = {
      type: 'error',
      message: '打开失败',
      duration: undefined,
    };
    useToast.getState().show(payload);
    const t = useToast.getState().toasts[0];
    expect(t?.duration, '默认时长不得被 undefined 打穿(否则 toast 0ms 闪没)').toBe(6000);
  });

  it('显式 duration 生效;duration=0 表示「不自动消失」,必须原样保留', () => {
    useToast.getState().show({ type: 'info', message: 'm', duration: 1234 });
    useToast.getState().show({ type: 'info', message: 'm', duration: 0 });
    const [a, b] = useToast.getState().toasts;
    expect(a?.duration).toBe(1234);
    expect(b?.duration, '0 是合法值(不自动消失)⇒ 不能用 || 兜底成默认值').toBe(0);
  });
});
