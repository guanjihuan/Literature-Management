// 简单日志器:写到 stderr (开发期可在 Electron 控制台看到)
import process from 'node:process';
import { errMsg, toDisplayString } from './error';

// Windows UTF-8 兜底:start.cjs 已经 chcp 65001 切到 UTF-8 codepage,但用户绕过 npm
// 直接跑 electron 时 codepage 仍是 cp936。Node 默认按 process.env 的编码把 string
// 写到 tty stream,在 cp936 终端上中文路径会变成 "æç å·¥ä½" 这种 mojibake,把真正
// 的根因(例如 NODE_MODULE_VERSION mismatch)掩盖成"看起来像路径问题"。
// 显式 setDefaultEncoding('utf8') 让后续 write 都按 UTF-8 编码字节流,配合
// 终端 UTF-8 codepage 就能正确显示中文。setDefaultEncoding 失败时 (例如打包后
// stdout 不是 TTY) 静默 fallback,不影响功能。
if (process.platform === 'win32') {
  try {
    process.stdout.setDefaultEncoding('utf8');
  } catch {
    // ignore — 非 TTY 或其他 stream 不支持 setEncoding
  }
  try {
    process.stderr.setDefaultEncoding('utf8');
  } catch {
    // ignore
  }
}

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

// audit 2026-09-11:验证 LOG_LEVEL 必须在 LEVELS enum 内 —— 旧实现直接 cast
//   `as Level`,LOG_LEVEL=foo 时 LEVELS[currentLevel] 是 undefined,所有 level
//   比较都变 NaN <= N = false,**所有** log 静默 no-op。用户配错环境变量
//   会让整个项目看起来"没崩"但实际什么 trace 都看不到。
//   修:不在 LEVELS 内 → fallback 'info' + console.warn 一次提醒。
const VALID_LEVELS = new Set<string>(Object.keys(LEVELS));
const rawLevel = process.env.LOG_LEVEL;
const currentLevel: Level = rawLevel && VALID_LEVELS.has(rawLevel) ? (rawLevel as Level) : 'info';
if (rawLevel && !VALID_LEVELS.has(rawLevel)) {
  // 不能走 logger(自己就是被 logger 引用的);直写 stderr。
  process.stderr.write(`[logger] invalid LOG_LEVEL=${rawLevel}; falling back to 'info'\n`);
}

// audit C3R22 (2026-08-22):删 setLogLevel / getLogLevel — 零调用方。
// 运行时调 log level 当前没有 UI 面板(log level 只在启动期从 LOG_LEVEL env
// 读取),两个导出是 over-engineering;未来真要做 debug panel 时再加。

function format(level: Level, scope: string, msg: string, ...args: unknown[]): string {
  const ts = new Date().toISOString();
  // audit-r124:非 error 档此前裸 JSON.stringify —— 循环引用 / BigInt 直接
  //   throw,把 log.warn(常规调用)炸成调用方异常(error() 分支早有 try/catch
  //   + [unserializable] 标记,口径对齐)。
  const tail = args.length ? ' ' + args.map((a) => stringifyArg(a)).join(' ') : '';
  return `[${ts}] [${level.toUpperCase()}] [${scope}] ${msg}${tail}`;
}

function stringifyArg(a: unknown): string {
  if (typeof a === 'string') return a;
  try {
    return JSON.stringify(a);
  } catch (err: unknown) {
    return `[unserializable: ${errMsg(err)}] ${toDisplayString(a)}`;
  }
}

export function createLogger(scope: string) {
  return {
    debug(msg: string, ...args: unknown[]) {
      if (LEVELS[currentLevel] <= LEVELS.debug) console.error(format('debug', scope, msg, ...args));
    },
    info(msg: string, ...args: unknown[]) {
      if (LEVELS[currentLevel] <= LEVELS.info) console.error(format('info', scope, msg, ...args));
    },
    warn(msg: string, ...args: unknown[]) {
      if (LEVELS[currentLevel] <= LEVELS.warn) console.error(format('warn', scope, msg, ...args));
    },
    error(msg: string, ...args: unknown[]) {
      if (LEVELS[currentLevel] <= LEVELS.error) {
        const formatted = args.map((a) => {
          if (a instanceof Error) return `${a.message}\n${a.stack}`;
          if (typeof a === 'object') {
            try {
              return JSON.stringify(a, null, 2);
            } catch (err: unknown) {
              // audit round 17 (2026-09-02):JSON.stringify 失败不再静默
              //   —— 循环引用 / BigInt 在生产路径偶尔出现,fallback 到 String(a)
              //   会让日志看起来正常但实际丢了字段。附加 stringify-failed
              //   标记便于 telemetry 区分"故意 fall through" vs "真崩了"。
              //   不递归调 log.* —— logger 自身异常不能再走 logger(防死循环)。
              return `[unserializable: ${errMsg(err)}] ${toDisplayString(a)}`;
            }
          }
          return String(a);
        });
        console.error(format('error', scope, msg, ...formatted));
      }
    },
  };
}
