#!/usr/bin/env node
// 自适应 vitest 启动器 —— 解决 better-sqlite3 的「双 ABI 互相覆盖」问题。
//
// 背景(2026-10-19 实地复现):
//   better-sqlite3 不是 N-API,一个 .node 只对应一个 ABI:
//     - Electron 30.5(NODE_MODULE_VERSION 123)要 Electron 版 —— app 运行时用
//     - 系统 Node 24(NODE_MODULE_VERSION 137)要 Node 版 —— vitest 用
//   两者共用同一个路径:
//     node_modules/better-sqlite3/build/Release/better_sqlite3.node
//
//   旧做法(pretest / pretest:run / pretest:coverage 都是这一行):
//     node scripts/verify-abi-node.cjs || npm rebuild better-sqlite3
//   → 为了让测试能跑,**破坏性地**把 app 那份覆盖成 Node 版。
//   Windows 上 .node 被运行中的 electron 进程锁住 → unlink 报
//   EPERM/EBUSY → 重建失败 → pretest 非 0 退出 → npm 把整条
//   `npm run test:run` 一起中止(哪怕测试本身全绿)。
//   反向也成立:测试跑完 .node 变成 Node 版,下一次 `npm run dev` 又要
//   重建回 Electron 版 —— 每次切换都可能被运行中的 app 锁死。
//
// 策略:不再为了跑测试而重建。改成二选一启动器,按「当前 .node 到底是谁的」
// 决定用谁来跑 vitest:
//   1. 系统 Node 能直接 require('better-sqlite3') → 用系统 Node 跑 vitest。
//      (Linux/macOS 的 napi prebuilt 天然两用;Windows 上若已是 Node 版 .node
//      也走这条)
//   2. 否则(Windows + Electron 版 .node,也就是常态)→ 用 Electron 自带的
//      Node 跑 vitest(ELECTRON_RUN_AS_NODE=1)。此时测试与 app 共用同一份
//      原生模块:零重建、零 EBUSY、也不会把 app 那份覆盖掉。
//
// 附带收益:Electron 30.5 内嵌 Node 是 v20.16.0,仍在 package.json 的
// engines(>=20.16.0 <25)范围内,所以这条路不引入新的版本约束。
//
// 退出码透传 vitest 的退出码;CI 语义不变。
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
const VITEST_ENTRY = path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const argv = process.argv.slice(2);

function log(msg) {
  process.stderr.write(`[run-tests] ${msg}\n`);
}

/** 系统 Node 当前能否加载 better-sqlite3(= .node 是否是 Node ABI 版本)。 */
function nativeLoadable() {
  try {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}

/** electron npm 包在 Node 下导出的是二进制路径字符串;拿不到就退回 dist 猜路径。 */
function electronBinary() {
  try {
    const p = require('electron');
    if (typeof p === 'string' && fs.existsSync(p)) return p;
  } catch {
    /* 落到下面的猜测 */
  }
  const exe = process.platform === 'win32' ? 'electron.exe' : 'electron';
  const guess = path.join(ROOT, 'node_modules', 'electron', 'dist', exe);
  return fs.existsSync(guess) ? guess : null;
}

function run(cmd, cmdArgs, env) {
  const res = spawnSync(cmd, cmdArgs, { stdio: 'inherit', cwd: ROOT, env });
  if (res.error) {
    log(`启动失败: ${res.error.message}`);
    return 1;
  }
  // 被信号杀死时 status 为 null
  return typeof res.status === 'number' ? res.status : 1;
}

if (!fs.existsSync(VITEST_ENTRY)) {
  log(`找不到 vitest 入口 ${VITEST_ENTRY} —— 先执行 npm install`);
  process.exit(1);
}

let code;
if (nativeLoadable()) {
  // 路线 1:系统 Node 直跑(app 那份 .node 已经是 Node 版,或 napi 通用版)
  code = run(process.execPath, [VITEST_ENTRY, ...argv], process.env);
} else {
  // 路线 2:用 Electron 自带 Node 跑 —— 与 app 共用同一份原生模块
  const electron = electronBinary();
  if (!electron) {
    log('better-sqlite3 在系统 Node 下不可加载,且找不到 electron 可执行文件。');
    log('  手动修复(选一条):');
    log('    npx electron-rebuild -f -w better-sqlite3   # 给 app 用');
    log('    npm rebuild better-sqlite3                 # 给系统 Node 用');
    process.exit(1);
  }
  log('better-sqlite3 当前为 Electron ABI —— 改用 Electron 自带 Node 跑 vitest');
  log('  (与 app 共用同一份原生模块:不重建、不覆盖,规避 EBUSY)');
  code = run(electron, [VITEST_ENTRY, ...argv], {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
  });
}

process.exit(code);
