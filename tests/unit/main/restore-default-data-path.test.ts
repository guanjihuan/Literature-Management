// tests/unit/main/restore-default-data-path.test.ts
//
// 守卫 r205:「恢复默认数据目录」按钮以前是**死的**。
//
// ── 被守卫的缺陷(用户可见)──────────────────────────────────────────
//   设置页的「恢复默认数据目录」走 IPC SETTINGS_RESTORE_DEFAULT_DATA →
//   switchDataPath(defaultDataPath())。而 switchDataPath → changeDataPath
//   **要求目标目录为空**(r56 的 HIGH 修复:绝不对用户自有的非空目录 rm -rf):
//
//     const existing = await fs.readdir(newPath, …);
//     if (existing.length > 0) throw new AppError('VALIDATION',
//       `target directory must be empty: ${newPath} (contains N entries)`);
//
//   但默认位置 (<Documents>/ResearchHub/data) 里恰恰躺着**上一次工作区的
//   副本** —— 因为 changeDataPath 是**复制**(旧目录原样保留,r204 头注已
//   记录这一点)。⇒ 用户只要曾经把工作区搬离默认位置,这个按钮就**永久
//   失效**,而且报的是一句用户看不懂的 "target directory must be empty"。
//
// ── 本测锁的契约 ───────────────────────────────────────────────────
//   A1/A2 默认目录不存在 / 为空 → 恢复成功(旧行为不变)。
//   A3 默认目录**非空**(装着上一次的旧副本)→ 恢复**必须成功**,且:
//        - 新默认目录里是**当前**工作区的内容(不是旧副本的);
//        - 旧副本**没被删**,只是被改名让开(仍在磁盘上,一个字节都没丢);
//        - 旧副本**不在原地**(否则下次恢复又会撞上同一个非空检查)。
//   A4 当前工作区**就是**默认目录 → 整个流程 no-op(绝不能把工作区自己
//      让开 —— 那是灾难性数据丢失)。
//   A5 当前工作区在默认目录**之内** → 拒绝(同样是「会让开会带走工作区」)。
//   A6 恢复失败 → 旧副本仍在 aside 位置,且**错误消息里带出那个路径**
//      (用户据此能找回自己的数据)。
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import { basename, join } from 'path';
import { tmpdir } from 'os';

const state = vi.hoisted(() => ({
  failCopy: false,
  writeLocation: vi.fn(async (_p: string) => {}),
  listResources: vi.fn(() => [] as unknown[]),
}));

vi.mock('electron', () => ({
  app: {
    getVersion: () => '9.9.9-test',
    getPath: () => 'C:\\fake-user-data',
    getName: () => 'rkms-test',
  },
  shell: {
    trashItem: async () => undefined,
  },
}));

// location 模块整体 mock:默认路径指向临时目录(真实默认路径在
// <Documents>/ResearchHub/data,测试不可写),writeLocation 不落盘。
//
// ⚠ 临时根必须**每次跑测唯一**(mkdtemp),不能用固定目录名 + 递归删。
//   固定名会让两次并发的跑测(CI 分片 / watch 重跑 / 两个 checkout 同时跑)
//   互删对方正在用的目录树 ⇒ 一片 ENOENT / ENOTEMPTY 假红。
//   实测(2026-10-20):一条命令跑全量、另一条命令单跑本文件 ⇒ 本文件
//   4 例红(ENOENT chmod '…\default\notes' / ENOENT scandir '…\current' /
//   ENOTEMPTY rmdir '…\default'),单跑与全量各自都绿。
//   守卫:tests/unit/main/lint/no-fixed-temp-dir.test.ts
const TMP = await fs.mkdtemp(join(tmpdir(), 'rkms-r205-'));
const PATHS = {
  current: join(TMP, 'current'),
  def: join(TMP, 'default'),
};

vi.mock('../../../src/main/location', () => ({
  defaultDataPath: () => PATHS.def,
  writeLocation: state.writeLocation,
}));

vi.mock('../../../src/main/db/sqlite', () => ({
  closeDB: () => {},
  initDB: () => {},
}));

// resources-repo 整体 mock:文献 id 重算(r204)在测试里是空转。
vi.mock('../../../src/main/db/resources-repo', () => ({
  listResources: state.listResources,
  renameResource: () => {},
}));

vi.mock('../../../src/main/notes/service', () => ({
  getNotesService: () => ({
    start: async () => {},
    stop: async () => {},
  }),
}));

vi.mock('../../../src/main/workspace/favorites', () => ({
  getFavoritesService: () => ({
    start: async () => {},
    stop: async () => {},
    remapIds: async () => 0,
  }),
}));

vi.mock('../../../src/main/literature/literature-service', () => ({
  getLiteratureService: () => ({
    start: async () => {},
    stop: async () => {},
  }),
}));

// settings/store:保留**真的** changeDataPath(复制逻辑是被测对象),
//只把与本用例无关的 settings 内存态/DB 初始化 mock 掉。
vi.mock('../../../src/main/settings/store', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../../src/main/settings/store')
  >();
  return {
    ...actual,
    changeDataPath: async (newPath: string, currentPath: string) => {
      if (state.failCopy) throw new Error('copy failed (test)');
      return actual.changeDataPath(newPath, currentPath);
    },
    initSettings: async () => ({}),
    resetSettings: () => ({}),
    captureSettingsSnapshot: () => ({}),
  };
});

import { getRootPath, setRootPath } from '../../../src/main/utils/safe-write';
import { restoreDefaultDataPath } from '../../../src/main/settings/migration';

async function writeFile(p: string, content: string): Promise<void> {
  await fs.mkdir(join(p, '..'), { recursive: true });
  await fs.writeFile(p, content, 'utf-8');
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** 默认目录被「让开」后留下的兄弟目录: <def>.replaced-<ts> */
async function asideDirs(): Promise<string[]> {
  const parent = join(PATHS.def, '..');
  const prefix = `${basename(PATHS.def)}.replaced-`;
  const entries = await fs.readdir(parent);
  return entries.filter((e) => e.startsWith(prefix)).map((e) => join(parent, e));
}

async function resetWorkspace(): Promise<void> {
  // 清掉上一个用例留下的残骸 —— TMP 名字每次跑测唯一,这里只会清掉本次
  // 自己造的东西,不会误伤并发的另一轮跑测。
  await fs.rm(TMP, { recursive: true, force: true });
  await fs.mkdir(TMP, { recursive: true });
  // 当前工作区:一个笔记 + 一份 settings.json(changeDataPath 复制时
  // 必须读得到它,读不到会直接失败)
  await writeFile(join(PATHS.current, 'notes', 'live.md'), 'live note');
  await writeFile(join(PATHS.current, 'settings.json'), '{"rootPath":"x"}');
  setRootPath(PATHS.current);
}

describe('恢复默认数据目录(r205)', () => {
  beforeEach(async () => {
    state.failCopy = false;
    state.writeLocation.mockClear();
    state.listResources.mockClear();
    state.listResources.mockReturnValue([]);
    await resetWorkspace();
  });

  afterEach(() => {
    setRootPath(PATHS.current);
  });

  // 跑完把这次唯一的临时根删掉(不留残骸在系统临时目录里)
  afterAll(async () => {
    await fs.rm(TMP, { recursive: true, force: true });
  });

  // === A. 旧行为不变的两条 ===
  it('A1 默认目录不存在 → 恢复成功,当前工作区被复制过去', async () => {
    await restoreDefaultDataPath();

    expect(getRootPath()).toBe(PATHS.def);
    expect(await fs.readFile(join(PATHS.def, 'notes', 'live.md'), 'utf-8')).toBe('live note');
    expect(state.writeLocation).toHaveBeenCalledWith(PATHS.def);
    expect(await asideDirs()).toEqual([]);
  });

  it('A2 默认目录存在但为空 → 恢复成功', async () => {
    await fs.mkdir(PATHS.def, { recursive: true });

    await restoreDefaultDataPath();

    expect(getRootPath()).toBe(PATHS.def);
    expect(await fs.readFile(join(PATHS.def, 'notes', 'live.md'), 'utf-8')).toBe('live note');
  });

  // === B. 核心:默认目录非空(装着上一次的旧副本) ===
  it('A3 默认目录非空 → 恢复成功;新目录是当前工作区;旧副本没丢,只是让开了', async () => {
    // 上一次工作区留在默认位置的残骸
    await writeFile(join(PATHS.def, 'notes', 'stale.md'), 'stale note');
    await writeFile(join(PATHS.def, 'settings.json'), '{"rootPath":"stale"}');

    await restoreDefaultDataPath();

    // 恢复成功,root 指向默认目录
    expect(getRootPath()).toBe(PATHS.def);
    // 新默认目录里是**当前**工作区的内容
    expect(await fs.readFile(join(PATHS.def, 'notes', 'live.md'), 'utf-8')).toBe('live note');
    expect(await exists(join(PATHS.def, 'notes', 'stale.md'))).toBe(false);
    // 旧副本**没被删**:让开到兄弟目录,内容还在
    const aside = await asideDirs();
    expect(aside).toHaveLength(1);
    expect(await fs.readFile(join(aside[0], 'notes', 'stale.md'), 'utf-8')).toBe('stale note');
    // 旧副本**不在原地**(否则下次恢复又撞上同一个非空检查)
    expect(await exists(join(PATHS.def, 'notes', 'stale.md'))).toBe(false);
  });

  // === C. 两条「绝不能把工作区让开」的防线 ===
  it('A4 当前工作区就是默认目录 → no-op(绝不把工作区自己让开)', async () => {
    // 工作区**就是**默认目录
    await fs.rm(PATHS.current, { recursive: true, force: true });
    await writeFile(join(PATHS.def, 'notes', 'live.md'), 'live note');
    await writeFile(join(PATHS.def, 'settings.json'), '{"rootPath":"x"}');
    setRootPath(PATHS.def);

    await restoreDefaultDataPath();

    // 原封不动
    expect(await fs.readFile(join(PATHS.def, 'notes', 'live.md'), 'utf-8')).toBe('live note');
    expect(await asideDirs()).toEqual([]);
    expect(state.writeLocation).not.toHaveBeenCalled();
    expect(getRootPath()).toBe(PATHS.def);
  });

  it('A5 当前工作区在默认目录之内 → 拒绝,且默认目录内容一动不动', async () => {
    const inner = join(PATHS.def, 'inner');
    await writeFile(join(inner, 'notes', 'live.md'), 'live note');
    await writeFile(join(PATHS.def, 'notes', 'stale.md'), 'stale note');
    setRootPath(inner);

    await expect(restoreDefaultDataPath()).rejects.toThrow();

    // 默认目录没被让开、没被删
    expect(await fs.readFile(join(PATHS.def, 'notes', 'stale.md'), 'utf-8')).toBe('stale note');
    expect(await fs.readFile(join(inner, 'notes', 'live.md'), 'utf-8')).toBe('live note');
    expect(await asideDirs()).toEqual([]);
  });

  // === D. 失败路径:不许丢数据,也不许让用户「数据没了」还不知道 ===
  it('A6 恢复失败 → 旧副本仍在 aside,错误消息里带出那个路径', async () => {
    await writeFile(join(PATHS.def, 'notes', 'stale.md'), 'stale note');
    state.failCopy = true;

    const err = await restoreDefaultDataPath().then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    const aside = await asideDirs();
    expect(aside).toHaveLength(1);
    // 旧副本内容还在
    expect(await fs.readFile(join(aside[0], 'notes', 'stale.md'), 'utf-8')).toBe('stale note');
    // 消息里给出 aside 路径(用户据此能找回自己的数据)
    expect(message).toContain(aside[0]);
  });

  // === E. 不变式:本轮只给「恢复默认」开特例,没有削弱 MIGRATE 的防线 ===
  it('A7 用户自选的非空目标目录仍然被拒绝(「目标目录必须为空」没被削弱)', async () => {
    const target = join(TMP, 'user-target');
    await writeFile(join(target, 'photo.jpg'), 'x');

    const { changeDataPath } = await import('../../../src/main/settings/store');
    await expect(changeDataPath(target, PATHS.current)).rejects.toThrow(/must be empty/);

    // 用户自己目录里的东西一个字节都没动(r56 的 HIGH 不变式)
    expect(await fs.readFile(join(target, 'photo.jpg'), 'utf-8')).toBe('x');
  });
});
