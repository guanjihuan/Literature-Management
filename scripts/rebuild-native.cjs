#!/usr/bin/env node
// 重编 better-sqlite3 (项目唯一的运行时 native module) 匹配当前 Electron ABI。
//
// 调用方:
//   - scripts/start.cjs 在检测到 .node mtime 早于 electron.exe 时自动调
//   - 用户手动跑 `npm run rebuild:native`
//
// 关键:
//   - ELECTRON_RUN_AS_NODE=1 让 child process 的 require('electron') 返回
//     electron.exe 路径,而不是 electron 模块本身 —— 这样 electron-rebuild
//     才能正确读取 Electron 内嵌的 Node 版本并匹配 NODE_MODULE_VERSION
//   - stdio: 'inherit' 让 electron-rebuild 的进度输出原样透传
//   - 不捕获 stdout,失败时直接非零退出码交给 caller

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const electronRebuildCli = path.resolve(
  projectRoot,
  'node_modules',
  '@electron',
  'rebuild',
  'lib',
  'cli.js',
);

// node-gyp 失败时会把 build/Release/ 整个删掉 —— 包括原来那个**能用**的 .node。
// 在没有 MSVC 工具链、或 GitHub prebuild 下载超时的机器上(离线 / 网络受限),
// 这会把一个本来能跑的仓库变成跑不起来的仓库;更糟的是 start.cjs 检测到 .node
// 缺失会再次触发 rebuild,于是每次 npm run dev 都重复这个破坏。
// 所以:rebuild 前快照,失败就还原。
const nodeFile = path.join(
  projectRoot,
  'node_modules',
  'better-sqlite3',
  'build',
  'Release',
  'better_sqlite3.node',
);
const backupDir = path.join(projectRoot, 'node_modules', '.cache', 'rkms');
const backupFile = path.join(backupDir, 'better_sqlite3.node.bak');

// --no-snapshot:调用方已经知道当前 .node 是坏的(缺失 / ABI 不匹配),别把它
// 当成"上一个可用版本"存进快照 —— 那会把之前真正可用的快照覆盖掉,把安全网变成陷阱。
// start.cjs 的自动 rebuild 永远走这个分支(它只在探测失败时才调用本脚本);
// 人手跑 `npm run rebuild:native` 时默认做快照,这样 rebuild 失败还能退回去。
const noSnapshot = process.argv.includes('--no-snapshot');

/**
 * 当前 build/Release/.node 是否真的能在 Electron 里 dlopen。
 *
 * 只用 existsSync 判断"值得快照"是不够的 —— 本仓库的 .node 在两个 ABI 之间来回换:
 * `npm run test:run` 的 pretest 会把它换成系统 Node ABI(137),`npm run dev` 需要的
 * 是 Electron ABI(123)。文件一直存在,但对 Electron 而言可能是坏的。若把这种
 * 文件存成"上一个可用版本",rebuild 失败后还原回去,安全网就变成了陷阱:
 * 真正可用的旧快照被覆盖,而且日志还会谎称"已还原可用的 .node"。
 *
 * 探测手段与 start.cjs 的 probeBetterSqliteInElectron 一致(ELECTRON_RUN_AS_NODE=1
 * 跑 Electron 内嵌 Node,ABI 与主进程完全一致)。探测不了就保守返回 false —— 宁可
 * 不快照,也不要存一个来路不明的二进制。
 */
function existingBindingLoadsInElectron() {
  let electronExePath;
  try {
    electronExePath = require('electron');
  } catch {
    return false;
  }
  if (typeof electronExePath !== 'string' || !fs.existsSync(electronExePath)) {
    return false;
  }
  const probe = [
    "try {",
    "  const Db = require('better-sqlite3');",
    "  const db = new Db(':memory:');",
    "  db.close();",
    "  process.exit(0);",
    "} catch (e) {",
    "  process.exit(1);",
    "}",
  ].join('\n');
  try {
    const r = spawnSync(electronExePath, ['--no-deprecation', '-e', probe], {
      cwd: projectRoot,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      timeout: 30000,
    });
    return r.status === 0;
  } catch {
    return false;
  }
}

if (!noSnapshot && fs.existsSync(nodeFile)) {
  if (existingBindingLoadsInElectron()) {
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      fs.copyFileSync(nodeFile, backupFile);
      console.log(`[rebuild-native] Snapshotted existing binding -> ${backupFile}`);
    } catch (e) {
      console.warn('[rebuild-native] Snapshot failed (continuing):', e.message);
    }
  } else {
    console.log(
      '[rebuild-native] 跳过快照:现有 .node 在 Electron 里加载失败(ABI 不匹配或已损坏),',
    );
    console.log('[rebuild-native] 存它只会覆盖掉真正可用的旧快照。');
  }
}

function restoreBackup() {
  // tri-state: 'restored' 成功还原,'no-backup' 快照不存在,'kept-existing'
  // rebuild 失败但原地留了个文件 —— 这是最危险的中间态(node-gyp 异常退出
  // 时可能留个 0 字节 .node),以前被 if/else 漏掉,用户看不到任何提示。
  if (!fs.existsSync(backupFile)) return 'no-backup';
  if (fs.existsSync(nodeFile)) return 'kept-existing';
  try {
    fs.mkdirSync(path.dirname(nodeFile), { recursive: true });
    fs.copyFileSync(backupFile, nodeFile);
    return 'restored';
  } catch (e) {
    console.error('[rebuild-native] Restore failed:', e.message);
    return 'kept-existing';
  }
}

console.log('[rebuild-native] Rebuilding better-sqlite3 against Electron ABI...');
console.log('[rebuild-native] electron-rebuild CLI:', electronRebuildCli);

const result = spawnSync(
  process.execPath,
  [
    electronRebuildCli,
    '-f',                       // force:即使 mtime 一致也重新编译
    '-w', 'better-sqlite3',     // 只重编这一个模块(避免动到其它 native module)
    '--module-dir', projectRoot,
    '--only',                   // 不读 package.json 里的所有 deps,只处理 -w 指定的
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      // 关键:让 spawn 出来的 node 进程"扮演"成 electron 内嵌 node,
      // 这样 require('electron') 仍能拿到 electron 二进制路径供 electron-rebuild 推断 ABI
      ELECTRON_RUN_AS_NODE: '1',
    },
  },
);

if (result.error) {
  console.error('[rebuild-native] spawn failed:', result.error.message);
  if (restoreBackup() === 'restored') {
    console.error('[rebuild-native] 已还原之前可用的 better_sqlite3.node,仓库仍可运行。');
  }
  process.exit(1);
}

const status = result.status ?? 1;

if (status !== 0) {
  // 失败诊断:这两个是实战里最常见的原因,直接点名比让用户去读 node-gyp 堆栈快得多。
  console.error('');
  console.error('=====================================================');
  console.error('[rebuild-native] Rebuild 失败。常见原因:');
  console.error('  1) 没有 C++ 工具链 —— node-gyp 报 "Could not find any Visual Studio installation"。');
  console.error('     装 VS Build Tools(勾选 "Desktop development with C++"):');
  console.error('       winget install Microsoft.VisualStudio.2022.BuildTools');
  console.error('  2) prebuild 下载超时 —— better-sqlite3 的预编译包在 GitHub Releases 上,');
  console.error('     网络受限时会 timeout。配好代理后重试:');
  console.error('       set HTTPS_PROXY=http://127.0.0.1:<port>');
  console.error('       npm run rebuild:native');
  console.error('=====================================================');

  const restoreOutcome = restoreBackup();
  if (restoreOutcome === 'restored') {
    console.error('');
    console.error('[rebuild-native] 已还原 rebuild 之前那个可用的 better_sqlite3.node。');
    console.error('[rebuild-native] 仓库仍可 npm run dev —— 只要 Electron 版本没变,ABI 依旧匹配。');
  } else if (restoreOutcome === 'no-backup') {
    console.error('');
    console.error('[rebuild-native] 警告:build/Release/better_sqlite3.node 现在不存在,');
    console.error('[rebuild-native] 且没有可还原的快照。修好上面的原因后再跑一次。');
  } else if (restoreOutcome === 'kept-existing') {
    console.error('');
    console.error('[rebuild-native] 警告:rebuild 失败,但原地还留着一个 better_sqlite3.node。');
    let size = -1;
    try {
      size = fs.statSync(nodeFile).size;
    } catch {}
    console.error(
      `[rebuild-native] 该文件大小 = ${size} 字节 —— 很可能是 node-gyp 异常退出时留下的残骸。`,
    );
    console.error('[rebuild-native] 手动删掉后再重跑:`rm build/Release/better_sqlite3.node`');
    console.error(
      '[rebuild-native] 不删的话下次探测照样不过,start.cjs 会反复触发 rebuild 死循环。',
    );
  }
}

process.exit(status);