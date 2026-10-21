// 永不 throw 的显示态字符串转换(audit-r124 主进程首发,r217 下沉 shared)。
//
// 旧注释宣称「String(err) 本身不抛」—— 错:`String(Object.create(null))` 在
// V8 直接 TypeError(缺 toString/valueOf),throwing toString 的普通对象同样。
// 这类 helper 是 catch 块里的最后防线,自己炸了等于把可观测性也炸掉。
//
// r217:主进程(main/utils/error.ts)与 renderer(lib/error.ts)各有一份
// 「err → 显示字符串」逻辑,renderer 版停留在 r124 修复前的旧口径
// (`String(Object.create(null))` 直接 TypeError)—— 典型的「孪生实现修一边
// 漏一边」。下沉到 shared 让两侧共用同一份实现,消灭孪生。
//
// 降级链:String → Object.prototype.toString.call(读内部槽,普通对象恒
// '[object Object]')→ 常量。第三档仍 throw 的对象只有带 throwing
// getPrototypeOf trap 的 Proxy,常量兜底足够日志可读。
export function toDisplayString(value: unknown): string {
  try {
    return String(value);
  } catch {
    try {
      return Object.prototype.toString.call(value);
    } catch {
      return '[unstringifiable error]';
    }
  }
}

/**
 * unknown err → 人类可读消息。
 *   - Error 实例 → err.message
 *   - 字符串     → 原样返回
 *   - 其它       → toDisplayString(err)(null→'null', undefined→'undefined',
 *                   对象→'[object Object]';null-proto / throwing toString
 *                   走降级链)
 *
 * 关键:**永不 throw** —— 它是 catch 块里的最后一道防线,自己炸了等于把
 * 真错也盖掉。
 *
 * audit-r229:本函数此前在 main/utils/error.ts 与 renderer/lib/error.ts
 *   **各有一份逐字相同的实现**(r217 只把底座 toDisplayString 下沉了,
 *   外层包装留成孪生 —— 典型「修一半」)。同轮下沉到 shared:
 *     - 两处旧路径保留 re-export,既有 import 路径(main/ 全域 + tests +
 *       renderer 全域)一行不改;
 *     - preload 侧改直连 @shared/display-string —— 它此前 import
 *       '../main/utils/error'(**运行时**引 main),与 ARCHITECTURE「preload
 *       只做桥、不含业务」冲突;errMsg 是零依赖纯函数,下沉后 preload 不再
 *       把 main 的模块图拖进 renderer 进程的启动路径(与 r140 把
 *       MAX_TOAST_MESSAGE_CHARS 搬去 @shared/limits/ipc 同款修法)。
 */
export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : toDisplayString(err);
}
