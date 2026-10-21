// tests/unit/main/ipc/paths.test.ts
// 守 src/main/ipc/paths.ts 的「路径白名单 + symlink 防御」契约(r229 补齐 🔒 守卫缺失)。
//
// ── 被守卫的契约(退化后的用户可见后果)─────────────────────────────
//   C1 isInsideAnyRoot —— 唯一一处「路径是否落在根集合之内」的判定。
//      退化(改回 startsWith 前缀比较)⇒ 工作区外的**同前缀兄弟目录**
//      (如 <root>-evil)被误判成「在白名单内」⇒ 渲染层可经 rkms:// iframe /
//      shell:open-path 打开工作区外的文件(读侧越界,用户隐私外泄)。
//   C2 assertInsideAllowedRoot —— 相对路径以 rootPath 为基准解析、越界抛 EPERM。
//      退化(按 cwd 解析相对路径)⇒ 应用的启动目录一变,「打开笔记所在目录」
//      这类相对路径操作全部落到工作区之外 ⇒ 用户看到「路径不允许」而毫无线索。
//   C3 assertNotSymlink —— 白名单内但**是 symlink** → EPERM
//      (这条正是源码里那处 🔒 指针指向的行为)。
//      退化(去掉 lstat / realpath 两道防线)⇒ 攻击者把 <root>/notes/foo.md
//      换成指向 ~/.ssh/id_rsa 的 symlink,渲染层的 rkms:// iframe 就能读到
//      工作区外的任意文件;用户侧表现是「笔记内容莫名其妙变成了 SSH 私钥」。
//   C4 assertNotSymlink 的 roots 参数 —— 防御对照的是**调用方自己**的白名单。
//      退化(写死 allowedRoots())⇒ 用了别的根集合的调用方要么被误杀、要么
//      放行本该拦住的路径。
//
// ── 变异思路(哪几处改动会红)─────────────────────────────────────
//   M1 isInsideAnyRoot 的 rel 判定换成 startsWith 前缀比较 → A3 / A6 / D8 红。
//   M2 isInsideAnyRoot 删掉 caseInsensitive 折叠 → A4 红。
//   M3 isInsideAnyRoot 改成按 process.platform 在 posix/win32 之间切 →
//      B 组(注入 impl)与 C 组(宿主语义)同时红。
//   M4 assertInsideAllowedRoot 的相对路径改成按 cwd 解析 → D3 红。
//   M5 assertInsideAllowedRoot 不再调用 assertNotSymlink → D10 / D11 红。
//   M6 assertNotSymlink 去掉第一道 lstat 防线 → E3 红。
//   M7 assertNotSymlink 去掉第二道 realpath 链防线 → E4 红。
//   M8 assertNotSymlink 把 roots 写死成 allowedRoots() → F1 / F2 红。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join, posix, resolve, win32 } from 'path';

// safe-write.ts 顶层 import { shell } from 'electron' —— node 环境下 electron
// 包导出的是二进制路径字符串,不做 mock 会在 import 期就炸。
vi.mock('electron', () => ({
  shell: { trashItem: vi.fn(), openPath: vi.fn() },
}));

import { setRootPath } from '../../../../src/main/utils/safe-write';
import { AppError, errnoCode } from '../../../../src/main/utils/error';
import {
  allowedRoots,
  assertInsideAllowedRoot,
  assertNotSymlink,
  buildWorkspacePaths,
  isInsideAnyRoot,
} from '../../../../src/main/ipc/paths';

/** 注入用的 posix / win32 路径语义(生产路径用的是宿主默认那套) */
const POSIX = { relative: posix.relative, isAbsolute: posix.isAbsolute };
const WIN32 = { relative: win32.relative, isAbsolute: win32.isAbsolute };

let root: string;
let outside: string;

/**
 * 造一个指向 target 的**目录链接**。
 * Windows 上 junction 不需要管理员权限(普通 symlink 需要 Developer Mode /
 * 管理员);POSIX 上 Node 忽略 type 参数 ⇒ 等价于普通符号链接。
 */
async function makeLink(target: string, link: string): Promise<void> {
  try {
    await fs.symlink(target, link, 'junction');
  } catch (err: unknown) {
    throw new Error(
      `造不出 junction(${target} → ${link}): ${String(err)}\n` +
        `若所在环境完全禁止创建符号链接,这一组用例需要改成 mock fs.lstatSync。`,
    );
  }
}

/** 断言 fn 抛 AppError 且 code === expected */
function expectAppError(fn: () => unknown, expected: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (err: unknown) {
    thrown = err;
  }
  expect(thrown, `期望抛 AppError(${expected}),但没有抛`).toBeInstanceOf(AppError);
  expect((thrown as AppError).code).toBe(expected);
  // errnoCode 是 wrap.ts / protocol.ts 判错码用的同一个 helper —— 两处口径要一致
  expect(errnoCode(thrown)).toBe(expected);
}

beforeEach(async () => {
  // realpath:macOS 的 /var → /private/var 是符号链接,不归一化的话 realpath
  // 链防线会把「合法路径」判成越界(那是测试自身的问题,不是被测代码的)。
  root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'rkms-paths-root-')));
  outside = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'rkms-paths-out-')));
  setRootPath(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

describe('A. isInsideAnyRoot:注入 path 语义后的判定(纯函数)', () => {
  it('A1 根自身算在内(rel === "")', () => {
    expect(isInsideAnyRoot(['/data'], '/data', { caseInsensitive: false, impl: POSIX })).toBe(true);
  });

  it('A2 根的子目录算在内', () => {
    expect(
      isInsideAnyRoot(['/data'], '/data/notes/a.md', { caseInsensitive: false, impl: POSIX }),
    ).toBe(true);
  });

  it('A3 同前缀兄弟目录不算在内(/data-evil ≠ /data)', () => {
    // 这是本文件存在的头号理由:startsWith 前缀比较会把 /data-evil 放行
    expect(
      isInsideAnyRoot(['/data'], '/data-evil/x', { caseInsensitive: false, impl: POSIX }),
    ).toBe(false);
  });

  it('A4 大小写:caseInsensitive 决定 /DATA 与 /data 是否同一目录', () => {
    expect(
      isInsideAnyRoot(['/data'], '/DATA/x', { caseInsensitive: false, impl: POSIX }),
    ).toBe(false);
    expect(
      isInsideAnyRoot(['/data'], '/DATA/x', { caseInsensitive: true, impl: POSIX }),
    ).toBe(true);
  });

  it('A5 多根集合:落在任一根内即算在内', () => {
    expect(
      isInsideAnyRoot(['/a', '/b'], '/b/x', { caseInsensitive: false, impl: POSIX }),
    ).toBe(true);
    expect(
      isInsideAnyRoot(['/a', '/b'], '/c/x', { caseInsensitive: false, impl: POSIX }),
    ).toBe(false);
  });

  it('A6 空根集合 ⇒ 一律不在内', () => {
    expect(isInsideAnyRoot([], '/data', { caseInsensitive: false, impl: POSIX })).toBe(false);
  });

  it('A7 win32 语义:同盘子目录在内,换盘在外', () => {
    expect(
      isInsideAnyRoot(['C:\\data'], 'C:\\data\\notes', { caseInsensitive: false, impl: WIN32 }),
    ).toBe(true);
    // 换盘 ⇒ relative 返回绝对路径 ⇒ 判为不在内
    expect(
      isInsideAnyRoot(['C:\\data'], 'D:\\data\\notes', { caseInsensitive: false, impl: WIN32 }),
    ).toBe(false);
  });

  it('A8 ".." 片段由 relative 内部归一化 ⇒ 仍判在内', () => {
    // path.relative 内部会 resolve 两侧 ⇒ '/a/b/../b/c' ≡ '/a/b/c' ⇒ 在 '/a/b' 内。
    // (反过来 '/data-evil' 之所以被拒,是因为归一化后它真的落在根之外。)
    expect(
      isInsideAnyRoot(['/a/b'], '/a/b/../b/c', { caseInsensitive: false, impl: POSIX }),
    ).toBe(true);
    expect(
      isInsideAnyRoot(['/a/b'], '/a/b/../../etc/passwd', { caseInsensitive: false, impl: POSIX }),
    ).toBe(false);
  });
});

describe('B. isInsideAnyRoot:默认 impl(宿主 path 语义)', () => {
  it('B1 根自身 / 子目录在内,区外在外', () => {
    expect(isInsideAnyRoot([root], root)).toBe(true);
    expect(isInsideAnyRoot([root], join(root, 'notes', 'a.md'))).toBe(true);
    expect(isInsideAnyRoot([root], outside)).toBe(false);
  });

  it('B2 同前缀兄弟目录不在内(宿主语义下同样成立)', () => {
    // root 与 sibling 只差后缀 ⇒ 前缀比较会误放行
    const sibling = `${root}-evil`;
    expect(isInsideAnyRoot([root], join(sibling, 'x'))).toBe(false);
  });

  it('B3 默认 opts 省略时 caseInsensitive 视为 false', () => {
    // 显式传 false 与不传 opts 语义一致(省略 opts ⇒ 默认 { caseInsensitive: false })
    const rootUpper = root.toUpperCase();
    expect(isInsideAnyRoot([root], join(rootUpper, 'x'))).toBe(
      isInsideAnyRoot([root], join(rootUpper, 'x'), { caseInsensitive: false }),
    );
  });
});

describe('C. allowedRoots / buildWorkspacePaths', () => {
  it('C1 allowedRoots() 只含当前 rootPath(库下线后白名单缩成单元素)', () => {
    expect(allowedRoots()).toEqual([resolve(root)]);
  });

  it('C2 buildWorkspacePaths() 给出 root / notes / favorites 三个绝对路径', () => {
    const paths = buildWorkspacePaths();
    expect(paths.root).toBe(resolve(root));
    expect(paths.notes).toBe(join(resolve(root), 'notes'));
    expect(paths.favorites).toBe(join(resolve(root), 'workspace', 'favorites'));
  });
});

describe('D. assertInsideAllowedRoot:白名单 + 相对路径基准', () => {
  it('D1 空串 → EINVAL', () => {
    expectAppError(() => assertInsideAllowedRoot(''), 'EINVAL');
  });

  it('D2 非字符串 → EINVAL', () => {
    expectAppError(() => assertInsideAllowedRoot(42 as unknown as string), 'EINVAL');
  });

  it('D3 相对路径以 rootPath 为基准解析(不是 cwd)', () => {
    const abs = assertInsideAllowedRoot('notes');
    expect(abs).toBe(join(resolve(root), 'notes'));
  });

  it('D4 绝对路径(区内)原样返回', async () => {
    const dir = join(root, 'notes');
    await fs.mkdir(dir, { recursive: true });
    expect(assertInsideAllowedRoot(dir)).toBe(dir);
  });

  it('D5 根自身允许(相对结果为空串)', () => {
    expect(assertInsideAllowedRoot(root)).toBe(resolve(root));
  });

  it('D6 区外路径 → EPERM', () => {
    expectAppError(() => assertInsideAllowedRoot(outside), 'EPERM');
  });

  it('D7 相对路径逃逸("..")→ EPERM', () => {
    expectAppError(() => assertInsideAllowedRoot('../escape'), 'EPERM');
  });

  it('D8 同前缀兄弟目录 → EPERM', () => {
    expectAppError(() => assertInsideAllowedRoot(`${root}-evil`), 'EPERM');
  });

  it('D9 区内但尚不存在的路径 → 放行(先校验再写)', async () => {
    const missing = join(root, 'notes', 'not-created-yet.md');
    expect(assertInsideAllowedRoot(missing)).toBe(missing);
  });

  it('D10 区内但本身是 symlink → EPERM', async () => {
    const target = join(root, 'real-target');
    await fs.mkdir(target, { recursive: true });
    const link = join(root, 'link');
    await makeLink(target, link);
    expectAppError(() => assertInsideAllowedRoot(link), 'EPERM');
  });

  it('D11 中间目录段被换成 symlink 指向区外 → EPERM(realpath 链防线)', async () => {
    const secret = join(outside, 'secret.txt');
    await fs.writeFile(secret, 'SECRET', 'utf-8');
    await makeLink(outside, join(root, 'sub'));
    expectAppError(() => assertInsideAllowedRoot(join(root, 'sub', 'secret.txt')), 'EPERM');
  });
});

describe('E. assertNotSymlink:两道防线', () => {
  it('E1 普通文件放行', async () => {
    const f = join(root, 'plain.txt');
    await fs.writeFile(f, 'hello', 'utf-8');
    expect(() => assertNotSymlink(f, [root])).not.toThrow();
  });

  it('E2 普通目录放行', async () => {
    const dir = join(root, 'plain-dir');
    await fs.mkdir(dir, { recursive: true });
    expect(() => assertNotSymlink(dir, [root])).not.toThrow();
  });

  it('E3 不存在的路径放行(后续 fs.open 自己报 ENOENT)', () => {
    const missing = join(root, 'never-created.md');
    expect(() => assertNotSymlink(missing, [root])).not.toThrow();
  });

  it('E4 白名单内但 lstat 是 symlink → EPERM(源码指针指向的那条行为)', async () => {
    // 目标**也在白名单内** —— 拦它的理由是「它是链接」,不是「它指向区外」
    const target = join(root, 'real-target');
    await fs.mkdir(target, { recursive: true });
    const link = join(root, 'link');
    await makeLink(target, link);
    expectAppError(() => assertNotSymlink(link, [root]), 'EPERM');
  });

  it('E5 中间段 symlink 把落点带出白名单 → EPERM(realpath 链防线)', async () => {
    const secret = join(outside, 'secret.txt');
    await fs.writeFile(secret, 'SECRET', 'utf-8');
    await makeLink(outside, join(root, 'sub'));
    expectAppError(() => assertNotSymlink(join(root, 'sub', 'secret.txt'), [root]), 'EPERM');
  });
});

describe('F. assertNotSymlink 的 roots 参数 = 调用方自己的白名单', () => {
  it('F1 路径在 allowedRoots 内、但 roots 是别的集合 → EPERM', async () => {
    // 写死 allowedRoots() 的实现会放行 ⇒ 这条红
    const f = join(root, 'plain.txt');
    await fs.writeFile(f, 'hello', 'utf-8');
    expectAppError(() => assertNotSymlink(f, [outside]), 'EPERM');
  });

  it('F2 路径不在 allowedRoots 内、但 roots 包含它 → 放行', async () => {
    const f = join(outside, 'plain.txt');
    await fs.writeFile(f, 'hello', 'utf-8');
    expect(() => assertNotSymlink(f, [outside])).not.toThrow();
  });
});

/**
 * G 组(audit-r229 补):根自身是 symlink / junction 时,区内合法文件
 * **不得**被判成「realpath 链逃逸」。
 *
 * 复现形态(Windows 上最常见):数据目录放在 OneDrive / Dropbox(云盘目录
 * 本身是 reparse point),或用户按 utils/path-check.ts 的指引用 `mklink /J`
 * 把数据目录建成 junction。此时
 *   - 白名单存的是**明文根** resolve(junction)      → C:\data
 *   - realpath(区内的文件) 解析到**物理位置**         → C:\real\data\notes\a.md
 * 两侧口径不一致 ⇒ relative() 算出 '..\real\data\...' ⇒ 旧实现抛 EPERM。
 *
 * 用户现象:shell:open-path 报「路径不允许」、rkms:// 协议对所有文件返 403
 * (文献 / PDF / 图片全打不开),而磁盘上的数据好好躺着。
 *
 * 修法见 src/main/ipc/paths.ts 的 isInsideRootsRealpathAware:落点落在
 * 「明文根」**或**「realpath 后的根」之内即放行(与 safe-write.ts 2026-10-01
 * 的同源修法一致);真正的逃逸(root/notes → /etc)两侧都不满足,仍被拒。
 */
describe('G. 根自身是 symlink/junction(数据目录在 OneDrive / mklink /J 下)', () => {
  it('G1 根是 junction 时,区内真实文件不得被判 EPERM', async () => {
    const realRoot = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'rkms-paths-real-')));
    const linkRoot = join(tmpdir(), `rkms-paths-link-${process.pid}-${Date.now()}`);
    await makeLink(realRoot, linkRoot);
    try {
      setRootPath(linkRoot);
      const notes = join(linkRoot, 'notes');
      await fs.mkdir(notes, { recursive: true });
      const file = join(notes, 'a.md');
      await fs.writeFile(file, '# a', 'utf-8');
      // 修前实测:抛 AppError('EPERM', 'path resolves outside allowed roots ...')
      expect(() => assertInsideAllowedRoot(file)).not.toThrow();
      expect(() => assertNotSymlink(file, [resolve(linkRoot)])).not.toThrow();
    } finally {
      setRootPath(root);
      await fs.rm(linkRoot, { recursive: true, force: true });
      await fs.rm(realRoot, { recursive: true, force: true });
    }
  });

  it('G2 根是 junction 时,逃逸 symlink 仍被拒(防线不放松)', async () => {
    const realRoot = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'rkms-paths-real-')));
    const linkRoot = join(tmpdir(), `rkms-paths-link2-${process.pid}-${Date.now()}`);
    await makeLink(realRoot, linkRoot);
    try {
      setRootPath(linkRoot);
      // 把 junction 下的 notes 换成指向区外的 symlink —— 逃逸必须仍被拦
      const notes = join(linkRoot, 'notes');
      await fs.mkdir(notes, { recursive: true });
      await fs.rm(notes, { recursive: true, force: true });
      await makeLink(outside, notes);
      const file = join(notes, 'evil.txt');
      await fs.writeFile(file, 'x', 'utf-8');
      expectAppError(() => assertNotSymlink(file, [resolve(linkRoot)]), 'EPERM');
    } finally {
      setRootPath(root);
      await fs.rm(linkRoot, { recursive: true, force: true });
      await fs.rm(realRoot, { recursive: true, force: true });
    }
  });
});
