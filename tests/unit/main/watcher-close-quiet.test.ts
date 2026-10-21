// tests/unit/main/watcher-close-quiet.test.ts
//
// 守 r216「关掉 chokidar watcher 后,晚到的 awaitWriteFinish 轮询错误不得
// 变成主进程 uncaught exception」契约。
//
// 根因(chokidar 4.0.3 源码实证):
//   - awaitWriteFinish 的轮询是 setTimeout 链,不在 close() 清理范围内;
//   - close() 第一行 removeAllListeners();
//   - 轮询晚到时文件已被删/搬走 ⇒ stat 报错;Windows 对 pending-delete
//     路径报 EPERM(不是 ENOENT)⇒ chokidar 只容忍 ENOENT,其余走
//     awfEmit(err) ⇒ emit('error') ⇒ 无监听者 ⇒ EventEmitter 同步 throw。
//   本仓库基线实测:全量跑测时 folder-scoped-file-ops.test.ts 的 teardown
//   删临时目录,晚到轮询炸出 2 例 uncaught exception(EPERM stat)。
//
// 修法 = closeWatcherQuietly:close 之后在已弃实例上补挂 noop 'error' 监听,
// 给迟到事件一个去处。本测试从两个方向锁:
//   1. 确定性单元锁:close 后 emit('error') 不再 throw(无监听时必 throw);
//   2. 真时序回归:轮询窗口内 close + 递归删目录 ⇒ 修前此处以 uncaught
//      exception 形式炸(vitest 记 Errors),修后安然。
import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import chokidar, { type FSWatcher } from 'chokidar';
import { closeWatcherQuietly } from '../../../src/main/utils/watcher-release';

describe('closeWatcherQuietly(r216)—— 晚到的 watcher 错误不炸主进程', () => {
  const dirs: string[] = [];
  const watchers: FSWatcher[] = [];

  afterEach(async () => {
    // 兜底清理:就算断言中途失败也不把临时目录/句柄留给下一个用例
    await Promise.all(watchers.splice(0).map((w) => closeWatcherQuietly(w).catch(() => {})));
    await Promise.all(
      dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})),
    );
  });

  it('close 后实例上迟到 error 事件不再 throw(EventEmitter 对无监听者的 error 是同步 throw)', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'rkms-wcloseq-'));
    dirs.push(dir);
    const w = chokidar.watch(dir, { ignoreInitial: true });
    watchers.push(w);

    await closeWatcherQuietly(w);

    // 修前:close() 已 removeAllListeners ⇒ 这一行同步 throw;
    // 修后:noop 监听兜底 ⇒ 安然。这正是 chokidar awfEmit(err) 晚到时的
    // 真实调用形态(w.emit('error', err))。
    expect(() => w.emit('error', new Error('EPERM: late awaitWriteFinish stat'))).not.toThrow();
  });

  it('close 本身的失败仍然透传给调用方(静默 close 错误 = 句柄泄漏无人知)', async () => {
    const fake = {
      close: async (): Promise<void> => {
        throw new Error('boom');
      },
      on: (): unknown => fake,
    } as unknown as FSWatcher;

    await expect(closeWatcherQuietly(fake)).rejects.toThrow('boom');
  });

  it('close 失败时 noop 监听照样补上(finally 语义)', async () => {
    let errorListenerCount = 0;
    const fake = {
      close: async (): Promise<void> => {
        throw new Error('boom');
      },
      on: (event: string): unknown => {
        if (event === 'error') errorListenerCount += 1;
        return fake;
      },
    } as unknown as FSWatcher;

    await expect(closeWatcherQuietly(fake)).rejects.toThrow('boom');
    expect(errorListenerCount).toBe(1);
  });

  it('真时序回归:awaitWriteFinish 轮询窗口内 close + 递归删目录,无 uncaught', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'rkms-wcloseq-'));
    dirs.push(dir);
    const w = chokidar.watch(dir, {
      ignoreInitial: true,
      // 与 notes/service.ts 同量级的窗口(50/25),拉长 stabilityThreshold
      // 保证 close 时轮询链一定还活着
      awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 25 },
    });
    watchers.push(w);
    await new Promise<void>((resolve) => w.on('ready', () => resolve()));

    await fs.writeFile(join(dir, 'a.md'), 'hello');
    // 等 chokidar 检测到这次 add 并进入 awaitWriteFinish 轮询窗口。
    // 用户态 'add' 事件要等稳定(400ms)后才发,不能等它;给 readdirp
    // 检测 + 首个轮询周期足够余量即可。
    await new Promise((r) => setTimeout(r, 150));

    await closeWatcherQuietly(w);
    // 目录递归删除 ⇒ 仍在轮询的 stat 撞 Windows pending-delete ⇒ EPERM
    // (chokidar 只容忍 ENOENT)⇒ 修前:emit('error') 无监听 ⇒ uncaught;
    // 撞上时本用例的「红」形式就是 vitest 报告 Uncaught Exception(基线
    // 实测 2 例)。诚实说明:EPERM 只在 stat 与 rm 并发时出现(rm 先删
    // 文件,之后的 stat 是 ENOENT 被 chokidar 静默)⇒ 竞态部分是冒烟;
    // 确定性部分是下面的硬断言。
    await fs.rm(dir, { recursive: true, force: true });
    dirs.splice(dirs.indexOf(dir), 1);

    // 放过足够多轮询周期,让晚到错误有机会炸出来
    await new Promise((r) => setTimeout(r, 500));

    // 确定性硬断言(防空过):真 FSWatcher 在 close 摘光监听之后,
    // noop error 监听必须已补挂 —— 这是晚到错误不炸的唯一依靠
    expect(w.listenerCount('error')).toBeGreaterThanOrEqual(1);
  });
});
