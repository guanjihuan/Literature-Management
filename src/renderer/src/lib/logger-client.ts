// 渲染端 logger (无 Node 依赖,只 console)
type Level = 'debug' | 'info' | 'warn' | 'error';
// audit round 8 (2026-09-14):CURRENT 派生 import.meta.env.DEV —— 之前硬编码
//   'info' 让 dev / prod 都丢 debug 日志,排查问题要手动改源码。Vite 提供
//   import.meta.env.DEV 在 dev build 是 true / prod build 是 false,直接用它
//   区分两套日志等级(DEV = debug, PROD = info),无需额外 env 配置。
const CURRENT: Level = import.meta.env.DEV ? 'debug' : 'info';
const LEVELS: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function createLogger(scope: string) {
  return {
    debug: (msg: string, ...args: unknown[]) =>
      CURRENT === 'debug' && console.debug(`[${scope}]`, msg, ...args),
    info: (msg: string, ...args: unknown[]) =>
      LEVELS[CURRENT] <= LEVELS.info && console.info(`[${scope}]`, msg, ...args),
    warn: (msg: string, ...args: unknown[]) => console.warn(`[${scope}]`, msg, ...args),
    error: (msg: string, ...args: unknown[]) => console.error(`[${scope}]`, msg, ...args),
  };
}
