// tests/unit/main/notes-name-manageable.test.ts
//
// 守 r195「侧栏列得出来的笔记,应用也得管得了」—— 字符集这一层的
// 不变式 I2(与 r186 在文件夹层修的同一个洞)。
//
// 现象(用户可复现):
//   1. 用户从 Obsidian / 网盘同步 / 同事的机器上拷来一批 .md,名字里带
//      '&' '+' '=' '%' "'" '#' '.' 之类(「C++ 学习.md」「v1.2 草稿.md」
//      「A&B.md」「100%完成.md」……);
//   2. 放进工作区的 notes/ 目录 → 侧栏**照常列出来**(collectNotePaths
//      只按后缀收,不做字符过滤);
//   3. 但把**同样的文件**拖进应用导入 → ValidationError「文件名包含非法
//      字符」⇒ **文件根本进不来**;想把笔记改名成这种名字 → 同样被拒。
//   ⇒ 「看得见、管不了」—— 与用户诉求「列表 == 文件夹、文件操作要对得上」
//      直接冲突。
//
// 根因:notes 域的文件名校验是一条**白名单 regex**(只收字母/数字/下划线/
//   连字符/空格/圆括号/中文),而文献域(literature/rename-file.ts)只拒
//   Win32 真正不能用的 `< > : " | ? *` + 控制字符 ⇒ 同一个字符,一边行
//   一边不行(两侧不对齐)。
//
// 本测锁(行为级,直接对着磁盘事实说话):
//   1. 这些真实存在的文件名**必须被 scanNotes 列出来**(列表侧);
//   2. 同一个名字**必须能通过 validator**(⇒ 可导入 / 可改名)—— 两边一致;
//   3. 真的建不出来的形态(Win32 保留字符 / 控制字符 / '..' 段 / 隐藏段 /
//      保留设备名 / 超长)**仍然被拒**(不能因为放宽就把洞打开)。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { scanNotes } from '../../../src/main/notes/standalone';
import { normalizeAndValidateNoteFilename } from '../../../src/main/notes/filename-validator';
import { WORKSPACE_DATA_LAYOUT } from '../../../src/shared/types';
import { stripExt } from '../../../src/shared/path-utils';

// 真实世界里极常见的学术笔记名 —— 旧白名单 regex 一个都过不了。
const TRICKY_NAMES = [
  'A&B.md',
  'C++ 学习.md',
  'v1.2 草稿.md',
  '100%完成.md',
  "O'Brien 访谈.md",
  '结果=最终.md',
  '2024-06-01 会议 #3.md',
  '数据+分析.md',
  'Q&A 记录.md',
  '论文（终稿）.md',
];

describe('笔记文件名:列得出来就得管得了(r195)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'rkms-notes-name-'));
    await fs.mkdir(join(root, WORKSPACE_DATA_LAYOUT.NOTES_DIR), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('列在侧栏里的名字,必须同时能通过导入 / 改名校验', async () => {
    for (const name of TRICKY_NAMES) {
      await fs.writeFile(join(root, WORKSPACE_DATA_LAYOUT.NOTES_DIR, name), '# body\n', 'utf-8');
    }

    // 1) 列表侧:全部列出来
    const notes = await scanNotes(root);
    const listed = new Set(notes.map((n) => n.filename));
    for (const name of TRICKY_NAMES) {
      expect(listed.has(name), `${name} 应当被 scanNotes 列出来`).toBe(true);
    }

    // 2) 操作侧:同一个名字必须能过 validator(导入走 field='filename',
    //    改名走 field='newFilename' —— 两个入口都要过)
    for (const name of TRICKY_NAMES) {
      const stem = stripExt(name);
      expect(() => normalizeAndValidateNoteFilename(stem, 'filename')).not.toThrow();
      expect(() => normalizeAndValidateNoteFilename(stem, 'newFilename')).not.toThrow();
    }
  });

  it('建不出来的形态仍然被拒(放宽字符集不能把洞打开)', () => {
    const bad: Array<[string, 'filename' | 'newFilename']> = [
      ['a:b.md', 'filename'], // Win32 保留字符
      ['a*b.md', 'filename'],
      ['a?b.md', 'filename'],
      ['a<b.md', 'filename'],
      ['a>b.md', 'filename'],
      ['a|b.md', 'filename'],
      ['a"b.md', 'filename'],
      ['a\\b.md', 'filename'], // 反斜杠 = 路径分隔符
      ['a\u0001b.md', 'filename'], // 控制字符
      ['../evil.md', 'filename'], // 路径穿越
      ['a/../evil.md', 'filename'],
      ['a//b.md', 'filename'], // 空段
      ['.hidden.md', 'filename'], // 隐藏项(collectNotePaths 也跳过)
      ['sub./a.md', 'filename'], // Win32 静默截断
      ['sub /a.md', 'filename'],
      ['con.md', 'filename'], // Windows 保留设备名
      ['con.txt.md', 'filename'], // 词干是 con
      ['com1.md', 'filename'],
    ];
    for (const [name, field] of bad) {
      expect(() => normalizeAndValidateNoteFilename(name, field), name).toThrow();
    }
  });

  it('改名只改文件名、不改位置(r175 不变式):名字里不许带路径分隔符', () => {
    expect(() => normalizeAndValidateNoteFilename('sub/x.md', 'newFilename')).toThrow();
    // 新建到子目录仍然允许 '/' (create 路径靠它)
    expect(normalizeAndValidateNoteFilename('sub/x.md', 'filename')).toBe('sub/x.md');
  });
});
