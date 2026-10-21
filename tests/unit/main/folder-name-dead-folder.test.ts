// tests/unit/main/folder-name-dead-folder.test.ts
//
// 守 audit 2026-10-21 P1-1:**死夹**(建得出、进不去笔记的文件夹)。
//
// 缺陷(修前):
//   文件夹名的创建策略(shared/rel-path.ts 的 validateFolderName)只查
//   「单段 + 长度 ≤ 100 + 核心段规则」,**一条 Win32 规则都没有**;
//   而 notes 域的**笔记文件名校验**对 relPath 的**每一段**都应用 Win32
//   规则(保留字符 / 控制字符 / 结尾带点 / 结尾带空格 / 保留设备名)。
//   ⇒ 两套规则的差集就是「建得出、但里面放不了任何笔记」的夹:
//
//     'a.'(结尾带点)  'a '(结尾带空格)  'CON'(保留设备名)
//     'a:b' 'a*b' 'a?b' 'a"b' 'a|b'(Win32 保留字符)
//
//   用户在侧栏「新建文件夹」能建成这些夹(validateFolderName 放行);
//   但在这个夹里点「新建笔记」⇒ createNote 收 'a./Untitled 1.md' ⇒
//   段 'a.' 命中「结尾带点」⇒ ValidationError ⇒ **这个夹里永远建不了
//   笔记**(而笔记**搬得进去** —— move 走 assertTargetRelPath,只查核心
//   段规则)。'a:b' 这类更糟:连 fs.mkdir 都会失败 ⇒ 用户看到的是天书级
//   IO 报错,而不是「这个名字不能用」。
//
// 本测锁三条:
//   I3. 能用 name 建的夹,一定能放笔记(跨域不变量:notes 域最严);
//   I3'. 反过来:被拒的名字,notes 域也拒(⇒ 不会造出装不了东西的夹);
//   单一真相源:Win32 规则只在 shared/win32-name.ts 写一次,三个调用点
//   (notes 文件名 / literature 改名 / 文件夹名)都从那里取。
//
// 同时守住**反面**风险:path 语义(指向磁盘上已存在的东西)**不得**因此
// 收紧 —— 磁盘上可能有这些名字(用户用别的工具建的),应用必须能看见
// 并进入它们,否则又变成 r186 的「列得出来进不去」。
import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';

vi.mock('electron', () => ({
  shell: { trashItem: vi.fn(), showItemInFolder: vi.fn() },
  app: { getPath: vi.fn(() => 'C:/tmp/rkms-dead-folder-test') },
}));

vi.mock('../../../src/main/db/resources-repo', () => ({
  deleteResource: vi.fn(),
  listResources: vi.fn(() => []),
  upsertResource: vi.fn(),
}));

import { requireFolderName, requireNewFolderRelPath } from '../../../src/main/ipc/folders';
import { normalizeAndValidateNoteFilename } from '../../../src/main/notes/filename-validator';
import { planLiteratureRename } from '../../../src/main/literature/rename-file';
import { validateFolderName, validateRelPath } from '../../../src/shared/rel-path';

/** 这些名字**建不出来 / 建了也没用** —— 必须在创建时被拒。 */
const DEAD_NAMES: { name: string; why: string }[] = [
  { name: 'a.', why: '结尾带点 —— Win32 静默截断' },
  { name: 'a ', why: '结尾带空格 —— Win32 静默截断' },
  { name: 'CON', why: 'Windows 保留设备名' },
  { name: 'con', why: 'Windows 保留设备名(大小写不敏感)' },
  { name: 'com1', why: 'Windows 保留设备名' },
  { name: 'lpt9', why: 'Windows 保留设备名' },
  { name: 'con.txt', why: '保留设备名 + 扩展名(按词干判)' },
  { name: 'a:b', why: 'Win32 保留字符(而且 mkdir 本身就会失败)' },
  { name: 'a*b', why: 'Win32 保留字符' },
  { name: 'a?b', why: 'Win32 保留字符' },
  { name: 'a"b', why: 'Win32 保留字符' },
  { name: 'a|b', why: 'Win32 保留字符' },
];

/** 这些名字**正常** —— 必须放行,且能装笔记。 */
const OK_NAMES: string[] = [
  'foo',
  '资料',
  '会议纪要 2024',
  'a..b',
  'C++ 学习',
  'v1.2 草稿',
  "O'Brien 访谈",
  '100%完成',
  '结果=最终',
  'A&B',
  '子目录.子目录',
  'COM10', // 保留设备名只到 com9
  'con 夹', // 词干带空格 ⇒ 不是保留设备名
];

/** 文献**文件名**(不是夹名)里建不出来的名字。 */
const LIT_DEAD_FILES: string[] = [
  'a<b.pdf',
  'a>b.pdf',
  'CON.pdf',
  'con.txt.pdf',
  'a?.pdf',
  'a|.pdf',
  'a*.pdf',
  'a".pdf',
  'a:b.pdf',
];

describe('文件夹名:死夹守卫(audit 2026-10-21 P1-1)', () => {
  it('I3:能用 name 建的夹,一定能放笔记(notes 域最严 ⇒ 它过了就都过了)', () => {
    for (const name of OK_NAMES) {
      expect(validateFolderName(name), `名字 ${JSON.stringify(name)} 应当放行`).toBeNull();
      // 在这个夹里新建笔记:createNote 收的是含目录的 relPath ⇒
      // 文件名校验会逐段检查,**父目录段也在内** ⇒ 这里过了才叫「能放」。
      expect(
        () => normalizeAndValidateNoteFilename(`${name}/Untitled.md`, 'filename'),
        `夹 ${JSON.stringify(name)} 里必须能建笔记`,
      ).not.toThrow();
    }
  });

  it('死夹名单:创建时必须被拒(mkdir / rename-dir 两条入口一致)', () => {
    for (const { name, why } of DEAD_NAMES) {
      expect(validateFolderName(name), `${name}(${why})应当被拒`).not.toBeNull();
      expect(() => requireFolderName('ch', name, 'name'), `${name}(${why})IPC 入口应拒`).toThrow();
      // mkdir 的叶子段也走同一份策略
      expect(
        () => requireNewFolderRelPath('ch', `父/${name}`, 'relPath'),
        `${name}(${why})mkdir 叶子段应拒`,
      ).toThrow();
    }
  });

  it('I3 逆向:被拒的名字,notes 域也拒 ⇒ 不会造出装不了东西的夹', () => {
    for (const { name } of DEAD_NAMES) {
      expect(
        () => normalizeAndValidateNoteFilename(`${name}/Untitled.md`, 'filename'),
        `${name} 既然建不出来,notes 域也不该能建笔记`,
      ).toThrow();
    }
  });

  it('文献域同款:文件改名进不去这些名字(文献侧不留半套规则)', () => {
    for (const name of LIT_DEAD_FILES) {
      expect(
        () => planLiteratureRename('/tmp/old.pdf', name),
        `文献改名 ${name} 应被拒`,
      ).toThrow();
    }
    // 对照:'a..pdf' 是**合法**文件名(点不在结尾)⇒ 不能连它一起拒。
    expect(planLiteratureRename('/tmp/old.pdf', 'a..pdf').newFilename).toBe('a..pdf');
  });

  it('反面风险:path 语义**不得**收紧(磁盘上已有的这些名字必须进得去)', () => {
    // r186 的不变量 I2:「列得出来的,一定能进得去」。磁盘上可能有
    // 外部工具建的 'a.' / 'CON' 目录 ⇒ path 语义必须放行,否则它们
    // 会从列表里消失(数据在、界面找不到 = 更糟的洞)。
    for (const { name } of DEAD_NAMES) {
      expect(
        validateRelPath(name, { allowRoot: true }),
        `path 语义必须放行 ${name}(只有**创建**策略才拒)`,
      ).toBeNull();
    }
  });

  it('单一真相源:Win32 规则只在 shared/win32-name.ts 写一次', async () => {
    const files = [
      '../../../src/main/notes/filename-validator.ts',
      '../../../src/main/literature/rename-file.ts',
      '../../../src/shared/rel-path.ts',
    ];
    for (const rel of files) {
      const src = await fs.readFile(new URL(rel, import.meta.url), 'utf8');
      // 规则一旦有人在自己文件里再抄一份,三处迟早分叉 ⇒ 又出现
      // 「一个域能建、另一个域不能建」的洞(这次的坑就是抄漏第三处)。
      expect(
        src,
        `${rel} 不得自抄 Win32 规则常量`,
      ).not.toMatch(/const\s+\w*(FORBIDDEN|RESERVED|DEVICE|CONTROL_CHARS)\w*\s*=/);
      // 三处都得从 win32-name 取判据
      expect(src, `${rel} 必须从 shared/win32-name 取判据`).toMatch(/win32-name/);
    }
    const win32 = await fs.readFile(
      new URL('../../../src/shared/win32-name.ts', import.meta.url),
      'utf8',
    );
    expect(win32).toMatch(/WIN32_FORBIDDEN_CHARS/);
    expect(win32).toMatch(/RESERVED_DEVICE_NAME/);
  });
});
