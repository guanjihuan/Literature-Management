// scripts/shutdown.cjs
//
// audit r40 (2026-10-15):抽出 start.cjs 的子进程树清理逻辑,便于 vitest
//   单元测试(start.cjs 自身是顶层脚本,直接 require 会副作用跑整个 dev
//   链路,不便测)。
//
// 设计目标:
//   - 输入 child (Node ChildProcess-like,需要 .pid 字段) + 可选 signal
//   - Windows 走 taskkill /F /T /PID;POSIX 走 process.kill(-pid, ...)
//   - 1500ms 后 SIGKILL 兜底
//   - 任意抛错 swallow(启动期容错,本 helper 不该再抛出)
//
// 注意:Windows 上 Node 不支持 process.kill(-pid) 的 process group 语义,
//   POSIX 分支仅在非 win32 跑;Windows 必须走 taskkill,负 PID 在 win32 上
//   会 ESRCH,这是已知差异。

const { spawnSync } = require('child_process');

/**
 * 递归杀进程树。
 * @param {{ pid?: number }} child : 需要 .pid;可无(空对象 → no-op)
 * @param {string} [signalName] : POSIX 下首次发的信号;默认 'SIGTERM'
 * @param {object} [opts]
 * @param {string} [opts.platform] : 默认 process.platform;测时 mock
 * @param {(pid: number) => unknown} [opts.posixGroupKill] : POSIX 杀进程的 helper;默认 process.kill
 * @param {() => void} [opts.posixEscalate] : 1500ms 升级到 SIGKILL 的 schedule;默认 setTimeout
 * @returns {{ killed: boolean, method: 'taskkill'|'posix'|'noop' }}
 */
function shutdownTree(child, signalName, opts) {
  const pid = child && child.pid;
  // PID 0 是 kernel idle process,不可能是 user-space child;统一视为 noop
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) {
    return { killed: false, method: 'noop' };
  }

  const platform = (opts && opts.platform) || process.platform;
  const posixGroupKill = (opts && opts.posixGroupKill) || ((p) => process.kill(p));
  const posixEscalate = (opts && opts.posixEscalate) || ((fn) => setTimeout(fn, 1500));

  if (platform === 'win32') {
    try {
      // windowsHide: 子进程在父 console handle 内隐藏,不弹黑色 cmd 窗口
      spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
        stdio: 'ignore',
        windowsHide: true,
      });
      return { killed: true, method: 'taskkill' };
    } catch {
      // taskkill 自身失败 —— child 大概率已死,fallthrough
      return { killed: false, method: 'taskkill' };
    }
  }

  // POSIX:负 PID = process group(shell:true 时 child.pid 是 cmd 的 PID,
  //   cmd 自己起的 electron + vite 子进程都在同一 group)
  try {
    posixGroupKill(-pid, signalName || 'SIGTERM');
    posixEscalate(() => {
      try {
        posixGroupKill(-pid, 'SIGKILL');
      } catch {
        // already exited
      }
    });
    return { killed: true, method: 'posix' };
  } catch {
    // ESRCH = group 已不存在
    return { killed: false, method: 'posix' };
  }
}

module.exports = { shutdownTree };
