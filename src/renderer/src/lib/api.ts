// window.api 类型声明 + 包装
import type { IpcErrorCode, IpcResult } from '@shared/types';
// audit v2.0 Phase 0a (2026-09-17):Api interface 单一真相源在
//   src/shared/api-types.ts(preload + renderer + tests 三方共用)。
//   原手抄的 ~90 行 interface 是 drift 源(preload 加方法时 renderer 不会同步,
//   调用方拿到 undefined)。preload 用 `const api: Api = {...}` 强制对齐,
//   新增/删 method 时 TS 编译期报红。
import type { Api } from '@shared/api-types';

// 这里 re-export 是为了不破坏既有 `import type { Api } from '../lib/api'`
//   的 7+ 处调用方(type-only,无运行时副作用)。
export type { Api, IpcResult };

/**
 * 渲染层捕获的 IPC 错误 — 比裸 Error 多携带主进程透传的诊断字段:
 *   - code:    主进程 AppError.code(INTERNAL / VALIDATION / LIBRARY_* ...)
 *   - size:    LibraryError.TOO_LARGE 时文件实际字节数
 *   - field:   ValidationError 时出错的字段 label(用于 UI 高亮对应输入项)
 *
 * audit round 18 (2026-08-27):之前的 unwrap 只抛 `new Error(r.message)`,
 * SettingsPage 无法区分错误类型。现在 throw IpcError,UI 可以 `instanceof IpcError`
 * 后读 .code 做差异化提示;普通 Error 路径仍兼容(`.message` 与原 Error 一致)。
 *
 * audit v2.0 Phase 0c (2026-09-17):`code` 收窄到 IpcErrorCode union,
 *   编译期穷尽性检查 —— typo 'DUPLICATE_NAMES' 会立即报红。wire 边界
 *   已在 wrap.ts:handle() 用 isIpcErrorCode 校验,不会泄漏非 union code。
 */
// audit-r140:删 `status` / `body` 字段 —— wire 侧 wrap.ts mapErrorToEnvelope
//   从未设过这俩字段(0 producer),renderer 也无 reader。shared/types.ts
//   的 IpcResult 同款字段一并删,让 IpcError shape 与 wire 实际形状 1:1。
export class IpcError extends Error {
  readonly code: IpcErrorCode;
  readonly size?: number;
  readonly field?: string;

  constructor(payload: Extract<IpcResult<unknown>, { ok: false }>) {
    super(payload.message);
    this.name = 'IpcError';
    this.code = payload.code;
    if (payload.size !== undefined) this.size = payload.size;
    if (payload.field !== undefined) this.field = payload.field;
  }
}

export function unwrap<T>(r: IpcResult<T>): T {
  if (r.ok) return r.data;
  throw new IpcError(r);
}

/**
 * audit-r161 (2026-10-19):把 preload 透传的 wrapped Error / IpcError / plain
 *   object 统一还原成 IpcError 实例。preload invokeGuard reject 时 wrapped
 *   Error 跨 contextBridge 被结构化克隆成 plain object — `instanceof IpcError`
 *   永远 false(electron 不会重建 Error prototype)。本 helper 让上层 catch
 *   入口重建 IpcError 实例,`instanceof IpcError` + 读 .code/.field/.size
 *   走差异化提示恢复生效。基线 consumer:settings.ts 4 处 catch。
 */
export function asIpcError(err: unknown): IpcError | null {
  if (err instanceof IpcError) return err;
  if (err && typeof err === 'object') {
    const o = err as Record<string, unknown>;
    if (o['name'] === 'IpcError' && typeof o['code'] === 'string') {
      const message = typeof o['message'] === 'string' ? o['message'] : '';
      const field = typeof o['field'] === 'string' ? (o['field'] as string) : undefined;
      const size = typeof o['size'] === 'number' ? (o['size'] as number) : undefined;
      const code = o['code'] as IpcErrorCode;
      return new IpcError({
        ok: false,
        code,
        message,
        ...(field !== undefined ? { field } : {}),
        ...(size !== undefined ? { size } : {}),
      });
    }
  }
  return null;
}

declare global {
  interface Window {
    api: Api;
    // audit-r145b (2026-10-19):HMR listener-leak 守卫 sentinel —
    //   main.tsx 顶层 addEventListener('error'/'unhandledrejection') 在
    //   Vite HMR 每次 reload 重求值,挂 window 上保证跨 reload 持久。
    __rkmsRendererGlobalErrorBound?: boolean;
  }
}

// audit C3R6 (2026-08-22):`export const api = window.api` 是 module-load-time
// 快照,store 模块第一次 import 时把当前 api 对象引用固定下来。后续测试在
// beforeEach 里 `window.api = { ...new vi.fn()... }` 替换整个对象时,store
// 持有的还是旧引用,导致测试的 mockResolvedValueOnce 永远命中错对象,
// store 调用拿到默认 mock 的 `{ok:false, message:'unused'}`,unwrap 抛 'unused'。
//
// 修复:api 用 Proxy 转发到 window.api 实时读取。每次 `api.foo` 都从
// window.api 当前值取。在生产(preload 一次性注入)零开销;在测试里
// 替换 window.api 后,store 立即看到新 mock。
//
// 这也是 tests/setup.ts 的 Proxy 兜底能正确工作的原因(但只对"未替换
// window.api"的子集生效)。
export const api: Api = new Proxy({} as Api, {
  get(_target, prop) {
    // 防御:window.api 在 Vite HMR / 启动期 race 时可能尚未注入。
    // 之前直接 `window.api[prop]` 会抛 "Cannot read properties of undefined",
    // 上游调用方(例如 TitleBar 模块顶层 `api.platform === 'darwin'`)整个模块崩溃。
    // 这里返回 undefined —— 调用方拿到 undefined 时应自行降级;事件订阅返回 undefined
    // 时,cleanup 必须 typeof === 'function' 才调用,否则会再抛 "off is not a function"。
    const w = typeof window !== 'undefined' ? window.api : undefined;
    if (!w) return undefined;
    return (w as unknown as Record<PropertyKey, unknown>)[prop];
  },
});

/**
 * api 是否暴露某个 method(订阅 / invoke 通用) ——
 *   - 测试环境 mock api 可能不全
 *   - 启动 race / 外部浏览器打开 vite dev server 时 window.api 整个未注入,
 *     Proxy.get 返回 undefined,直接调用会抛同步 TypeError(catch 兜不到)。
 *
 * 用于 useEffect 内每个 IPC 调用的守卫前一行,
 * 避免 "is not a function" 抛到 React commit 阶段把整棵子树打挂。
 */
export function hasApi(method: keyof Api): boolean {
  return typeof window !== 'undefined' && !!window.api && typeof api[method] === 'function';
}
