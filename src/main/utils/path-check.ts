// D2-020: 主进程启动路径安全检查,作为 scripts/start.cjs 的兜底防御。
//
// 必须在 main/index.ts 的最顶部 import,以便在 better-sqlite3 dlopen 之前
// 截断路径确实不安全的进程。
//
// 策略(2026-08-28 修订):
//   - cwd 超长 (>240)  → 致命,直接退出。真实的 Windows MAX_PATH 限制。
//   - cwd 含 CJK       → 仅提示。实测 Electron 30 + Win11 能正常 dlopen CJK 路径,
//                        原来的致命判定反而逼出了 ASCII junction,把 vite dev server 搞崩。
//                        详见 scripts/start.cjs 顶部的分析。
//
// 另:作为第二道兜底,如果 .node 文件的 ABI 已经过期(mtime 早于 electron.exe),
// 直接报清晰错误而不是让 dlopen 抛乱码堆栈。start.cjs 在正常 npm run dev 下
// 会先一步自动 rebuild,这里只处理"用户绕过 npm"或"自动 rebuild 失败"的场景。

import process from 'node:process';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// 必须用 createRequire 而不是 ESM `import` —— ESM import 会被 hoist 到模块顶部,
// 导致 `import('electron')` 在本检查函数之前就执行,破坏"先检查再 dlopen"的时序保证。
// 实际上这里只读 .node 路径不真正 dlopen,但用 require 形式是为了显式表达意图,
// 避免未来重构时被 hoist 规则坑到。
const requireFromHere = createRequire(import.meta.url);

function checkWindowsPath(): void {
  if (process.platform !== 'win32') return;

  // 仅在 dev/源码运行模式下生效:此时 better-sqlite3 从 cwd/node_modules 加载,
  // cwd 的 CJK 会让 dlopen 失败。打包模式下 .node 从 app.asar.unpacked 加载
  // (位于 %LOCALAPPDATA%),cwd 是否含 CJK 与加载路径无关,跳过。
  const cwd = process.cwd();
  const devNativeMarker = path.join(cwd, 'node_modules', 'better-sqlite3');
  if (!existsSync(devNativeMarker)) return;

  // 匹配非 ASCII（含 CJK）字符。使用 \x00-\x7F 边界是检测非 ASCII 的
  // 标准写法。\x00 控制字符是有意的,排除注释 eslint。
  // eslint-disable-next-line no-control-regex
  const hasCJK = /[^\x00-\x7F]/.test(cwd);
  const tooLong = cwd.length > 240;
  if (!hasCJK && !tooLong) return;

  // CJK 不再是致命错误(2026-08-28 修订)。
  //
  // 原假设:CJK cwd → Windows 给 .node 加 \\?\ 前缀时 Node 按 CP936 解码 UTF-8 → dlopen 失败。
  // 实测在 Electron 30 + Win11 下不成立:scripts/start.cjs 的 verify-abi 探针就是在真实 CJK
  // cwd 下 spawn electron.exe 跑 require('better-sqlite3') + new Database(':memory:') 成功的。
  //
  // 而把 CJK 判成致命错误的代价很实在:它逼着 start.cjs 去建 ASCII junction,而 junction 会让
  // process.cwd() 与 vite 的 cacheDir 不同源,直接崩掉 dev server(见 start.cjs 顶部注释)。
  // 所以 CJK 降级为一次性提示,真正 dlopen 失败时下面的 ABI 检查和 Node 自己的报错会接管。
  if (hasCJK && !tooLong) {
    process.stderr.write(
      `[path-check] 注意: 项目路径含非 ASCII 字符 (${cwd.length} chars): ${cwd}\n` +
        `[path-check] 已知在 Electron 30 + Win11 下可正常加载 native module。\n` +
        `[path-check] 若 better-sqlite3 dlopen 失败,试 RKMS_FORCE_JUNCTION=1 npm run dev。\n`,
    );
    return;
  }

  // 超长路径仍然致命 —— 这是真实的 Windows MAX_PATH 限制,与字符集无关。
  const reason = `path too long (${cwd.length} chars)`;

  const lines = [
    '',
    '=====================================================',
    '[FATAL] Project path is not safe for native module loading.',
    `  cwd:    ${cwd}`,
    `  reason: ${reason}`,
    '',
    '  Windows 的 MAX_PATH 会让 node_modules 深层文件路径被截断。',
    '',
    '  Manual fix: move the project to a shorter path, e.g.',
    '    D:\\dev\\research-knowledge-management-system',
    '',
    '  Or create a junction and launch from it:',
    `    mklink /J C:\\rkms "${cwd}"`,
    '    cd C:\\rkms && npm install && npm run dev',
    '=====================================================',
    '',
  ];
  // logger 尚未初始化,直接写 stderr
  process.stderr.write(lines.join('\n'));
  process.exit(1);
}

/**
 * 检查 better_sqlite3.node 的 mtime 是否晚于 electron.exe。
 * mtime 早于 electron → 升级 Electron 后没重跑 install,ABI 漂移。
 * 此时直接给清晰错误并退出 —— 比让 Node dlopen 抛
 * "The module '...\\?\D:\data\我的工作...' was compiled against a different
 * Node.js version using NODE_MODULE_VERSION XXX" 这种带乱码路径的错友好得多。
 *
 * 这一层是 scripts/start.cjs 自动 rebuild 的**兜底**:如果用户绕过 npm 直接
 * 跑 electron(IDE / 双击 / 手敲),start.cjs 的检测和自动修复都不会发生,
 * 这里就接管报错。
 */
function checkBetterSqliteAbi(): void {
  if (process.platform !== 'win32') return;

  const cwd = process.cwd();
  const sqlitePath = path.join(
    cwd,
    'node_modules',
    'better-sqlite3',
    'build',
    'Release',
    'better_sqlite3.node',
  );
  if (!existsSync(sqlitePath)) return; // 第一次 install,交给 postinstall / 下次 npm run dev 的 start.cjs

  let electronPath: unknown;
  try {
    electronPath = requireFromHere('electron');
  } catch {
    return; // electron 模块找不到(非 dev 模式或打包后),跳过
  }
  if (typeof electronPath !== 'string' || !existsSync(electronPath)) return;

  let sqliteStat, electronStat;
  try {
    sqliteStat = statSync(sqlitePath);
    electronStat = statSync(electronPath);
  } catch {
    return;
  }

  // .node 比 electron 新 → 已经对齐,无事可做
  if (sqliteStat.mtimeMs >= electronStat.mtimeMs) return;

  // 用 writeSync 直写 fd=2 (stderr) 而不是 console.error:
  // console.error 会把 string 通过 tty stream 写出,Windows PowerShell cp936 终端
  // 会按 GBK 解码,把 UTF-8 字节再次变成乱码 —— 反而掩盖真正的根因。
  // writeSync 直接发字节流,配合终端 UTF-8 codepage (start.cjs 已 chcp 65001)
  // 一定能正确显示中文路径。
  try {
    process.stderr.write(`\r\n`);
    process.stderr.write(`=====================================================\r\n`);
    process.stderr.write(`[FATAL] better-sqlite3 ABI mismatch.\r\n`);
    process.stderr.write(`  better_sqlite3.node mtime: ${sqliteStat.mtime.toISOString()}\r\n`);
    process.stderr.write(`  electron.exe mtime:       ${electronStat.mtime.toISOString()}\r\n`);
    process.stderr.write(`\r\n`);
    process.stderr.write(
      `  说明: 升级 Electron 后没重跑 npm install,导致 .node 是用旧的 ABI 编译的。\r\n`,
    );
    process.stderr.write(`        启动主进程时 dlopen 会抛 'NODE_MODULE_VERSION XXX' 错误。\r\n`);
    process.stderr.write(`\r\n`);
    process.stderr.write(`  修复(在项目根目录执行任一命令):\r\n`);
    process.stderr.write(`     npm run rebuild:native\r\n`);
    process.stderr.write(`     npm rebuild better-sqlite3\r\n`);
    process.stderr.write(`     npx electron-rebuild -f -w better-sqlite3\r\n`);
    process.stderr.write(`\r\n`);
    process.stderr.write(
      `  之后正常 npm run dev 即可。如果是通过 IDE 启动,请改用 npm run dev 让 start.cjs 自动处理。\r\n`,
    );
    process.stderr.write(`=====================================================\r\n`);
  } catch {
    // 写不出来就退,反正 process.exit(1) 也会被 IDE 看到
  }
  process.exit(1);
}

checkWindowsPath();
checkBetterSqliteAbi();

export {};
