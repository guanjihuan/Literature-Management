// src/main/utils/error.ts
//
// 集中以下五类 helper,供 main/ 全局 catch 块使用:
//   - toDisplayString(v) : unknown → string,永不 throw(errMsg 系共用底座)
//   - errMsg(err)        : unknown → string(人类可读消息)
//   - errPayload(err)    : unknown → { message, stack? }(结构化日志)
//   - errPayloadStr(err) : unknown → string(message + "\n" + stack 或 String(err))
//   - errnoCode(err)     : unknown → string | undefined(err.code 收窄)
//
// 这些 helper 在 audit C3R27 / C3R46 / C3R49 / C3R50 / C3R52 / C3R61 等
// 多个 round 集中提取,替换散落在 50+ catch 块里的 inline 重复:
//
//   - `err instanceof Error ? err.message : String(err)`        → errMsg(err)
//   - `(err as { code?: unknown }).code`                        → errnoCode(err)
//   - `err.message, err.stack` 直接访问(uncaughtException)       → errPayload(err)
//   - 4 处 `err instanceof Error ? \`${m}\n${s}\` : String(err)` → errPayloadStr(err)
//
// 关键 invariant:所有 helper 都必须**永不 throw** —— 它们是 catch 块里的"翻译官",
// 自身抛错会让用户看不到真错,反而暴露 helper bug。测试见:
//   tests/unit/utils/error.test.ts                  (AppError + toDisplayString + errMsg + errPayload)
//   tests/unit/main/utils/errno-code.test.ts        (errnoCode)
//   tests/unit/main/utils/error-payload-str.test.ts (errPayloadStr)

// audit-r217:toDisplayString 下沉到 @shared/display-string —— renderer
//   (lib/error.ts)此前镜像的是 r124 修复前的旧口径(String(null-proto) 会
//   throw),孪生实现修一边漏一边;现在两侧共用同一份实现。本文件保留
//   re-export,既有 import 路径(main/ 全域 + tests)不动。
import { toDisplayString } from '@shared/display-string';

export { toDisplayString };

/**
 * unknown err → string 的人类可读消息。
 * - Error 实例 → err.message
 * - 字符串 → 原样返回
 * - 其它 → toDisplayString(err)(null→'null', undefined→'undefined',
 *   对象→'[object Object]';null-proto / throwing toString 走降级链)
 *
 * 关键:永不 throw。
 * 测试见 tests/unit/utils/error.test.ts:errMsg describe block。
 *
 * audit-r229:实现已下沉到 @shared/display-string(renderer 侧此前是逐字
 *   孪生副本,改一边漏一边);本文件只保留 re-export,既有 import 路径不动。
 */
export { errMsg } from '@shared/display-string';

/**
 * errPayload 返回值类型:cause 链递归,每层都有 message 字段(永远 string)。
 * 用 type-only 定义让 errPayload / errPayloadImpl 共享同一份契约,
 * 测试侧 p.cause?.message / p.cause?.cause?.message 直接通过类型检查,
 * 不用每处 cast。
 */
export type ErrPayload = {
  message: string;
  stack?: string;
  cause?: ErrPayload;
};

/**
 * unknown err → { message: string, stack?: string },给结构化日志 / IPC 序列化用。
 *
 * - Error 实例 → { message, stack: err.stack }  (stack 可能 undefined,接受)
 * - 非 Error    → { message: String(err) }       (永远不返回 stack 字段)
 *
 * 与 errMsg 的区别:errPayload 返回结构化对象,便于 telemetry / Sentry 区分
 * message vs stack。errMsg 是一行字符串,适合 inline 到 toast。
 *
 * 关键 invariant:返回的 message **永远**是 string,从不 undefined(回归见
 * tests/unit/utils/error.test.ts:REGRESSION (C3R52) describe block)。
 */
export function errPayload(err: unknown): ErrPayload {
  return errPayloadImpl(err, new WeakSet());
}

// audit 2026-09-11:实现抽出 + WeakSet 循环检测 —— 同一个 Error 实例在 cause 链
//   中若被重复引用(典型场景:外部代码错把自身挂到 cause),递归会无限循环直到
//   stack overflow。helper 是 catch 块里的"翻译官",自己崩了用户看不到真错。
//   WeakSet 自动随外部引用消失,无清理负担。
function errPayloadImpl(err: unknown, seen: WeakSet<object>): ErrPayload {
  if (err instanceof Error) {
    const out: ErrPayload = err.stack
      ? { message: err.message, stack: err.stack }
      : { message: err.message };
    // audit 2026-09-07:带上 cause —— 标准 Error.prototype.cause(我们 AppError
    //   / ValidationError 都用 { cause } 传给 super())在 IPC 序列化
    //   (structured-clone)里被吞掉,renderer 侧只能看到 message + stack,
    //   链式失败根因不可见。手动序列化保证链路向下游透传。
    // audit 2026-09-10:递归展开整条 cause 链 —— 原实现只 unwrap 一层,深层
    //   Error C → cause B → cause A 在 telemetry / Sentry 上丢失中间节点;
    //   errPayloadStr 是递归的,errPayload 不递归会让两个 helper 对同一错
    //   给出形状不一致的结果。复用作 errPayload 自己,自然得到完整链路。
    // audit 2026-09-11:`!= null`(loose eq)同时跳过 null + undefined —— 原 `!==
    //   undefined` 让 cause=null 走到 String(null)='null',渲染成 "Caused by: null"
    //   噪音。
    if (err.cause != null && !seen.has(err)) {
      seen.add(err);
      out.cause = errPayloadImpl(err.cause, seen);
    }
    return out;
  }
  return { message: toDisplayString(err) };
}

/**
 * unknown err → 拼接好的单行字符串(message + "\n" + stack 或 String(err))。
 *
 * - Error 实例有 stack → `${message}\n${stack}`
 * - Error 实例无 stack → `${message}`
 * - 字符串 → 原样
 * - 其它 → toDisplayString(err)(object → '[object Object]', null → 'null';
 *   null-proto / throwing toString 走降级链,永不 throw)
 *
 * 与 errPayload 的区别:errPayloadStr 是日志/上报一行字符串版,直接喂 log.error;
 * errPayload 是结构化版,适合 telemetry / Sentry。
 *
 * 关键 invariant:永不返回 undefined,永不变 undefined(toast / dialog 渲染稳定)。
 * 测试见 tests/unit/main/utils/error-payload-str.test.ts。
 */
export function errPayloadStr(err: unknown): string {
  return errPayloadStrImpl(err, new WeakSet());
}

// audit 2026-09-11:实现抽出 + WeakSet 循环检测 —— 同 errPayload,防止 cause 链
//   互引时 stack overflow。已见过的 Error 实例在递归时返回截断占位 '[Circular cause]',
//   既保链路信息又不让 helper 自己崩。
function errPayloadStrImpl(err: unknown, seen: WeakSet<object>): string {
  if (err instanceof Error) {
    // 循环:同一 Error 实例再次出现在 cause 链上 → 截断,不再展开
    if (seen.has(err)) {
      const head = err.stack ? `${err.message}\n${err.stack}` : err.message;
      return `${head}\nCaused by: [Circular cause]`;
    }
    seen.add(err);
    const head = err.stack ? `${err.message}\n${err.stack}` : err.message;
    // audit 2026-09-07:拼上 cause —— AppError / ValidationError / 原生 Error({cause})
    //   都可能带根因,不暴露 → 链式失败调试只能看到最外层 message,根因不可见。
    // audit 2026-09-11:`!= null` 跳 null + undefined,避免 "Caused by: null" 噪音。
    if (err.cause != null) {
      return `${head}\nCaused by: ${errPayloadStrImpl(err.cause, seen)}`;
    }
    return head;
  }
  return toDisplayString(err);
}

/**
 * unknown err → string | undefined(err.code 收窄到 string)。
 *
 * - 包含 string `code` 字段的对象 → code
 * - number / null / undefined / Symbol / 缺 code 字段 → undefined
 * - non-object (string / number / null / undefined) → undefined
 *
 * 与 inline `(err as { code?: unknown }).code` 的关键区别:
 * 原 inline 让 `code` 是 `unknown`,直接 `code === 'ENOENT'` 比较时:
 *   - number / Symbol / null 严格不等于 'ENOENT',fallback 行为是"误判为非 ENOENT rethrow"
 *   - helper 显式收窄到 string,number 等落 undefined,行为**完全等价**但契约显式
 *
 * audit 2026-09-11:`'code' in err` 走的是原型链 —— Object.prototype 上的 code
 *   也会命中(几乎不可能,但 contract 文档写的是 own property)。
 *   改用 `Object.prototype.hasOwnProperty.call(err, 'code')` 收紧到 own property。
 *
 * 测试见 tests/unit/main/utils/errno-code.test.ts。
 */
export function errnoCode(err: unknown): string | undefined {
  if (err && typeof err === 'object' && Object.prototype.hasOwnProperty.call(err, 'code')) {
    const code = (err as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public cause?: unknown,
  ) {
    // audit 2026-09-07:把 cause 传给 super —— 标准 Error({cause}) 会把 cause
    //   挂在 Error.prototype.cause 上;不传则 prototype getter 永远是 undefined,
    //   IPC structured-clone / JSON.stringify(err) 都不带 cause,链式失败根因
    //   在 telemetry / toast 里彻底丢失。透传是单点修复。
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'AppError';
  }
}

export class LibraryError extends AppError {
  // audit 2026-09 (V1.9):删 SCAN_FAILED / WATCHER_ERROR / VALIDATION 三项 —
  //   0 production caller(SCAN_FAILED / WATCHER_ERROR 之前为扫描失败的占位
  //   code,实际实现早走 AppError;VALIDATION 用 ValidationError 替代,
  //   LibraryError 不应再承担 validation 职责)。NOT_FOUND / FILE_MISSING /
  //   IO_ERROR / TOO_LARGE / EACCES / DUPLICATE_NAME 是现存 6 个 caller 实际
  //   使用的 code,保留。
  //
  // audit 2026-10-08 (HIGH):加 CONFLICT —— writeNote expectedMtime 不一致
  //   时(防外部修改被静默覆盖,OneDrive sync / Vim 等),NotesService.write
  //   抛 LibraryError('CONFLICT', ...) 让 IPC wrap.ts 透传到 renderer,后者
  //   走 store/notes.ts:save 的 catch + toast 路径。
  // 加 VALIDATION —— ipc/notes.ts 的 expectedMtime 校验复用 LibraryError
  //   的 VALIDATION code(与其它 IPC handler 对齐,wrap.ts 走统一翻译)。
  constructor(
    code:
      | 'NOT_FOUND'
      | 'FILE_MISSING'
      | 'IO_ERROR'
      | 'TOO_LARGE'
      | 'EACCES'
      | 'DUPLICATE_NAME'
      | 'CONFLICT'
      | 'VALIDATION'
      // audit-r137:加 'INTERNAL' —— 调用方构造 LibraryError 时若 message
      //   含用户路径(典型 fs 抛 ENOENT/EACCES 的 errnoMessage),应使用
      //   'INTERNAL' 让 wrap.ts 走 scrubInternal 把家目录替成 <rootPath>
      //   占位符,避免 IPC wire 把全路径透传到 renderer / telemetry。
      //   已知 code(NOT_FOUND / VALIDATION / DUPLICATE_NAME / ...)的消息
      //   不含绝对路径,保持原 code 由 caller 决定。
      | 'INTERNAL',
    msg: string,
    cause?: unknown,
    public size?: number,
  ) {
    super(code, msg, cause);
    this.name = 'LibraryError';
  }
}

export class ValidationError extends AppError {
  constructor(
    msg: string,
    public field?: string,
    cause?: unknown,
  ) {
    super('VALIDATION', msg, cause);
    this.name = 'ValidationError';
  }
}

// audit round 17 (2026-09-02):
//   - SettingsError 已下线 —— 全仓无 caller(grep 仅此声明本身)。任何残留设置流
//     错误走 AppError + 显式 code 字符串即可。
//   - CollectionError 早已下线(模块整体删除后),仅留注释。
