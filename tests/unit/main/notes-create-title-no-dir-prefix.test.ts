// tests/unit/main/notes-create-title-no-dir-prefix.test.ts
//
// 守 r214「新建笔记的标题只取文件名,不带目录前缀」契约。
//
// ── 被守卫的缺陷(用户可见)──────────────────────────────────────────
//   `createNote(dataPath, filename)` 收到的 `filename` 是**含目录前缀**的
//   relPath(在子文件夹里点「+ 新建」时,渲染端传 'sub/Untitled 1.md',
//   见 r175 的 notes-create-in-folder 契约)。旧实现直接
//   `title = stripExt(fn)`,而 `stripExt` 的契约是**保留目录前缀**
//   (path-utils.ts:它只剥末段的扩展名,不动前面的段)⇒
//   frontmatter.title 变成 'sub/Untitled 1'。
//
//   后果:列表(NotesList)与编辑器标题框显示 'sub/Untitled 1' 而不是
//   'Untitled 1';该 title 同时进 DB 与 FTS ⇒ 搜索结果也带路径。
//   复制粘贴副本走同一形态,同样命中。
//
//   同文件里**三处**「从 relPath 推标题」的写法,口径必须一致:
//     :314 扫描回退  cleanTitle(fm) ?? stripExt(filename)        ← filename 已是末段
//     :944 rename 回退 stripExt(filenameOf(relPath))
//     :489 createNote  stripExt(fn)  ← 唯一漏了 filenameOf 的一处(r214 修)
//
// ── 本测锁的契约 ───────────────────────────────────────────────────
//   A. 在子文件夹里新建('sub/x.md')→ 标题是 'x',不含 'sub/' 前缀;
//   B. 在根目录新建('x.md')→ 标题仍是 'x'(根目录行为不变,防回归);
//   C. 多级目录('a/b/c.md')→ 标题是 'c'(只取末段);
//   D. 文件名本身带空格 / 中文 → 标题只剥扩展名,不动其它字符。
//
// 真库(electron app.getPath)在测试环境不可用 → setRootPath 指到 mkdtemp,
// 直调 standalone.ts 的 createNote(不碰 DB,无需 mock resources-repo)。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import matter from 'gray-matter';

import { setRootPath } from '../../../src/main/utils/safe-write';
import { createNote } from '../../../src/main/notes/standalone';

describe('新建笔记标题不带目录前缀(r214)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'rkms-notetitle-'));
    setRootPath(root);
    await fs.mkdir(join(root, 'notes'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  /** 读回刚创建文件的 frontmatter.title(用户最终看到的标题来源) */
  async function readBackTitle(relPath: string): Promise<unknown> {
    const raw = await fs.readFile(join(root, 'notes', relPath), 'utf-8');
    return matter(raw).data['title'];
  }

  it('A 子文件夹里新建 → 标题是文件名,不含目录前缀', async () => {
    await createNote(root, 'sub/Untitled 1.md');
    expect(await readBackTitle('sub/Untitled 1.md')).toBe('Untitled 1');
  });

  it('B 根目录新建 → 标题是文件名(根目录行为不变,防回归)', async () => {
    await createNote(root, 'a.md');
    expect(await readBackTitle('a.md')).toBe('a');
  });

  it('C 多级目录 → 标题只取末段', async () => {
    await createNote(root, 'a/b/c.md');
    expect(await readBackTitle('a/b/c.md')).toBe('c');
  });

  it('D 中文 / 带空格文件名 → 标题只剥扩展名,不动其它字符', async () => {
    await createNote(root, 'sub/深度学习 综述.md');
    expect(await readBackTitle('sub/深度学习 综述.md')).toBe('深度学习 综述');
  });
});
