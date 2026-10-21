// tests/unit/main/literature-import-partial-copy.test.ts
//
// 行为锁(audit-r243,2026-10-21):**导入失败时不得在 literature/ 里留下
// 半截文件**。
//
// ── 缺陷 ────────────────────────────────────────────────────────────
//   import.ts 的拷贝走 fs.copyFile(src, dst, COPYFILE_EXCL)。copyFile 先
//   创建/截断 dst 再拷内容,中途失败(ENOSPC / EIO / 断电)会留下一个
//   **截断的** dst。旧实现在「非 EEXIST」分支直接抛错,没清 dst。
//   ⇒ 那半截文件留在 literature/ 里 ⇒ chokidar 'add' ⇒ reload 把它当
//     正常文献收进 byId + resources 表 ⇒ 用户列表里出现一个打不开的
//     「文献」,还占着磁盘空间。
//   (同函数的「拷贝后 size 校验」分支是会 rm dst 的,但 copy 失败这条
//    路径根本走不到那里。)
//
// ── 修法 ────────────────────────────────────────────────────────────
//   非 EEXIST 失败 ⇒ 先 rm(dst) 再抛。EEXIST 分支**不能**删(dst 是别人
//   已有的文件,下面要换名重试)。
import { mkdtemp, writeFile, rm, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// mock 'fs':copyFile 造出「目标端半份残留」后抛 ENOSPC
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
      copyFile: async (src: string, dest: string) => {
        await real.writeFile(dest, 'PARTIAL', 'utf8');
        const err = new Error('ENOSPC: no space left on device') as NodeJS.ErrnoException;
        err.code = 'ENOSPC';
        void src;
        throw err;
      },
    },
  };
});

describe('文献导入:拷贝失败不留半截文件(audit-r243)', () => {
  let root: string;
  let srcFile: string;

  beforeEach(async () => {
    vi.resetModules();
    root = await mkdtemp(join(tmpdir(), 'rkms-litimport-'));
    srcFile = join(root, 'paper.pdf');
    await writeFile(srcFile, 'REAL PDF CONTENT', 'utf8');
  });

  afterEach(async () => {
    vi.resetModules();
    await rm(root, { recursive: true, force: true });
  });

  it('copyFile 中途失败 ⇒ 抛错 + literature/ 里不残留半截文件', async () => {
    const { importLiteratureFile, literatureDir } = await import(
      '../../../src/main/literature/import'
    );
    await expect(importLiteratureFile(srcFile, root)).rejects.toThrow();

    const dir = literatureDir(root);
    const leftovers = await readdir(dir).catch(() => [] as string[]);
    expect(
      leftovers,
      `literature/ 里残留了半截文件:${leftovers.join(', ')} ⇒ 会被 reload 当成正常文献收进索引`,
    ).toEqual([]);
  });
});
