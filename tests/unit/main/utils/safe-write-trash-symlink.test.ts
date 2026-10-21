// tests/unit/main/utils/safe-write-trash-symlink.test.ts
//
// 行为锁(audit-r243,2026-10-21):**删文件夹时不得把 symlink 的目标也删掉**。
//
// ── 缺陷 ────────────────────────────────────────────────────────────
//   safe-write.ts 的 trashDirContents(递归删目录内容的内部 helper)在遇到
//   子项 symlink 时走的是 `shell.trashItem(child)`。而 shell.trashItem 在
//   Windows 上 **follow symlink** —— 同一文件里 safeTrash 的头注(r151)明明白白
//   写着这件事,并因此对 symlink 直接抛 UNSAFE_WRITE。
//   trashDirContents 却反着来:旧注释说「lstat 已经挡过 planted 越界」——
//   **假的**:上面 lstat 的是**父目录**,子项 symlink 从没被 lstat 过。
//
//   实证后果:用户在 literature/links/ 放一个指向家目录某个 PDF 的 symlink,
//   再「删除文件夹 links/」⇒ **dataPath 外的那个 PDF 被移进回收站**。
//   越界删除(用户只说删文件夹,没说删文件夹里链接指向的东西)。
//
// ── 修法 ────────────────────────────────────────────────────────────
//   symlink 子项不再走 shell.trashItem,改用 fs.rm(force+recursive):
//   rm 对 symlink 只摘**链接本身**,不 follow(unlink 语义),
//   链接指向的目标留在原处(Windows 目录 junction 实测:目标仍在)。
//
// ── 本测怎么「让假实现露馅」──────────────────────────────────────────
//   mock 的 shell.trashItem **模拟 Windows 的真实语义**:对传入路径做
//   realpath(跟随 symlink)再把**目标**搬进假回收站。
//   ⇒ 旧实现下,外部文件会被搬走(断言挂);新实现下,shell.trashItem 根本
//     不会收到 symlink 路径,外部文件原地不动。
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const trashCalls: string[] = [];

// mock electron:trashItem 模拟 Windows 真实语义 —— follow symlink 后搬走**目标**
vi.mock('electron', () => ({
  shell: {
    trashItem: vi.fn(async (target: string) => {
      trashCalls.push(target);
      // 真实 Windows 行为:跟随 symlink,搬走的是**目标**
      const { realpath, rename } = await import('fs/promises');
      const { join: j, basename: b } = await import('path');
      const real = await realpath(target);
      const trashDir = j(real, '..', '..', '.fake-trash');
      await mkdir(trashDir, { recursive: true });
      await rename(real, j(trashDir, b(real)));
      return true;
    }),
  },
}));

describe('safeRecursiveTrash 不 follow symlink(audit-r243)', () => {
  let dataRoot: string;
  let outsideDir: string;
  let outsideFile: string;

  beforeEach(async () => {
    vi.resetModules();
    trashCalls.length = 0;
    dataRoot = await mkdtemp(join(tmpdir(), 'rkms-trash-link-'));
    outsideDir = await mkdtemp(join(tmpdir(), 'rkms-outside-'));
    outsideFile = join(outsideDir, 'tax-return.pdf');
    await writeFile(outsideFile, 'PRECIOUS', 'utf8');
  });

  afterEach(async () => {
    vi.resetModules();
    await rm(dataRoot, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });

  it('目录里的 symlink 只摘链接本身,dataPath 外的目标文件原地不动', async () => {
    const { setRootPath, safeRecursiveTrash } = await import(
      '../../../../src/main/utils/safe-write'
    );
    setRootPath(dataRoot);

    const dir = join(dataRoot, 'literature', 'links');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'real.pdf'), 'REAL', 'utf8');
    const link = join(dir, 'evil.pdf');
    try {
      await symlink(outsideFile, link, 'file');
    } catch (err: unknown) {
      // 没开开发者模式 / 无符号链接权限 ⇒ 本机无法构造前提,跳过
      const code = (err as { code?: string }).code;
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') {
        return;
      }
      throw err;
    }

    await safeRecursiveTrash(join(dataRoot, 'literature', 'links'));

    // ① 外部目标文件必须还在(旧实现:被 shell.trashItem follow 搬走)
    expect(existsSync(outsideFile), 'dataPath 外的目标文件被删了 ⇒ 越界删除').toBe(true);
    // ② symlink 本身被摘掉(链接不再是链接 / 已不存在)
    expect(existsSync(link), 'symlink 本身没被摘掉').toBe(false);
    // ③ shell.trashItem 不得收到 symlink 路径(旧实现会收到)
    expect(
      trashCalls.some((p) => p === link),
      `shell.trashItem 收到了 symlink 路径:${trashCalls.join(', ')}`,
    ).toBe(false);
  });

  it('目录里的普通文件仍走回收站(别把修复做成「什么都不删」)', async () => {
    const { setRootPath, safeRecursiveTrash } = await import(
      '../../../../src/main/utils/safe-write'
    );
    setRootPath(dataRoot);

    const dir = join(dataRoot, 'literature', 'plain');
    await mkdir(dir, { recursive: true });
    const realFile = join(dir, 'a.pdf');
    await writeFile(realFile, 'REAL', 'utf8');

    await safeRecursiveTrash(join(dataRoot, 'literature', 'plain'));

    expect(trashCalls.length, '普通文件没走 trashItem').toBeGreaterThan(0);
    expect(existsSync(realFile), '普通文件还在(没被搬走)').toBe(false);
  });
});
