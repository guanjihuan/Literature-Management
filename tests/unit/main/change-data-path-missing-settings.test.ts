// tests/unit/main/change-data-path-missing-settings.test.ts
//
// 守卫 r207:「更改数据目录」对**全新工作区**必然失败(ENOENT: settings.json)。
//
// ── 被守卫的缺陷(用户可见)──────────────────────────────────────────
//   changeDataPath 复制完工作区内容后,还要把源根的 settings.json 搬过去
//   (并把 rootPath / dataPath 改写成新根)。旧实现把 readFileCapped 的
//   **ENOENT** 当成致命错 ⇒ 直接 throw ⇒ 整个迁移失败、目标目录被回滚删掉。
//
//   而「源根**没有** settings.json」是**正常状态**,不是异常:
//     - r163 的「首启跳过写盘」优化:当前设置 == 全默认 ⇒ 不写盘
//       ⇒ **空工作区的根下一直没有 settings.json**;
//     - settings.json 被 quarantine 成 settings.json.corrupt-<ts>.json
//       (r200 的损坏分支)后,那条分支同样**不写回** defaults。
//
//   ⇒ 用户装好应用、笔记还没写几篇,点「更改数据目录」→ 迁移**必然失败**,
//     报的还是一句裸的
//       ENOENT: no such file or directory, open 'D:\...\settings.json'
//     (实测:目标目录里的 notes/ 被复制出来又被回滚删掉)。
//
// ── 本测锁的契约 ───────────────────────────────────────────────────
//   A1 源根**没有** settings.json → 迁移**成功**,源内容全部到位,
//      新根**也不写** settings.json(与源保持一致)。
//   A2 源根有正常 settings.json → 迁移成功,且新根的 rootPath / dataPath
//      被改写成**新根**(既有行为,防回归)。
//   A3 源根的 settings.json 内容**损坏** → 迁移成功,新根拿到**逐字**副本
//      (「迁移不改变内容」优先)。
//   A4 源根的 settings.json **读不到**(路径其实是个目录 → EISDIR)→
//      迁移 fail-closed 抛错,且目标目录**一个字节都没写**(不留半成品)。
//   A5 任何一次迁移都不许动源根(它是用户的原件)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

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

// ⚠ 临时根必须**每次跑测唯一**(mkdtemp),不能用固定目录名 + 递归删。
//   固定名会让两次并发的跑测(CI 分片 / watch 重跑 / 两个 checkout 同时跑)
//   互删对方正在用的目录树 ⇒ 一片 ENOENT / ENOTEMPTY 假红。
//   守卫:tests/unit/main/lint/no-fixed-temp-dir.test.ts
const TMP = await fs.mkdtemp(join(tmpdir(), 'rkms-r207-'));
const ROOT = join(TMP, 'root');
const TARGET = join(TMP, 'target');

vi.mock('../../../src/main/location', () => ({
  // 箭头函数体是**延迟**求值的 —— 常量在测试文件主体里定义也没关系
  defaultDataPath: () => join(TMP, 'default'),
  writeLocation: async () => {},
}));

import { changeDataPath } from '../../../src/main/settings/store';
import { AppError } from '../../../src/main/utils/error';

async function exists(p: string): Promise<boolean> {
  return fs
    .stat(p)
    .then(() => true)
    .catch(() => false);
}

/** 一个最小但真实的工作区:notes/ + literature/ */
async function makeWorkspace(): Promise<void> {
  await fs.mkdir(join(ROOT, 'notes'), { recursive: true });
  await fs.mkdir(join(ROOT, 'literature'), { recursive: true });
  await fs.writeFile(join(ROOT, 'notes', 'a.md'), '# a', 'utf-8');
  await fs.writeFile(join(ROOT, 'literature', 'paper.pdf'), 'pdf', 'utf-8');
}

describe('迁移数据目录:源没有 settings.json(r207)', () => {
  beforeEach(async () => {
    await fs.rm(TMP, { recursive: true, force: true });
    await fs.mkdir(ROOT, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(TMP, { recursive: true, force: true });
  });

  it('A1 源根没有 settings.json → 迁移成功,内容全到位,新根也不写 settings.json', async () => {
    await makeWorkspace();
    // 全新工作区:根下**没有** settings.json

    await changeDataPath(TARGET, ROOT);

    // 源内容全部搬过去了
    expect(await fs.readFile(join(TARGET, 'notes', 'a.md'), 'utf-8')).toBe('# a');
    expect(await fs.readFile(join(TARGET, 'literature', 'paper.pdf'), 'utf-8')).toBe('pdf');
    // 新根**没有** settings.json(与源保持一致;新根的 initSettings 给默认值)
    expect(await exists(join(TARGET, 'settings.json'))).toBe(false);
  });

  it('A2 源根有正常 settings.json → 新根的 rootPath / dataPath 被改写成新根', async () => {
    await makeWorkspace();
    await fs.writeFile(
      join(ROOT, 'settings.json'),
      JSON.stringify({ theme: 'dark', language: 'zh-CN', rootPath: ROOT, dataPath: ROOT }),
      'utf-8',
    );

    await changeDataPath(TARGET, ROOT);

    const written = JSON.parse(
      await fs.readFile(join(TARGET, 'settings.json'), 'utf-8'),
    ) as Record<string, unknown>;
    expect(written['rootPath']).toBe(TARGET);
    expect(written['dataPath']).toBe(TARGET);
    // 用户设置逐字保留
    expect(written['theme']).toBe('dark');
    expect(written['language']).toBe('zh-CN');
  });

  it('A3 源根的 settings.json 内容损坏 → 迁移成功,新根拿到逐字副本', async () => {
    await makeWorkspace();
    const corrupt = '{ this is not json';
    await fs.writeFile(join(ROOT, 'settings.json'), corrupt, 'utf-8');

    await changeDataPath(TARGET, ROOT);

    // 逐字复制(「迁移不改变内容」优先;新根的 initSettings 会自己 quarantine)
    expect(await fs.readFile(join(TARGET, 'settings.json'), 'utf-8')).toBe(corrupt);
    // 内容照样搬过去了
    expect(await fs.readFile(join(TARGET, 'notes', 'a.md'), 'utf-8')).toBe('# a');
  });

  it('A4 源根的 settings.json 读不到 → fail-closed,且目标目录一个字节都没写', async () => {
    await makeWorkspace();
    // 用「路径其实是个目录」制造读失败(Windows 上 open 成功、readFile 报 EISDIR)
    await fs.mkdir(join(ROOT, 'settings.json'), { recursive: true });

    const err = await changeDataPath(TARGET, ROOT).then(
      () => null,
      (e: unknown) => e,
    );

    // 抛的是**结构化错误**且带可自救的消息(不是裸的 ENOENT/EISDIR ——
    // 裸错误里没有任何「怎么办」的指引)
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('IO_ERROR');
    expect((err as AppError).message).toContain(join(ROOT, 'settings.json'));
    // fail-fast:目标目录**根本不存在**(没有被复制出半成品)
    expect(await exists(TARGET)).toBe(false);
  });

  it('A5 迁移不许动源根(用户的原件)', async () => {
    await makeWorkspace();

    await changeDataPath(TARGET, ROOT);

    expect(await fs.readFile(join(ROOT, 'notes', 'a.md'), 'utf-8')).toBe('# a');
    expect(await fs.readFile(join(ROOT, 'literature', 'paper.pdf'), 'utf-8')).toBe('pdf');
    expect(await exists(join(ROOT, 'settings.json'))).toBe(false);
  });
});
