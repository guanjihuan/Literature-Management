// tests/unit/main/utils/migrate-old-userdata-partial-copy.test.ts
//
// 行为锁(audit-r243,2026-10-21):**跨盘搬迁(copy fallback)失败时,不能留下
// 「半份目标副本」** —— 留了就会在下次启动把 source 端原件删掉,永久丢数据。
//
// ── 缺陷链路(旧实现)────────────────────────────────────────────────
//   1. 首次启动:userData 跨盘(OneDrive 重定向 / appData 挪到 D 盘)
//      ⇒ fs.rename 抛 EXDEV ⇒ 走 copy fallback。
//   2. copy 中途失败(ENOSPC / EIO / 断电)⇒ newPath 留下**半份**拷贝
//      (文件分支:截断文件;目录分支:部分子树)。旧实现只记一条 warning。
//   3. 下次启动:moveItem 先 lstat(newPath) ⇒ **存在** ⇒ 返回
//      {ok:true, skipped} ⇒ 没有 warning ⇒ hasFailure 仍为 false ⇒
//      itemsHandled 满 ⇒ 启动流程判定「新端已有对应副本」⇒
//      **删掉 source 端原件**。
//   ⇒ 用户原始 settings.json / location.json 只剩那份截断副本 —— 永久丢数据。
//
// ── 修法 ────────────────────────────────────────────────────────────
//   copy 失败时把目标端残留删掉 ⇒ 下次启动「目标端不存在」⇒ 重新从 source
//   搬 ⇒ source 始终是权威副本。
//
// ── 本测怎么造出 EXDEV + 中途失败 ───────────────────────────────────
//   Windows 上没法真造跨盘 rename,故 mock 'fs' 的 promises:
//     · rename 一律抛 EXDEV(逼代码走 copy fallback)
//     · copyFile / cp 造出「目标端半份残留」后抛 ENOSPC
//   然后跑两轮迁移:第一轮失败、第二轮恢复正常 ⇒ 断言 source 在第一轮后
//   仍在、第二轮才被删(旧实现:第一轮就删了)。
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const flags = vi.hoisted(() => ({ failCopy: true }));

vi.mock('electron', () => ({
  app: { getPath: () => '' },
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const real = actual.promises;
  // audit-r253 (2026-10-21):`typeof import('fs')` 里**没有** default 属性
  //   (@types/node 的 fs 是 CJS 导出,default 由 esModuleInterop 合成,
  //   不体现在模块命名空间的类型上)⇒ 直接写 actual.default 是 TS2339。
  //   这里显式把「可能有 default」的形状加回去,运行时语义不变。
  const withDefault = actual as typeof actual & { default?: typeof actual };
  return {
    ...actual,
    default: withDefault.default ?? actual,
    promises: {
      ...real,
      // 跨盘:rename 一律 EXDEV ⇒ 逼代码走 copy fallback
      rename: async (oldPath: string, newPath: string) => {
        const err = new Error('EXDEV: cross-device link not permitted') as NodeJS.ErrnoException;
        err.code = 'EXDEV';
        void oldPath;
        void newPath;
        throw err;
      },
      // 中途失败:先在目标端造出半份残留,再抛 ENOSPC
      copyFile: async (src: string, dest: string) => {
        if (flags.failCopy) {
          await real.writeFile(dest, 'PARTIAL', 'utf8');
          const err = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException;
          err.code = 'ENOSPC';
          void src;
          throw err;
        }
        return real.copyFile(src, dest);
      },
      cp: async (src: string, dest: string, opts?: unknown) => {
        if (flags.failCopy) {
          await real.mkdir(dest, { recursive: true });
          await real.writeFile(join(dest, 'partial.bin'), 'PARTIAL', 'utf8');
          const err = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException;
          err.code = 'ENOSPC';
          void src;
          void opts;
          throw err;
        }
        return real.cp(src, dest, opts as never);
      },
    },
  };
});

describe('migrateUserDataAppItems:跨盘 copy 失败不留半份残留(audit-r243)', () => {
  let oldUserData: string;
  let newUserData: string;

  beforeEach(async () => {
    vi.resetModules();
    flags.failCopy = true;
    oldUserData = await mkdtemp(join(tmpdir(), 'rkms-oldud-'));
    newUserData = await mkdtemp(join(tmpdir(), 'rkms-newud-'));
    // 老 userData 里放 3 个应用文件(闸门要求「每个 item 都被处理过」)
    await writeFile(join(oldUserData, 'location.json'), '{"root":"C:/data"}', 'utf8');
    await writeFile(join(oldUserData, 'settings.json'), '{"theme":"dark"}', 'utf8');
    await mkdir(join(oldUserData, 'index'), { recursive: true });
    await writeFile(join(oldUserData, 'index', 'a.txt'), 'A', 'utf8');
  });

  afterEach(async () => {
    vi.resetModules();
    await rm(oldUserData, { recursive: true, force: true });
    await rm(newUserData, { recursive: true, force: true });
  });

  it('copy 失败后:source 原件仍在 + 目标端无半份残留(下次启动能重试)', async () => {
    const { migrateUserDataAppItems } = await import(
      '../../../../src/main/utils/migrate-old-userdata'
    );
    const report = await migrateUserDataAppItems(oldUserData, newUserData);

    // ① 搬失败 ⇒ 必须有 warning(闸门据此保留 source)
    expect(report.warnings.length, 'copy 失败却没有 warning').toBeGreaterThan(0);
    // ② source 原件必须还在
    expect(existsSync(join(oldUserData, 'settings.json')), 'source 被删了 ⇒ 丢数据').toBe(true);
    expect(existsSync(join(oldUserData, 'location.json')), 'source 被删了 ⇒ 丢数据').toBe(true);
    // ③ 目标端**不能**留半份残留(旧实现的致命点)
    expect(
      existsSync(join(newUserData, 'settings.json')),
      '目标端留了半份残留 ⇒ 下次启动会把它当「已搬完」并删掉 source',
    ).toBe(false);
    expect(existsSync(join(newUserData, 'location.json')), '目标端留了半份残留').toBe(false);
  });

  it('第二轮(copy 恢复正常)⇒ 正常搬走并删 source(证明第一轮没误删、也没卡死)', async () => {
    const { migrateUserDataAppItems } = await import(
      '../../../../src/main/utils/migrate-old-userdata'
    );
    await migrateUserDataAppItems(oldUserData, newUserData);
    // 第一轮之后 source 必须还在(否则就没得搬了)
    expect(existsSync(join(oldUserData, 'settings.json'))).toBe(true);

    flags.failCopy = false;
    const report2 = await migrateUserDataAppItems(oldUserData, newUserData);

    // 第二轮:搬成功 ⇒ 目标端有完整副本
    const copied = await readFile(join(newUserData, 'settings.json'), 'utf8');
    expect(copied).toBe('{"theme":"dark"}');
    // 搬完才删 source(跨盘走的是 copy + rm 分支,source 在 moveItem 里就被删了)
    expect(existsSync(join(oldUserData, 'settings.json')), '搬成功后 source 仍留着').toBe(false);
    expect(report2.warnings.length, '第二轮不该再有 warning').toBe(0);
    // 目录项也搬过去了
    expect(existsSync(join(newUserData, 'index', 'a.txt'))).toBe(true);
  });
});
