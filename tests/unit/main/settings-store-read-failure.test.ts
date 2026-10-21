// tests/unit/main/settings-store-read-failure.test.ts
//
// 守卫:settings.json 的「读失败」与「解析失败」必须**分开处置**。
//
// audit r200 (2026-10-20) 修的 bug(r199 atomic-file 同一 bug 类的上层版):
//   src/main/settings/store.ts 的 initSettings 旧实现把
//   `readFileCapped(...)` 与 `JSON.parse(...)` 裹在**同一个 try** 里:
//     catch → 非 ENOENT / 非 IO_ERROR ⇒ 一律当「文件损坏」处理
//           → `fs.rename(settings.json, settings.json.corrupt-<ts>.json)`
//           → loaded 保持 {} → currentSettings = DEFAULT_SETTINGS
//   ⇒ 除 ENOENT / size-cap 外的**任何读错误**(EACCES 权限 / EPERM /
//     EBUSY 被同步盘或杀毒占用 / EIO / EISDIR 路径其实是目录)都会:
//     1. 把用户的 settings.json **改名走**(内容可能完好,只是此刻读不到);
//     2. 让应用带着**默认设置**启动 —— 主题 / 语言 / 布局 / 导入根全丢;
//     3. 零错误提示(用户只看到「设置怎么变回默认了」)。
//   即:一次瞬时读失败 = 用户设置被重置。与本函数自己对 size-cap 的
//   策略注释「让首启崩比『静默接受 defaults 覆盖用户设置』更安全」自相矛盾。
//
// 本文件的 7 例锁住新契约:
//   1. 读失败(EACCES)→ initSettings **抛错**,原文件内容一字不动,
//      **不产生 .corrupt-***,不写出新的 settings.json(最关键的一条);
//   2. 读失败(EISDIR:路径其实是目录)→ 抛错,目录原样保留,不被改名走;
//   3. 读失败 → 错误码是 SETTINGS_UNREADABLE(且该 code 在
//      IPC_ERROR_CODES union 里 —— 否则 wrap.ts 会 fallback INTERNAL
//      **并擦掉 message**,自救指引就传不到用户眼前);
//   4. **parse 失败(真·JSON 损坏)仍然 quarantine**(老契约不能被改坏):
//      坏文件改名保留,内容完整,不抛错;
//   5. ENOENT(首启)→ 走默认值,不产生 .corrupt-*;
//   6. 正常加载 → 用户设置(theme='dark')**原样保留**在盘上;
//   7. 读阶段的瞬时 EBUSY 会被退避重试(而不是被当成「文件损坏」)。
import { mkdtemp, rm, readFile, readdir, stat, writeFile, mkdir } from 'fs/promises';
import { promises as fsPromises } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// electron mock —— store.ts 取 app.getVersion(),safe-write 取 shell,
// location 取 app.getPath('userData')。三个都在模块作用域被 import,
// mock 工厂必须把用到的那几个都摆出来(缺一个就会在 import 期炸)。
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

const { initSettings, getSettings } = await import('../../../src/main/settings/store');
const { setRootPath } = await import('../../../src/main/utils/safe-write');

/** 造一个带 errno code 的错误(模拟 EACCES / EBUSY / EISDIR) */
function fsError(code: string, msg: string): NodeJS.ErrnoException {
  const e = new Error(msg) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

/** dataPath 下的 settings.json 路径 */
function settingsFileOf(dataPath: string): string {
  return join(dataPath, 'settings.json');
}

describe('settings store — 读失败 ≠ 文件损坏(r200)', () => {
  let tmpRoot: string;
  let dataPath: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'settings-store-test-'));
    dataPath = join(tmpRoot, 'data');
    await mkdir(dataPath, { recursive: true });
    // safe-write 的 rootPath 单例:initSettings 末尾的 saveSettings 走
    // safeWriteFileAtomic → resolveInsideDataPath → getRootPath()
    setRootPath(dataPath);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('读失败(EACCES)→ 抛错 + 原文件内容一字不动 + 不 quarantine + 不写出新 settings.json', async () => {
    const filePath = settingsFileOf(dataPath);
    const original = JSON.stringify({ theme: 'dark', language: 'en-US' }, null, 2);
    await writeFile(filePath, original, 'utf8');

    const spy = vi
      .spyOn(fsPromises, 'open')
      .mockImplementationOnce(() => Promise.reject(fsError('EACCES', 'permission denied')));

    await expect(initSettings(dataPath)).rejects.toThrow();
    spy.mockRestore();

    // 用户的设置**原封不动**留在盘上
    expect(await readFile(filePath, 'utf8')).toBe(original);
    // 没有被当成「损坏文件」改名走
    expect((await readdir(dataPath)).filter((n) => n.includes('.corrupt-'))).toHaveLength(0);
    // 没有被「用默认值写一份新的」顶掉
    const siblings = await readdir(dataPath);
    expect(siblings.filter((n) => n === 'settings.json')).toHaveLength(1);
  });

  it('读失败(EISDIR:路径其实是目录)→ 抛错 + 目录原样保留 + 不被改名走', async () => {
    const filePath = settingsFileOf(dataPath);
    await mkdir(filePath); // 目录占位

    await expect(initSettings(dataPath)).rejects.toThrow();

    // 目录还在原地,类型没变(旧实现会把它 rename 成 .corrupt-*)
    expect((await stat(filePath)).isDirectory()).toBe(true);
    expect((await readdir(dataPath)).filter((n) => n.includes('.corrupt-'))).toHaveLength(0);
  });

  it('读失败 → 错误码是 SETTINGS_UNREADABLE,且该 code 在 IPC_ERROR_CODES union 里', async () => {
    const filePath = settingsFileOf(dataPath);
    await writeFile(filePath, JSON.stringify({ theme: 'dark' }), 'utf8');

    const spy = vi
      .spyOn(fsPromises, 'open')
      .mockImplementationOnce(() => Promise.reject(fsError('EACCES', 'permission denied')));

    const err = await initSettings(dataPath).then(
      () => null,
      (e: unknown) => e,
    );
    spy.mockRestore();

    expect(err).toBeInstanceOf(Error);
    const code = (err as { code?: unknown }).code;
    expect(code).toBe('SETTINGS_UNREADABLE');
    // union 里的 code 才有意义:wrap.ts 对 union 外的 code 会 fallback
    // INTERNAL **并擦掉 message** —— 那条自救指引就传不到用户眼前
    const { IPC_ERROR_CODES } = await import('../../../src/shared/types');
    expect(IPC_ERROR_CODES as readonly string[]).toContain('SETTINGS_UNREADABLE');
    // 消息要能指导用户自救(关掉占用它的程序 / 修权限),而不是「删掉文件」
    expect((err as Error).message).toMatch(/left untouched/i);
  });

  it('parse 失败(真·JSON 损坏)仍然 quarantine(老契约不能被改坏):坏文件改名保留,不抛错', async () => {
    const filePath = settingsFileOf(dataPath);
    const garbage = '{ this is not json';
    await writeFile(filePath, garbage, 'utf8');

    // parse 失败**不抛错**(启动继续),而是 quarantine + 走默认值
    await expect(initSettings(dataPath)).resolves.toBeDefined();

    const siblings = await readdir(dataPath);
    const quarantined = siblings.filter((n) => n.startsWith('settings.json.corrupt-'));
    expect(quarantined).toHaveLength(1);
    // 原件已被改名走,内容完整保留在 .corrupt-* 里
    expect(await readFile(join(dataPath, quarantined[0]), 'utf8')).toBe(garbage);
  });

  it('ENOENT(首启)→ 走默认值,不产生 .corrupt-*', async () => {
    await expect(initSettings(dataPath)).resolves.toBeDefined();
    expect((await readdir(dataPath)).filter((n) => n.includes('.corrupt-'))).toHaveLength(0);
  });

  it('正常加载 → 用户设置(theme)原样保留在盘上', async () => {
    const filePath = settingsFileOf(dataPath);
    await writeFile(filePath, JSON.stringify({ theme: 'dark' }, null, 2), 'utf8');

    await initSettings(dataPath);

    expect(getSettings().theme).toBe('dark');
    const onDisk = JSON.parse(await readFile(filePath, 'utf8')) as { theme?: string };
    expect(onDisk.theme).toBe('dark');
    expect((await readdir(dataPath)).filter((n) => n.includes('.corrupt-'))).toHaveLength(0);
  });

  it('读阶段的瞬时 EBUSY 被退避重试(而不是被当成「文件损坏」)', async () => {
    const filePath = settingsFileOf(dataPath);
    await writeFile(filePath, JSON.stringify({ theme: 'dark' }), 'utf8');

    const spy = vi
      .spyOn(fsPromises, 'open')
      .mockImplementationOnce(() => Promise.reject(fsError('EBUSY', 'file is busy')));

    await expect(initSettings(dataPath)).resolves.toBeDefined();
    spy.mockRestore();

    expect(getSettings().theme).toBe('dark');
    expect((await readdir(dataPath)).filter((n) => n.includes('.corrupt-'))).toHaveLength(0);
  });
});
