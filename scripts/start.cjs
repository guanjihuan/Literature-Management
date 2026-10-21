#!/usr/bin/env node
// 启动包装器:
//   1) 取消 ELECTRON_RUN_AS_NODE(用户的 shell 里可能有)
//   2) Windows 路径兜底:如果 cwd 含 CJK 或超长(>240),在 %LOCALAPPDATA%\rkms-junctions\<hash>
//      建一个 ASCII junction,然后 chdir 进去再启动 electron-vite。
//      这能避免 better-sqlite3 dlopen 时 \\?\ 前缀把 CJK 路径解读成 mojibake。
//   3) Windows 终端 codepage 切到 65001,避免 electron-vite 输出中文时乱码。
//
// 逃生通道(给用户控制权,不让工具绑架项目路径):
//   - RKMS_NO_JUNCTION=1    跳过 junction,直接用原始 cwd(现代 Win11 + Electron 通常能直接吃 CJK 路径)
//   - RKMS_JUNCTION_DIR=... 自定义 ASCII junction 父目录(LOCALAPPDATA 被污染时用这个)
const { spawn, execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
// audit r40 (2026-10-15):shutdownTree 抽到 scripts/shutdown.cjs 便于单测;
//   详见该文件头注。
const { shutdownTree } = require('./shutdown.cjs');

// Windows 终端默认 codepage 是 cp936(中文系统),会把后续 console.* 里的 UTF-8 字节
// 按 GBK 解读 → 中文路径变成 鎴... 这种乱码。这个乱码连 start.cjs 自己的 ABI 探针
// 失败回显都吃(实测:探针的 stderr 是 UTF-8,Node 用 utf8 解码后 console.warn 写到终端,
// 终端 codepage=cp936 时显示成 `The module '\\?\C:\data\æ£å¨å·¥ä½\æºè½ä½ç®¡çç`)。
//
// 必须发生在**任何** console.* 调用之前 —— 一旦第一段 UTF-8 中文进了终端缓冲,
// 就已经被 cp936 错误解码了,改 codepage 也救不回来。所以这条不能下移到 spawn 之前,
// 必须放在文件顶部。
//
// 实现:cmd /c chcp 65001 通过共享的 console handle 改 codepage,影响同一 console
// 上的所有进程(包括 node 自身的后续 stdout)。失败时(非交互 console / 已 UTF-8
// 终端)忽略 —— 顶多中文乱码,不影响功能。RKMS_SKIP_CHCP 给 CI / 自动化场景逃生。
if (process.platform === 'win32' && !process.env.RKMS_SKIP_CHCP) {
  try {
    // audit 2026-09-14:windowsHide: true —— 避免 cmd.exe 启动瞬间的 console
    //   窗口闪烁。cmd 是 console-subsystem,默认 spawn 会弹一个黑色 cmd 窗口
    //   即使 stdio: 'ignore' 也可见;windowsHide 让子进程在父 console handle
    //   内隐藏运行,chcp 65001 改 codepage 仍生效(共享 console)。
    spawnSync('cmd.exe', ['/c', 'chcp', '65001'], { stdio: 'ignore', windowsHide: true });
  } catch {
    // codepage 切换失败,忽略 —— 后续输出可能乱码但不影响功能
  }
}

const command = process.argv[2];
if (!command) {
  console.error('Usage: node scripts/start.cjs <dev|build|start>');
  process.exit(1);
}

const commandMap = {
  dev: ['electron-vite', ['dev']],
  build: ['electron-vite', ['build']],
  start: ['electron-vite', ['preview']],
};

// 轻量 verify 子命令:只检查 better_sqlite3.node 的 mtime vs electron.exe 的 mtime,
// 不启动 electron-vite。给 predev / CI / 用户手动诊断用。
//   node scripts/start.cjs verify-abi
//   exit 0 = OK 或已自动修复; exit 1 = 修复失败(需要人工介入)
if (command === 'verify-abi') {
  const fixed = checkAndFixNativeAbi({ silent: true });
  if (!fixed) {
    console.error('[start.cjs] verify-abi: ABI mismatch detected and auto-rebuild failed.');
    console.error('[start.cjs] 请手动执行: npx electron-rebuild -f -w better-sqlite3');
    process.exit(1);
  }
  process.exit(0);
}

const [cmd, args] = commandMap[command];
if (!cmd) {
  console.error(`Unknown command: ${command}. Use dev|build|start|verify-abi.`);
  process.exit(1);
}

// 创建干净的环境
const env = { ...process.env };
// 关键:取消这两个变量
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;
if (process.platform === 'linux') {
  // 在 Linux 上,sandbox 经常需要 disable
  env.NO_SANDBOX = '1';
}

// 启动期 pre-check:better-sqlite3 的 NODE_MODULE_VERSION 是否匹配当前 Electron ABI。
// 早于所有 junction / RKMS_NO_JUNCTION / build-skip 分支,这样:
//   1) 错误信息里路径还指向原始 cwd(用户能一眼看出是项目目录,不是 LOCALAPPDATA junction)
//   2) 即使后面 junction / build-skip 改了 cwd,ABI 检查也已完成
//   3) 三个子命令 (dev/build/start) 统一受益
//
// mtime 嗅探不是 100% 准确(系统时钟回拨 / 同步工具篡改 mtime 会误判),
// 但 Electron 升级 + ABI 漂移是 mtime 漂移最常见的诱因,实战足够。
// 万一漏判,主进程 path-check.ts 还有第二道兜底 + 清晰错误提示。
//
// 拿到返回值:checkAndFixNativeAbi() 在探测+自动 rebuild 都失败时返回 false,
// 这种情况下继续 spawn electron-vite 会导致 Electron 主进程 dlopen better-sqlite3
// 抛 "Could not locate the bindings file",一路被 unhandledRejection 吞掉,最后
// 表现为"DB not initialized"—— 这正是这个 precheck 想避免的失败模式。
// dev/build/start 三个子命令都没有 pre* hook 走 verify-abi 子命令路径,所以必须
// 自己处理返回值。
if (checkAndFixNativeAbi() === false) {
  console.error('[start.cjs] better-sqlite3 ABI 不匹配且自动重建失败,中止启动。');
  console.error('[start.cjs] 请手动执行: npx electron-rebuild -f -w better-sqlite3');
  console.error('[start.cjs] 或:`npm run rebuild:native`(离线 / 工具链缺失请先看脚本输出)。');
  process.exit(1);
}

// 路径策略(2026-08-28 修订):ASCII junction 默认**关闭**,改为 RKMS_FORCE_JUNCTION=1 显式开启。
//
// 历史:D2-020 认为 Windows + CJK cwd 会让 better-sqlite3 dlopen 拿到 GBK 乱码路径,
// 于是在 %LOCALAPPDATA% 建 ASCII junction 再 chdir 进去。实测这个防御无效且有害:
//
//   1) 无效 —— Node 的模块解析默认走 realpath。从 junction 里 require('better-sqlite3')
//      仍然解析回真实 CJK 路径才 dlopen;junction 只改了 process.cwd(),没改最终传给
//      LoadLibraryEx 的路径。证据:junction 模式下 bindings 报错列出的全是 CJK 路径。
//
//   2) 有害 —— cwd(junction)与 vite 的 cacheDir(realpath 后的 CJK 路径)不同源。
//      vite 的 esbuildOutputFromId() 用 path.relative(process.cwd(), ...) 去匹配 esbuild
//      metafile 的 key,跨源匹配不上就返回 undefined,而调用方直接解引用 output.imports:
//        TypeError: Cannot read properties of undefined (reading 'imports')
//      dev server 整个进程崩掉。
//
//   3) 不必要 —— Electron 30 能直接 dlopen CJK 路径。verify-abi 探针就是在真实 CJK cwd 下
//      spawn electron.exe 跑 new Database(':memory:') 成功的。
//
// 万一某个 Windows / Electron 组合真的碰到 CJK dlopen 失败,用 RKMS_FORCE_JUNCTION=1 开回来
//(代价:vite optimizeDeps 可能重现上面的崩溃)。
let effectiveCwd = process.cwd();
if (process.platform === 'win32') {
  const originalCwd = process.cwd();

  if (process.env.RKMS_FORCE_JUNCTION === '1' && command === 'build') {
    // build 永不走 junction:vite 5 的 build-html transform 在 junction 下会把
    // renderer/index.html 解析回 CJK 绝对路径,抛 "The 'fileName' or 'name'
    // properties of emitted chunks and assets must be strings that are neither
    // absolute nor relative paths"。build 阶段也不 dlopen native module,没必要。
    console.log('[start.cjs] build 忽略 RKMS_FORCE_JUNCTION(与 vite build-html 不兼容)');
  } else if (process.env.RKMS_FORCE_JUNCTION === '1') {
    const junctionPath = setupWindowsJunction(originalCwd);
    if (!junctionPath) {
      console.error('[start.cjs] RKMS_FORCE_JUNCTION=1 但 junction 创建失败,见上方原因。');
      process.exit(1);
    }
    try {
      process.chdir(junctionPath);
      effectiveCwd = junctionPath;
      console.log(`[start.cjs] cwd -> ${junctionPath} (junction of ${originalCwd})`);
    } catch (e) {
      console.error('[start.cjs] chdir to junction failed:', e.message);
      process.exit(1);
    }
  } else if (originalCwd.length > 240) {
    // audit round 8 (2026-09-14):硬 fallback —— 之前只 warn,继续在超长 cwd
    //   里 spawn electron-vite,后面 native module dlopen / vite pre-transform
    //   才报错,失败模式不直观。修:超长路径直接走 junction 兜底,与
    //   RKMS_FORCE_JUNCTION=1 同条 setupWindowsJunction 路径,只是无 opt-in。
    //   junction 创建失败时再降级到 warn(老行为),让用户有最后机会绕开。
    const junctionPath = setupWindowsJunction(originalCwd);
    if (junctionPath) {
      try {
        process.chdir(junctionPath);
        effectiveCwd = junctionPath;
        console.log(
          `[start.cjs] cwd 长度 ${originalCwd.length} > 240,自动 junction 兜底: ${junctionPath}`,
        );
      } catch (e) {
        console.error('[start.cjs] chdir to junction failed:', e.message);
        process.exit(1);
      }
    } else {
      console.warn(`[start.cjs] 警告:cwd 长度 ${originalCwd.length} > 240,junction 兜底创建失败。`);
      console.warn('[start.cjs] 继续在原始 cwd 启动,可能遇到 native module 加载失败。');
    }
  }
}

// Windows 终端 codepage 已在文件顶部 chcp 65001 切到 UTF-8,这里再加一次是
// belt-and-suspenders:某些 spawn 场景下(罕见,比如 detached console)子进程
// 不一定继承父 codepage,在 spawn shell 里再切一次是 0 成本的保险。
let spawnCmd = cmd;
let spawnArgs = args;
if (process.platform === 'win32') {
  spawnCmd = `chcp 65001 >nul && ${cmd} ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`;
  spawnArgs = [];
}

// 把 effectiveCwd (junction 或原始 ASCII cwd) 透传给子进程。
// electron.vite.config.ts 读 RKMS_JUNCTION_PATH 加入 vite server.fs.allow,
// 解决 Windows + CJK 项目路径下 dev server pre-transform 抛
// "Failed to load url /src/main.tsx ... Does the file exist?"。
if (process.platform === 'win32' && effectiveCwd && /[A-Za-z]:\\/.test(effectiveCwd)) {
  env.RKMS_JUNCTION_PATH = effectiveCwd;
}

const child = spawn(spawnCmd, spawnArgs, {
  stdio: 'inherit',
  env,
  shell: true,
  cwd: effectiveCwd,
});

// audit r40 (2026-10-15):Ctrl+C / SIGTERM 时递归清子进程树。
//   之前只监听 child 'exit' / 'error',用户按 Ctrl+C 时 Node 收到 SIGINT,
//   但 shell:true 下 child.pid 是 cmd.exe 的 PID,Node 默认 SIGTERM 转发
//   只触达 cmd.exe —— cmd.exe 死后 electron.exe + 多个 vite + electron helper
//   进程**不一定**跟着挂(实测常留 5+ 个僵尸)。下次启动时:
//     1) electron Cache_Data 文件被旧实例锁 → "cache_util_win.cc: Unable
//        to move the cache: 拒绝访问" + 多个 Gpu Cache Creation failed
//     2) 多份 vite dev server 占 5173 / 5174 → "Port ... in use, trying
//        another one..." 落 5175
//   修:本进程收 SIGINT/SIGTERM/SIGHUP 时主动杀进程树。
//   详见 scripts/shutdown.cjs 头注。
//   child.on('exit') 仍保留作"子进程自己死掉"的兜底(spawn 链路本身异常
//   退出,父 Node 也要退出),但 shutdown 在前;两者用 shutdownInFlight 防
//   重入(防止 taskkill 触发的 child exit 又走 child.on('exit') 二次退出)。
let shutdownInFlight = false;
['SIGINT', 'SIGTERM', 'SIGHUP'].forEach((sig) => {
  process.on(sig, () => {
    if (shutdownInFlight) return;
    shutdownInFlight = true;
    shutdownTree(child, sig);
    // 立即给上层一个非 0 退出码,不等 child.on('exit') 兜底
    process.exit(128 + (sig === 'SIGINT' ? 2 : sig === 'SIGTERM' ? 15 : 1));
  });
});

// audit 2026-10-01:补 error 监听 + 修正信号退出码。
//   1) 只监听 exit 时,spawn 失败(EAGAIN/EMFILE、cmd.exe 被策略软件拦截、
//      cwd 不存在)产生的 'error' 事件无人处理 —— Node 会打一段内部栈,
//      与本文件其它分支精心设计的 "[start.cjs] ..." 中文提示风格割裂。
//   2) `code ?? 0` 把「被信号杀死」(code === null、signal 有值)吞成退出码 0,
//      于是 Ctrl+C / 任务管理器结束进程后 npm 看到的是成功,predev 链路
//      判定通过。信号退出应返回非 0。
child.on('error', (err) => {
  console.error('[start.cjs] 启动子进程失败:', err && err.message ? err.message : err);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (shutdownInFlight) {
    // shutdownTree 已写过 process.exit,这里不再二次调用,防状态错乱
    return;
  }
  if (signal) {
    // 被信号终止:signal 名(如 'SIGTERM')转成 128+n 是 shell 惯例
    const names = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 };
    process.exit(128 + (names[signal] || 1));
  }
  process.exit(code ?? 1);
});

/**
 * 在 %LOCALAPPDATA%\rkms-junctions\<hash16> 建一个指向 realCwd 的 junction。
 * 复用规则:
 *   - 已存在且指向 realCwd          → 直接返回
 *   - 已存在但指向别的目标            → 删除重建
 *   - 不存在                          → 创建
 *   - 已存在但不是 junction(实目录)    → 返回 null(让上层走错误分支)
 *   - 创建失败                         → 返回 null
 *
 * 可通过环境变量 RKMS_JUNCTION_DIR 覆盖父目录位置(给 LOCALAPPDATA 被 CJK 污染的场景用)。
 */
function setupWindowsJunction(realCwd) {
  // audit round 8 (2026-09-14):显式 win32 guard —— 函数名带 "Windows",且
  //   内部拼的是 Windows 专属的 %LOCALAPPDATA% 路径。加这条防御让函数自描述
  //   + 防未来跨平台误用。
  if (process.platform !== 'win32') {
    console.error('[start.cjs] setupWindowsJunction called on non-win32 platform');
    return null;
  }
  const customBase = process.env.RKMS_JUNCTION_DIR;
  // audit 2026-10-01:兜底从硬编码的 'C:\Users\guan'(原作者本机用户名)换成
  //   os.homedir()。原值有两处问题:一是把个人路径固化进要分发的脚本;
  //   二是 LOCALAPPDATA 与 USERPROFILE 都缺失时会去**别人的** profile 下
  //   建 junction,报出的错完全指不到真因。os.homedir() 走的是同样的系统
  //   解析(USERPROFILE → HOMEDRIVE+HOMEPATH → 兜底),不需要自己拼。
  const localAppData =
    process.env.LOCALAPPDATA ||
    path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'Local');
  // 用 sha256 前 16 位而非 8 位,降低多项目/重建路径时的碰撞概率
  const hash = crypto.createHash('sha256').update(realCwd).digest('hex').slice(0, 16);
  const baseDir = customBase || path.join(localAppData, 'rkms-junctions');
  const junctionDir = path.join(baseDir, hash);
  const parentDir = path.dirname(junctionDir);

  // 防御:junction 父目录自身不能含 CJK,否则 junction 路径还是坏的
  if (/[^\x00-\x7F]/.test(junctionDir)) {
    console.error(`[start.cjs] Computed junction path contains non-ASCII: ${junctionDir}`);
    console.error('[start.cjs] Check your LOCALAPPDATA / RKMS_JUNCTION_DIR environment variable.');
    return null;
  }

  // 1. 检查是否已存在
  try {
    const lst = fs.lstatSync(junctionDir);
    if (lst.isDirectory()) {
      let target = null;
      try {
        target = fs.readlinkSync(junctionDir);
      } catch {
        // 路径是目录但不是 junction/link → 冲突,不让 start.cjs 误删用户数据
        console.error(`[start.cjs] ${junctionDir} exists but is not a junction.`);
        console.error(
          '[start.cjs] Remove it manually, or set RKMS_JUNCTION_DIR to a fresh ASCII dir.',
        );
        return null;
      }
      if (path.resolve(target) === path.resolve(realCwd)) {
        console.log(`[start.cjs] Reusing junction: ${junctionDir}`);
        return junctionDir;
      }
      // 指向别的目标 → 删了重建
      console.log(`[start.cjs] Removing stale junction ${junctionDir} (-> ${target})`);
      try {
        fs.rmSync(junctionDir, { recursive: true, force: true });
      } catch (e) {
        console.error(`[start.cjs] Failed to remove stale junction:`, e.message);
        return null;
      }
    } else {
      // 路径存在但不是目录(可能是文件) → 删掉后重建
      console.log(`[start.cjs] Removing non-directory at ${junctionDir}`);
      try {
        fs.unlinkSync(junctionDir);
      } catch (e) {
        console.error(`[start.cjs] Failed to unlink non-directory:`, e.message);
        return null;
      }
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error(`[start.cjs] Junction probe failed:`, e.message);
      return null;
    }
    // 不存在 → 继续创建
  }

  // 2. 确保父目录存在
  try {
    fs.mkdirSync(parentDir, { recursive: true });
  } catch (e) {
    console.error(`[start.cjs] Failed to create parent dir ${parentDir}:`, e.message);
    return null;
  }

  // 3. 建 junction
  try {
    // mklink /J 是 cmd 内置,必须经 cmd.exe 调用
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', junctionDir, realCwd], { stdio: 'pipe' });
    console.log(`[start.cjs] Created junction: ${junctionDir} -> ${realCwd}`);

    // 4. 创建后立刻验证 — 极少数情况下 mklink 成功但 readlink 行为异常
    try {
      const verify = fs.readlinkSync(junctionDir);
      if (path.resolve(verify) !== path.resolve(realCwd)) {
        console.error(`[start.cjs] Junction created but verification failed:`);
        console.error(`  expected -> ${realCwd}`);
        console.error(`  got      -> ${verify}`);
        return null;
      }
    } catch (e) {
      console.error(`[start.cjs] Junction verify readlink failed:`, e.message);
      return null;
    }

    return junctionDir;
  } catch (e) {
    // execFileSync 失败时 e.stderr 是 cmd 输出的多行文本(GBK/UTF-8 都有)
    const stderr = e.stderr ? e.stderr.toString().trim() : e.message;
    console.error(`[start.cjs] mklink failed:`);
    console.error(`  ${stderr.replace(/\r?\n/g, '\n  ')}`);
    return null;
  }
}

/**
 * 在 Electron 子进程里 try-load better-sqlite3 —— 这是判断 ABI 是否匹配最可靠的信号。
 * 之前用 .node mtime vs electron.exe mtime 的方案有致命缺陷:electron-rebuild 解包
 * prebuilt 后 mtime 永远是 2025-05-08(打包时间),无论 ABI 是否对齐,导致每次启动
 * 都误判为 mismatch 而陷入 rebuild 死循环。
 *
 * 思路:用 spawnSync 起一个 electron.exe,设 ELECTRON_RUN_AS_NODE=1 让它像 node 一样
 * 执行 probe 脚本。脚本里 require('better-sqlite3') + new Database(':memory:'),成功就
 * exit 0,失败就 exit 1。这跑的是 Electron 内嵌的 Node,ABI 与主进程完全一致 —— 与主
 * 进程 dlopen 是同一个动作的子集。
 *
 * @returns {{ok: boolean, reason?: string}}
 */
function probeBetterSqliteInElectron() {
  let electronExePath;
  try {
    // 普通 node 进程下 require('electron') 返回 electron.exe 的字符串绝对路径
    electronExePath = require('electron');
  } catch {
    return { ok: true, reason: 'electron module not resolvable (skipped)' };
  }
  if (typeof electronExePath !== 'string' || !fs.existsSync(electronExePath)) {
    return { ok: true, reason: 'electron binary not at expected path (likely packaged; skipped)' };
  }

  const probeScript = [
    'try {',
    "  const Db = require('better-sqlite3');",
    "  const db = new Db(':memory:');",
    '  db.close();',
    '  process.exit(0);',
    '} catch (e) {',
    "  process.stderr.write('ABI_PROBE_FAIL: ' + (e && e.message ? e.message : String(e)));",
    '  process.exit(1);',
    '}',
  ].join('\n');

  let result;
  try {
    result = spawnSync(electronExePath, ['--no-deprecation', '-e', probeScript], {
      cwd: process.cwd(),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      timeout: 30000,
    });
  } catch (e) {
    return { ok: false, reason: 'spawn failed: ' + (e.message || String(e)) };
  }

  if (result.error) {
    return { ok: false, reason: 'spawn error: ' + result.error.message };
  }
  if (result.status === 0) {
    return { ok: true };
  }
  const reason =
    (result.stderr || result.stdout || '').toString().trim() || `exit ${result.status}`;
  return { ok: false, reason };
}

/**
 * 检测 better-sqlite3 的 .node 是否匹配当前 Electron 内嵌 Node 的 ABI。
 * 不匹配时(典型场景:升级了 Electron 但没重跑 npm install,postinstall 跳过)自动 rebuild。
 *
 * 依赖 probeBetterSqliteInElectron() —— 真正加载一次来确认 ABI。
 * mtime 比较不可靠(prebuilt mtime 永远是打包时间),所以这里不再做。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.silent=false] verify-abi 子命令用 — 不打警告只返回结果
 * @returns {boolean} true = OK 或已修复;false = 检测到 mismatch 但修复失败
 */
function checkAndFixNativeAbi(opts = {}) {
  const { silent = false } = opts;

  // Linux/macOS 上 .node 由 better-sqlite3 的 prebuilt 直接发,napi v3 跨 Node 版本 ABI 一致;
  // 只在 Windows 上有可能出现 postinstall 装错 .node 的历史问题。
  if (process.platform !== 'win32') return true;

  const cwd = process.cwd();
  const sqlitePath = path.resolve(
    cwd,
    'node_modules',
    'better-sqlite3',
    'build',
    'Release',
    'better_sqlite3.node',
  );

  // .node 缺失时**不能**放行。
  // 旧逻辑在这里 return true(理由是"第一次 install,交给 postinstall"),但 postinstall
  // 只在 npm install 时跑。一旦 build/ 被清空、或 electron-builder install-app-deps 静默失败,
  // predev 的 verify-abi 就一路绿灯,直到主进程 dlopen 才炸 "Could not locate the bindings
  // file" —— 而且是在后台 DB init 里被吞成 unhandledRejection + 满屏 "DB not initialized",
  // 根因离现场很远。所以:缺失 == 需要 rebuild,和 ABI 不匹配走同一条修复路径。
  let reason;
  if (!fs.existsSync(sqlitePath)) {
    reason = `missing ${path.relative(cwd, sqlitePath)}`;
  } else {
    // 真正的 ABI 检查 —— 在 Electron 子进程里 try-load
    const probe = probeBetterSqliteInElectron();
    if (probe.ok) {
      if (!silent && probe.reason && probe.reason.includes('skipped')) {
        console.log(`[start.cjs] ABI check: ${probe.reason}`);
      }
      return true;
    }
    reason = probe.reason || 'unknown';
  }

  if (!silent) {
    console.warn('');
    console.warn('=====================================================');
    console.warn('[start.cjs] better-sqlite3 native binding unusable:');
    console.warn(`  ${reason}`);
    console.warn('[start.cjs] Rebuilding better-sqlite3 against current Electron ABI...');
    console.warn('=====================================================');
  }

  try {
    execFileSync(
      process.execPath,
      // --no-snapshot:走到这里说明当前 .node 已经确认不可用(缺失或 ABI 不匹配),
      // 不能把它快照成"上一个可用版本",否则会覆盖掉真正可用的那份快照。
      [path.resolve(__dirname, 'rebuild-native.cjs'), '--no-snapshot'],
      { stdio: silent ? 'pipe' : 'inherit' },
    );
  } catch (e) {
    if (silent) {
      // verify-abi 路径:失败时仍输出 stderr 让 caller 看到 rebuild-native 的报错
      if (e.stderr) process.stderr.write(e.stderr);
      if (e.stdout) process.stdout.write(e.stdout);
    } else {
      console.error('[start.cjs] Auto-rebuild failed.');
      console.error('  请手动执行:  npx electron-rebuild -f -w better-sqlite3');
      console.error('  或:           npm run rebuild:native');
    }
    return false;
  }

  // Rebuild 完再 probe 一次,确认真的修好了 (理论上 rebuild 不会失败,但保险)
  const recheck = probeBetterSqliteInElectron();
  if (recheck.ok) {
    if (!silent) console.log('[start.cjs] Rebuild succeeded, ABI matches.');
    return true;
  }
  if (!silent) {
    console.error('[start.cjs] Rebuild completed but ABI still mismatches:');
    console.error(`  ${recheck.reason || 'unknown'}`);
    console.error('  建议手动执行:  npm rebuild better-sqlite3');
  }
  return false;
}
