// tests/unit/main/notes-import-frontmatter.test.ts
//
// 守 r197「笔记导入不许丢元数据 / 不许因路径形态被静默跳过」契约。
//
// 背景(两个独立缺口,都在 notes/import.ts):
//
//   缺口①**元数据丢失**:旧实现把源 frontmatter 收窄成只剩 title + tags
//     两个键就写盘 ⇒ 源文件里的 doi / year / author / citekey / status
//     全部**静默丢弃**。用户从 Obsidian / Zotero 插件导出的研究笔记,
//     那些元数据进应用就没了(正文没有、frontmatter 也没有 = 永久丢失)。
//     同一个契约在**保存**路径上 2026-10-04 已经修过(writeNote 用
//     existingFm 垫底),导入是这条契约的**入口缺口**。
//
//   缺口②**路径形态被误判为 symlink**:旧实现用
//     `realpathSync(sourcePath) !== sourcePath` 判「文件被 symlink 重定向」,
//     而 realpathSync 在 Windows 上**永远返反斜杠**形态 ⇒ 只要传进来的
//     路径是正斜杠形态(笔记被搬动过一次后 relPath 就是 POSIX 形态),
//     就恒不相等 ⇒ **静默 skip**(用户看到「拖进来没反应」)。
//     文献侧 r175 已查清并改成 inode/dev 比对,笔记侧这次跟上。
//
// 真库(electron app.getPath)在测试环境不可用 → 本用例只碰 notes/import.ts
// 与 standalone.ts(都不碰 DB),故无需 mock resources-repo。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import matter from 'gray-matter';

import { setRootPath } from '../../../src/main/utils/safe-write';
import { importNoteFromFile } from '../../../src/main/notes/import';

describe('笔记导入(r197)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'rkms-noteimport-'));
    setRootPath(root);
    await fs.mkdir(join(root, 'notes'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('源 frontmatter 的研究元字段(doi/year/author/citekey/status)必须原样保留', async () => {
    const src = join(root, 'paper.md');
    await fs.writeFile(
      src,
      [
        '---',
        'title: 深度学习综述',
        'tags: [ml, review]',
        'doi: 10.1234/abc',
        'year: 2024',
        'author: 张三',
        'citekey: zhang2024dl',
        'status: reading',
        '---',
        '',
        '正文内容',
      ].join('\n'),
      'utf-8',
    );

    const res = await importNoteFromFile(src, root);
    expect(res.copied).toBe(1);
    const relPath = res.createdRelPaths?.[0];
    expect(relPath).toBeTruthy();

    const raw = await fs.readFile(join(root, 'notes', relPath as string), 'utf-8');
    const fm = matter(raw).data as Record<string, unknown>;
    // 旧实现只剩 title / tags —— 这五个键全丢
    expect(fm['doi']).toBe('10.1234/abc');
    expect(fm['year']).toBe(2024);
    expect(fm['author']).toBe('张三');
    expect(fm['citekey']).toBe('zhang2024dl');
    expect(fm['status']).toBe('reading');
    // 已有键不受影响
    expect(fm['title']).toBe('深度学习综述');
    expect(fm['tags']).toEqual(['ml', 'review']);
  });

  it('源 frontmatter 的 id 必须被重钉成「按 relPath 算的 id」(不能沿用源 id)', async () => {
    const src = join(root, 'with-id.md');
    await fs.writeFile(
      src,
      ['---', 'id: stale-source-id', 'title: T', '---', '', 'body'].join('\n'),
      'utf-8',
    );
    const res = await importNoteFromFile(src, root);
    expect(res.copied).toBe(1);
    const relPath = res.createdRelPaths?.[0] as string;
    const raw = await fs.readFile(join(root, 'notes', relPath), 'utf-8');
    const fm = matter(raw).data as Record<string, unknown>;
    expect(fm['id']).not.toBe('stale-source-id');
    expect(String(fm['id'])).toMatch(/^[0-9a-f]{16}$/);
  });

  it('正斜杠形态的源路径必须能导入(旧 realpath 比对恒为真 ⇒ 静默 skip)', async () => {
    const srcNative = join(root, 'posix.md');
    await fs.writeFile(srcNative, ['---', 'title: POSIX', '---', '', 'body'].join('\n'), 'utf-8');
    // 同一文件,路径写成正斜杠形态(Windows 上 realpathSync 返反斜杠 ⇒
    // 旧实现恒判「symlink 分流」⇒ skipped=1)
    const srcPosix = srcNative.replace(/\\/g, '/');
    expect(srcPosix).not.toBe(srcNative);

    const res = await importNoteFromFile(srcPosix, root);
    expect(res.copied).toBe(1);
    expect(res.skipped).toBe(0);
    const relPath = res.createdRelPaths?.[0] as string;
    const raw = await fs.readFile(join(root, 'notes', relPath), 'utf-8');
    expect(matter(raw).data['title']).toBe('POSIX');
  });

  it('非 .md 后缀仍拒收(契约不因本轮改动而松动)', async () => {
    const src = join(root, 'note.txt');
    await fs.writeFile(src, 'hello', 'utf-8');
    await expect(importNoteFromFile(src, root)).rejects.toMatchObject({
      code: 'IO_ERROR',
    });
  });
});
