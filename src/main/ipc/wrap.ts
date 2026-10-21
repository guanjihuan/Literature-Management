// src/main/ipc/wrap.ts
import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { ZodType } from 'zod';
import { AppError, LibraryError, ValidationError, errMsg } from '../utils/error';
import { scrubInternal } from '../utils/scrub-internal';
import { createLogger } from '../utils/logger';
import { IpcResult, isIpcErrorCode } from '../../shared/types';

const log = createLogger('ipc');

// 错误响应包络 — 直接复用 shared/types 的 IpcResult,字段镜像一致:
// ok=false 时带 code/message + 透传 status/body/size/field(可选)。
// 这样 preload / renderer / tests 拿的是同一个 discriminated union,
// 不会出现"主进程声明 unknown / shared 声明 string"这种类型谎言。
type IpcErrorPayload = Extract<IpcResult<unknown>, { ok: false }>;

/**
 * 异常 → IpcErrorPayload 映射(旧 handle 与新 handleZod 共用)。
 *
 * 集中点 —— 任何 IpcErrorCode union 扩码 / LibraryError.size / ValidationError.field
 * 透传变更,只在这里改一处。直接 inline 两份会让 union widening 漂移
 * (r51 BACK_PRESSURE 加进来时,旧 handle 漏,新 handleZod 加,两个不一致,
 * 行为上 renderer 收到一个 INTERNAL 一个 BACK_PRESSURE,debug 极难)。
 */
function mapErrorToEnvelope(err: unknown, channel: string): IpcErrorPayload {
  const e: AppError = err instanceof AppError ? err : new AppError('INTERNAL', errMsg(err), err);
  log.warn('IPC failed', channel, e.code, e.message);
  // audit r55 (2026-10-16):wrap.ts catch 兜底 log.error —— 任何非 AppError
  //   的 throw(Error / 类型 throw)走到这里,只有 log.warn 配 message 时**不会有
  //   stack**。开发者排查 IPC handler 内部失败时,console 只看到 'IPC failed X INTERNAL msg',
  //   完全不知道哪一行 throw。补一条 log.error 让 stack 留底,排查时间从 30min 降到 5min。
  //   AppError 已经有结构化语义(code/message/cause),warn 一条足够;这条 error 只
  //   针对「裸 Error 滑进来」场景,warn + error 双写不冗余(前者给业务码、后者给位置)。
  if (!(err instanceof AppError)) {
    log.error('IPC handler error (non-AppError): see stack below', channel, err);
  }
  // audit v2.0 Phase 0c (2026-09-17):wire boundary 校验 e.code 是否落在
  // IpcErrorCode union 内。e.code 来自 AppError 任意 string(API 设计保留
  // 灵活性),但 IpcResult.code 已经收窄,需要 cast + 兜底。漏加到 union 的
  // 新码会被映射到 INTERNAL,用户看到通用错误 + main 进程日志能定位。
  const wireCode: IpcErrorPayload['code'] = isIpcErrorCode(e.code)
    ? e.code
    : (() => {
        log.warn('IPC code not in union, falling back to INTERNAL', channel, e.code);
        return 'INTERNAL' as const;
      })();
  const result: IpcErrorPayload = {
    ok: false,
    code: wireCode,
    // audit r52 (2026-10-15) C3:INTERNAL 分支走 scrubInternal 替换用户路径
    //   为 <rootPath> 占位符,防止 IPC wire 把家目录透传到 renderer / telemetry。
    //   已知 code(DUPLICATE_NAME / VALIDATION / NOT_FOUND / ...)的消息
    //   一般不包含绝对路径,直接透传保留上下文。
    message: wireCode === 'INTERNAL' ? scrubInternal(e.message) : e.message,
  };
  // 透传 LibraryError.size(TOO_LARGE 时需要),让 Reader 能提示文件实际大小
  if (err instanceof LibraryError && err.size !== undefined) {
    result.size = err.size;
  }
  // 透传 ValidationError.field(VALIDATION 时需要),前端可定位到具体输入项
  if (err instanceof ValidationError && err.field !== undefined) {
    result.field = err.field;
  }
  return result;
}

/**
 * 在 IPC 入口验证"对象必须是 object、字段必须是 T 类型"。
 *
 * 解决的核心问题:handle<TArgs> 的 `as TArgs` 跳过了运行时检查,renderer
 * 注入坏 payload(手改、第三方扩展、DevTools 注入)就会让 main 进程的
 * service 层把非 object 当 object / 把 string 当 array 写到磁盘,炸在
 * 下游的 `.map` / `new Set()` / `JSON.stringify` 调用上。
 *
 * 约定:校验函数返回 true 即放行,false 抛 ValidationError。channelName
 * 用于错误信息,field 透传到 UI 便于定位。
 */
export function requireObject(channelName: string, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${channelName}: payload must be an object`, 'payload');
  }
  return value as Record<string, unknown>;
}

export function requireString(
  channelName: string,
  value: unknown,
  field: string,
  options?: { maxLen?: number; maxBytes?: number },
): string {
  if (typeof value !== 'string') {
    throw new ValidationError(`${channelName}: field "${field}" must be a string`, field);
  }
  // D2-006: 长度上限 — 防止 renderer 注入 10MB 字符串进 IPC channel(单 channel
  // 默认上限 ~100MB,但我们在到达 electron 边界之前先拒,避免大块 alloc)。
  // 多数业务字段(id / filename / fileId)≤ 256 字符够用,需要更高上限的地方
  // 单独传 options(如 notes body 走 library/metadata.ts MAX_NOTE_BODY_BYTES
  // = 5MB 单独检查 —— 现存唯一 5MB 上限 caller)。
  if (options?.maxLen !== undefined && value.length > options.maxLen) {
    throw new ValidationError(
      `${channelName}: field "${field}" exceeds ${options.maxLen} chars`,
      field,
    );
  }
  // audit round 10 (2026-08-22):maxBytes 是 maxLen 的 UTF-8 字节维度补充 ——
  // CJK / emoji 字符每个占 3-4 字节,光看 char count 会让 5MB 限制被绕过成
  // 20MB 实际字节。notes body 等可写字段走 maxBytes 精确控制。
  // maxLen 和 maxBytes 是 orthogonal 选项 — 调用方按字段特性选其一或两者都用。
  if (options?.maxBytes !== undefined && Buffer.byteLength(value, 'utf8') > options.maxBytes) {
    throw new ValidationError(
      `${channelName}: field "${field}" exceeds ${options.maxBytes} bytes`,
      field,
    );
  }
  return value;
}

// TArgs extends any[] 是 TS 官方文档推荐的"任意 IPC handler 参数"约束模式
// (替代方案 unknown[] 会强制所有调用方显式标 IpcArgs tuple,改动面过大)。
//
// audit r50 (2026-10-15):保留**旧签名 handle<TArgs, TRet>** 兼容未迁移
//   的 30+ 个 handler —— 一次性全迁移会让 round diff 巨大、回归面广。
//   新签名 handleZod<Req, Res>(channel, schemaReq, schemaRes, fn) 走 Zod
//   边界校验;两者并存,由调用方按迁移进度选用。新签名稳定后旧 handle
//   会逐步退出(预计 r52 / r53 删干净)。
//
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function handle<TArgs extends any[], TRet>(
  channel: string,
  fn: (event: IpcMainInvokeEvent, ...args: TArgs) => Promise<TRet> | TRet,
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      const data = await fn(event, ...(args as TArgs));
      return { ok: true, data };
    } catch (err: unknown) {
      return mapErrorToEnvelope(err, channel);
    }
  });
}

/**
 * 新签名 handleZod<Req, Res>(channel, schemaReq, schemaRes, fn) —— Zod 边界。
 *
 * 关键合约:
 *   1. **入口校验**:fn 调用前 schemaReq.safeParse(raw)。失败返
 *      `{ ok: false, code: 'INVALID_INPUT', message, field }`,**不**调 fn。
 *      这是「renderer 加新字段 / 注入坏 payload」零成本挡在最外圈。
 *   2. **出口校验**:fn 返回值 schemaRes.safeParse(verified)。失败返
 *      `{ ok: false, code: 'INTERNAL', message: 'response schema mismatch' }`,
 *      主进程日志含 verified.error,便于排查主进程 return 结构漂移。
 *   3. **错误透传契约**(与旧 handle 同款):AppError / LibraryError /
 *      ValidationError 错误码 / size / field 全部透传。
 *
 * 与旧 handle 的兼容性:
 *   - 旧 handle 没有 Req/Res 校验,fn 收到 `unknown` 数组 → fn 内部用
 *     requireObject / requireString 逐字段守;
 *   - 新 handleZod 在 fn 前一步做了 Req schema,fn 收到的 req 是 Zod 解析后的
 *     类型(若 schema 用 strict(),多余字段已被 reject);
 *   - 同一 IPC channel 只能调一次 handle 或 handleZod,不能两次都注册
 *     (ipcMain.handle 会覆盖前一个)。
 *
 * @param schemaReq 入参 Zod schema(必填,即使是 z.void() 也得显式声明)
 * @param schemaRes 出参 Zod schema(必填,保护 renderer 不被主进程静默改
 *                  返回结构影响)
 */
export function handleZod<Req, Res>(
  channel: string,
  schemaReq: ZodType<Req>,
  schemaRes: ZodType<Res>,
  fn: (event: IpcMainInvokeEvent, req: Req) => Promise<Res> | Res,
): void {
  ipcMain.handle(channel, async (event, raw: unknown) => {
    const parsedReq = schemaReq.safeParse(raw);
    if (!parsedReq.success) {
      const issue = parsedReq.error.issues[0];
      const field = issue.path.length > 0 ? issue.path.join('.') : undefined;
      const message = issue.message;
      log.warn('IPC Req schema mismatch', channel, field, message);
      const failResult: IpcErrorPayload = {
        ok: false,
        code: 'INVALID_INPUT',
        message,
      };
      if (field !== undefined) failResult.field = field;
      return failResult;
    }
    try {
      const data = await fn(event, parsedReq.data);
      const parsedRes = schemaRes.safeParse(data);
      if (!parsedRes.success) {
        log.error('IPC Res schema mismatch', channel, parsedRes.error);
        return {
          ok: false,
          code: 'INTERNAL' as const,
          message: 'response schema mismatch',
        };
      }
      return { ok: true, data: parsedRes.data };
    } catch (err: unknown) {
      return mapErrorToEnvelope(err, channel);
    }
  });
}

// redactSensitive 已下线(2026-09 V1.6 audit)—— AI 模块删除后 0 生产 caller,
//   原注释列的"provider debug 端点 echo header 到 response body"威胁源随之消失。
//   通用正则可以套到未来任何 outbound HTTP 场景,但本项目 ssrf.ts 例外的判定标准
//   是"明确的未来使用场景列表"—— redact 没有,留下 18 行 dead code。
//   未来真要做导出 / RSS / Web Clipper 时再从 git history 找回即可。
