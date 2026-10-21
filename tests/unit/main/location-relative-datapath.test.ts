// tests/unit/main/location-relative-datapath.test.ts
//
// 守 r197「相对 dataPath 不得被 mkdir + 持久化」契约。
//
// location.ts 的 resolveDataPath() 有 9 条分支,其中**三条**会「拿一个
// 候选路径 → fs.mkdir → writeLocation 持久化」:
//   - 第 1 步 location.json        → 有 isAbsolute 守卫(:110)
//   - 第 5 步 merged settings      → 有 isAbsolute 守卫(:264,2026-10-01 补)
//   - 第 7 步 userData settings    → r197 补上同名守卫(defense-in-depth)
//
// 后果:userData 下残留的旧版 settings.json 写着 dataPath: "notes",
// 启动时工作区被建在 process.cwd()/notes(dev = 项目根、打包后 = asar
// 目录),并被写进 location.json 长期固化 —— 用户的工作区落在磁盘角落。
//
// 说明(可达性,别被误导):第 7 步在**当前**流程里其实走不到 ——
// userData settings 里带 dataPath 的情形已被第 5 步的 withPath 分支截住
// (且那里已有 isAbsolute 校验)。r197 在第 7 步补的是「将来流程调整时
// 不会静默改回去」的保险。本测是**行为级**守卫:不管最终由哪条分支兜住,
// 「相对 dataPath 必须落回默认、且不得在 cwd 下建目录」这条不变式都要成立。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const paths = vi.hoisted(() => ({ userData: '', documents: '' }));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string): string => {
      if (name === 'userData') return paths.userData;
      if (name === 'documents') return paths.documents;
      return tmpdir();
    },
  },
}));

import { resolveDataPath } from '../../../src/main/location';
import { WORKSPACE_DATA_LAYOUT } from '../../../src/shared/types';

describe('resolveDataPath 相对 dataPath(r197)', () => {
  let root: string;
  let userData: string;
  let documents: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'rkms-loc-'));
    userData = join(root, 'userData');
    documents = join(root, 'Documents');
    paths.userData = userData;
    paths.documents = documents;
    await fs.mkdir(userData, { recursive: true });
    await fs.mkdir(documents, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('userData settings.json 的相对 dataPath → 被忽略,落回默认路径', async () => {
    await fs.writeFile(
      join(userData, WORKSPACE_DATA_LAYOUT.SETTINGS_FILE),
      JSON.stringify({ dataPath: 'relative-notes' }),
      'utf-8',
    );

    const res = await resolveDataPath();
    const def = join(documents, 'ResearchHub', 'data');
    expect(res.path).toBe(def);
    // 关键:不得在 cwd 下把「相对路径」当工作区建出来
    expect(existsSync(join(process.cwd(), 'relative-notes'))).toBe(false);
  });

  it('相对 dataPath 不得被持久化进 location.json', async () => {
    await fs.writeFile(
      join(userData, WORKSPACE_DATA_LAYOUT.SETTINGS_FILE),
      JSON.stringify({ dataPath: 'relative-notes' }),
      'utf-8',
    );
    await resolveDataPath();
    const locPath = join(userData, 'location.json');
    if (existsSync(locPath)) {
      const raw = await fs.readFile(locPath, 'utf-8');
      expect(raw).not.toContain('relative-notes');
    }
  });

  it('绝对 dataPath 仍然照常采纳(契约不因本轮改动而松动)', async () => {
    const abs = join(root, 'workspace-abs');
    await fs.writeFile(
      join(userData, WORKSPACE_DATA_LAYOUT.SETTINGS_FILE),
      JSON.stringify({ dataPath: abs }),
      'utf-8',
    );
    const res = await resolveDataPath();
    expect(res.path).toBe(abs);
    expect(existsSync(abs)).toBe(true);
  });
});
