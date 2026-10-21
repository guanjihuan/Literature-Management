#!/usr/bin/env node
// 检查 better-sqlite3 在当前 Node (system Node, ABI=N) 下能否加载。
// 不可加载时 exit 1,由 npm pretest hook 触发 `npm rebuild better-sqlite3`。
//
// 与 scripts/start.cjs 的 verify-abi 互为镜像:
//   - verify-abi      → 检查 Electron 内嵌 Node 的 ABI(ELECTRON_RUN_AS_NODE 子进程)
//   - verify-abi-node → 检查 system Node 的 ABI(直接 require)
//
// 两者都需要的原因:better-sqlite3 不是 N-API,每个 .node 只对应一个 ABI。
// Electron 30.5.1 用 ABI 123,系统 Node 20.15.x 用 ABI 115 —— 不能共用。
// dev 时调 verify-abi(配合 electron-rebuild),test 时调本脚本(配合 npm rebuild)。

try {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.close();
  process.exit(0);
} catch (e) {
  process.stderr.write(`[verify-abi-node] better-sqlite3 failed under system Node: ${e && e.message ? e.message : e}\n`);
  process.exit(1);
}