// tests/unit/main/watcher-restart-budget.test.ts
//
// 守 r197「watcher 连续失败上限」的真���语义。
//
// 旧实现:`watcherRestartAttempts` 只在 `start()` / `stop()` 里清零 ——
// 于是「连续失败上限」实际是**终身**预算:
//   - 用户在一个长会话里遭遇 6 次**孤立**的 watcher 错误(网络盘抖一下 /
//     OneDrive 同步冲突 / Defender 扫一下 / 目录被临时改名),每次都成功
//     重启、每次都正常工作 —— 计数却一路累加;
//   - 第 6 次错误时计数越过上限 ⇒ 永久放弃 watcher(只在日志里,UI 无提示)
//     ⇒ 之后**所有**外部改动都不再被感知 —— 用户看到的是「我在资源管理器
//     里改了文件,应用里的列表一直不动」。
//
// 上限本身要留着(永久坏路径下 2s 一轮的 log 风暴是真实问题),所以修法不是
// 删上限,而是让「连续」名副其实:重启成功并**健康存活一段时间**后,计数
// 清零;而「起来就又报错」不算健康(清零 ⇒ 无限重试 ⇒ 上限形同虚设)。
//
// 本测是行为级守卫:mock chokidar(不依赖真实文件系统事件),用 fake timers
// 精确推进 2s 退避与 30s 健康期。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const repo = vi.hoisted(() => ({
  upsertResource: vi.fn(),
  deleteResource: vi.fn(),
  listResources: vi.fn(() => [] as unknown[]),
  listResourceRelPaths: vi.fn(() => [] as string[]),
  listStaleIndexIds: vi.fn(() => [] as string[]),
  renameResource: vi.fn(),
}));

vi.mock('../../../src/main/db/resources-repo', () => ({
  upsertResource: repo.upsertResource,
  deleteResource: repo.deleteResource,
  listResources: repo.listResources,
  listResourceRelPaths: repo.listResourceRelPaths,
  listStaleIndexIds: repo.listStaleIndexIds,
  renameResource: repo.renameResource,
}));

vi.mock('electron', () => ({
  shell: { trashItem: async () => undefined },
}));

interface FakeWatcher {
  on(ev: string, fn: (p?: unknown) => void): FakeWatcher;
  removeAllListeners(): void;
  close(): Promise<void>;
  __emit(ev: string, p?: unknown): void;
}

const chok = vi.hoisted(() => ({ watchers: [] as FakeWatcher[] }));

vi.mock('chokidar', () => {
  const make = (): FakeWatcher => {
    const handlers = new Map<string, Array<(p?: unknown) => void>>();
    const w: FakeWatcher = {
      on(ev, fn) {
        const arr = handlers.get(ev) ?? [];
        arr.push(fn);
        handlers.set(ev, arr);
        return w;
      },
      removeAllListeners() {
        handlers.clear();
      },
      close: async () => undefined,
      __emit(ev, p) {
        for (const fn of [...(handlers.get(ev) ?? [])]) fn(p);
      },
    };
    chok.watchers.push(w);
    return w;
  };
  return { default: { watch: make }, watch: make };
});

import { setRootPath } from '../../../src/main/utils/safe-write';
import { NotesService } from '../../../src/main/notes/service';
import { LiteratureService } from '../../../src/main/literature/literature-service';

const RESTART_DELAY_MS = 2000;
const HEALTHY_MS = 30_000;

/** 让当前 watcher 报一次错,并推进 2s 让重启发生。
 *  healthyGapMs > 0 时再推进健康期(让计数有机会清零)。 */
async function failOnce(healthyGapMs = 0): Promise<void> {
  const w = chok.watchers[chok.watchers.length - 1];
  w.__emit('error', new Error('watcher boom'));
  await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS);
  if (healthyGapMs > 0) {
    await vi.advanceTimersByTimeAsync(healthyGapMs);
  }
}

describe('watcher 连续失败上限(r197)', () => {
  let root: string;

  beforeEach(async () => {
    chok.watchers.length = 0;
    vi.useFakeTimers();
    root = await fs.mkdtemp(join(tmpdir(), 'rkms-watchbudget-'));
    setRootPath(root);
    await fs.mkdir(join(root, 'notes'), { recursive: true });
    await fs.mkdir(join(root, 'literature'), { recursive: true });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('notes:连续 6 次错误(每次都活不过健康期)→ 第 6 次放弃 watcher', async () => {
    const svc = new NotesService();
    let gaveUp = 0;
    svc.on('watcher-failed', () => {
      gaveUp += 1;
    });
    await svc.start({ skipInitialLoad: true });

    for (let i = 0; i < 5; i++) await failOnce(0);
    expect(gaveUp).toBe(0); // 前 5 次还在重试预算内
    await failOnce(0);
    expect(gaveUp).toBe(1); // 第 6 次越限 → 放弃

    await svc.stop();
  });

  it('notes:6 次孤立错误(每次都健康存活 30s)→ 不放弃 watcher', async () => {
    const svc = new NotesService();
    let gaveUp = 0;
    svc.on('watcher-failed', () => {
      gaveUp += 1;
    });
    await svc.start({ skipInitialLoad: true });

    // 每次错误都隔着「重启 + 30s 健康期」—— 计数器应当每次都归零
    for (let i = 0; i < 6; i++) await failOnce(HEALTHY_MS);
    expect(gaveUp).toBe(0);

    await svc.stop();
  });

  it('literature:6 次孤立错误(每次都健康存活 30s)→ 不放弃 watcher', async () => {
    const svc = new LiteratureService();
    let gaveUp = 0;
    svc.on('watcher-failed', () => {
      gaveUp += 1;
    });
    await svc.start({ skipInitialLoad: true });

    for (let i = 0; i < 6; i++) await failOnce(HEALTHY_MS);
    expect(gaveUp).toBe(0);

    await svc.stop();
  });

  it('literature:连续 6 次错误 → 第 6 次放弃(上限语义不变)', async () => {
    const svc = new LiteratureService();
    let gaveUp = 0;
    svc.on('watcher-failed', () => {
      gaveUp += 1;
    });
    await svc.start({ skipInitialLoad: true });

    for (let i = 0; i < 5; i++) await failOnce(0);
    expect(gaveUp).toBe(0);
    await failOnce(0);
    expect(gaveUp).toBe(1);

    await svc.stop();
  });
});
