// tests/unit/main/rel-path-validation.test.ts
//
// 差分守卫(r186)—— relPath 校验的**四处入口**必须对同一串输入给出
// **同一个判定**,判定来源只有一处(shared/rel-path.ts)。
//
// 背景:仓库里曾有**三份**互不相同的 relPath 校验(shared/rel-path.ts
// 头注有详述):
//   A. src/main/ipc/folders.ts        requireRelPath / requireParentRelPath
//      / requireFolderName
//   B. src/main/notes/standalone.ts   assertTargetRelPath
//   C. src/main/literature/literature-service.ts assertLitTargetRelPath
// 三份规则各说各话,用户能碰到:
//   - 磁盘上有一个名字以**空格开头**的夹(Explorer 随手就能建):
//     侧栏**列得出来**(listSubdirs 不做名字过滤)→ 点进去走 A → A 拒收
//     → VALIDATION 报错 → 这个夹**永远进不去**;
//   - 同一个夹,notes 的 move 走 B → 放行 → 笔记**搬得进去**;
//     文献的 move 走 C → 也放行。
//   ⇒ 「应用能往一个它自己不承认存在的夹里搬数据」—— 数据在,界面找不到。
//
// 本测把同一张输入表喂给各入口,要求判定(放行/拒收)**逐条一致**;
// 判定一旦分叉,说明又有人在本入口之外手写了规则。
//
// 判定形态统一为 'ok' | 'reject'(不看错误类型/消息:三处错误类型本就
// 不同 —— ValidationError vs LibraryError —— 那是各文件自己的翻译层)。
//
// 语义分层(shared/rel-path.ts 的设计,本测照此对齐):
//   - **path 语义**(指向磁盘上**已存在**的东西):不限段长;根 = 空串,
//     取决于调用点是否 allowRoot。
//     → 可比对的三个入口:requireParentRelPath / assertTargetRelPath /
//       assertLitTargetRelPath(三者皆 allowRoot=true)。
//   - **name 语义**(新建/改名的**单段**名字):段长 ≤ MAX_FOLDER_NAME_CHARS。
//     → requireFolderName 与 shared 的 validateFolderName 必须一致。
//   - requireRelPath 是**严格 path 语义**(allowRoot=false,拒绝空串),
//     它与上面三个不可直接对齐 —— 单独与 shared 的 validateRelPath(v)
//     (同样 allowRoot=false)对齐。
//
// 两条不变量(shared/rel-path.ts 头注):
//   I1「能用 name 建的,一定能用 path 进」—— name ⊂ path;
//   I2「列得出来的,一定能进得去」—— listSubdirs 用同一份核心规则过滤。
import { describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('electron', () => ({
  shell: { trashItem: vi.fn(), showItemInFolder: vi.fn() },
  // 本测只碰校验函数,不落盘 —— getPath 不会被真正用到,给个稳定的假路径。
  app: { getPath: vi.fn(() => 'C:/tmp/rkms-rel-path-test') },
}));

vi.mock('../../../src/main/db/resources-repo', () => ({
  deleteResource: vi.fn(),
  listResources: vi.fn(() => []),
  upsertResource: vi.fn(),
}));

import {
  requireRelPath,
  requireFolderName,
  requireParentRelPath,
  requireNewFolderRelPath,
} from '../../../src/main/ipc/folders';
import { assertTargetRelPath } from '../../../src/main/notes/standalone';
import { assertLitTargetRelPath } from '../../../src/main/literature/literature-service';
import {
  validateRelPath,
  validateFolderName,
  isValidRelPathSegment,
  MAX_FOLDER_NAME_CHARS,
} from '../../../src/shared/rel-path';
import { listSubdirs } from '../../../src/main/utils/safe-write';

type Verdict = 'ok' | 'reject';

function verdict(fn: () => unknown): Verdict {
  try {
    fn();
    return 'ok';
  } catch {
    return 'reject';
  }
}

/** 三个「path 语义(allowRoot=true)」入口 —— 必须同进同退。 */
const PATH_ENTRIES: { label: string; check: (v: string) => unknown }[] = [
  { label: 'ipc/folders.requireParentRelPath', check: (v) => requireParentRelPath('ch', v, 'relPath') },
  { label: 'notes/standalone.assertTargetRelPath', check: (v) => assertTargetRelPath(v, 'label') },
  {
    label: 'literature-service.assertLitTargetRelPath',
    check: (v) => assertLitTargetRelPath(v, 'label'),
  },
];

/**
 * 输入表 —— 覆盖 shared/rel-path.ts 头注列出的每一条规则,以及历史上
 * 三份规则**分叉过**的那些串。
 */
const PATH_CASES: { value: string; note: string }[] = [
  { value: 'foo', note: '普通单段' },
  { value: 'foo/bar', note: '两级路径' },
  { value: 'foo/bar/baz', note: '多级路径' },
  { value: ' foo', note: '段首空白 —— 旧 A 拒 / 旧 B、C 放行 ⇒ 统一放行' },
  { value: 'foo ', note: '段尾空白 —— 统一放行' },
  { value: 'a b/c d', note: '路径中间的空格 —— 放行' },
  { value: '资料', note: '中文段' },
  { value: '..', note: '越界段' },
  { value: '../foo', note: '越界段(带子目录)' },
  { value: 'foo/../bar', note: '路径中间的 ..' },
  { value: 'foo..bar', note: '名字里含 ..(不是越界)—— 放行' },
  { value: 'foo/..bar', note: '路径中某段含 .. 但段本身不是 .. —— 放行' },
  { value: '/foo', note: '绝对路径(Unix 形态)' },
  { value: 'C:\\foo', note: '绝对路径(Windows 形态)' },
  { value: 'C:/foo', note: '绝对路径(Windows 混合分隔符)' },
  { value: 'foo//bar', note: '空段(双 /)' },
  { value: 'foo/', note: '结尾多余的 /' },
  { value: '.hidden', note: '隐藏项(点开头)' },
  { value: 'foo/./bar', note: '路径中间的 . 段' },
  { value: 'foo\\bar', note: '反斜杠分段' },
  { value: 'a\u0000b', note: 'NUL 控制字符' },
  { value: 'a\u001fb', note: '其它控制字符' },
  { value: '中文目录', note: '非 ASCII 段' },
  { value: 'a'.repeat(120), note: '超长段(path 语义**不限长** → 放行)' },
];

describe('relPath 校验差分守卫(r186)', () => {
  it('三个 path 语义入口对同一串输入判定一致', () => {
    for (const { value, note } of PATH_CASES) {
      const verdicts = PATH_ENTRIES.map((e) => ({
        label: e.label,
        v: verdict(() => e.check(value)),
      }));
      const first = verdicts[0].v;
      for (const r of verdicts) {
        expect(
          r.v,
          `入口 ${r.label} 对输入 ${JSON.stringify(value)} 的判定应与 ${verdicts[0].label} 一致`,
        ).toBe(first);
      }
      // 判定必须与 shared 的 validateRelPath(allowRoot=true)一致 ——
      // 共享模块是唯一真相源,入口只是翻译层。
      const sharedVerdict = validateRelPath(value, { allowRoot: true }) === null ? 'ok' : 'reject';
      expect(first, `shared 与入口对输入 ${JSON.stringify(value)} 的判定应一致`).toBe(sharedVerdict);
      expect(note.length).toBeGreaterThan(0);
    }
  });

  it('根目录 = 空串:allowRoot=true 放行,allowRoot=false 拒收', () => {
    for (const e of PATH_ENTRIES) {
      expect(verdict(() => e.check(''))).toBe('ok');
    }
    // requireRelPath 是严格 path 语义(不许把 root 传给 IPC 当路径用)
    expect(verdict(() => requireRelPath('ch', '', 'relPath'))).toBe('reject');
    expect(validateRelPath('', { allowRoot: false })).not.toBeNull();
    expect(validateRelPath('', { allowRoot: true })).toBeNull();
  });

  it('requireRelPath 与 shared validateRelPath(严格)判定一致', () => {
    for (const { value } of PATH_CASES) {
      const a = verdict(() => requireRelPath('ch', value, 'relPath'));
      const b = validateRelPath(value) === null ? 'ok' : 'reject';
      expect(a).toBe(b);
    }
  });

  it('name 语义:requireFolderName 与 shared validateFolderName 判定一致', () => {
    const nameCases: string[] = [
      'foo',
      ' foo',
      'foo ',
      '..',
      '.',
      '.hidden',
      'a/b',
      'a\\b',
      'a\u0000b',
      '中文',
      'a..b',
      'a'.repeat(MAX_FOLDER_NAME_CHARS),
      'a'.repeat(MAX_FOLDER_NAME_CHARS + 1),
    ];
    for (const name of nameCases) {
      const a = verdict(() => requireFolderName('ch', name, 'name'));
      const b = validateFolderName(name) === null ? 'ok' : 'reject';
      expect(`${name.slice(0, 12)}:${a}`).toBe(`${name.slice(0, 12)}:${b}`);
    }
  });

  it('不变量 I1:name 严于 path ⇒ 能建的 name 一定能当 path 用', () => {
    const names = ['foo', ' foo', '中文', 'a..b', 'a'.repeat(MAX_FOLDER_NAME_CHARS)];
    for (const name of names) {
      expect(validateFolderName(name)).toBeNull();
      expect(validateRelPath(name, { allowRoot: true })).toBeNull();
    }
    // 反向不成立(也不该成立):path 放行的超长段,name 语义拒收
    expect(validateRelPath('a'.repeat(MAX_FOLDER_NAME_CHARS + 1), { allowRoot: true })).toBeNull();
    expect(validateFolderName('a'.repeat(MAX_FOLDER_NAME_CHARS + 1))).not.toBeNull();
  });

  it('裁决被钉住:历史上分叉的串现在有唯一答案', () => {
    // 段首空白:统一放行(旧 A 拒 / 旧 B、C 放行 ⇒ 夹列得出来进不去)
    expect(verdict(() => requireParentRelPath('ch', ' 资料', 'p'))).toBe('ok');
    expect(verdict(() => assertTargetRelPath(' 资料', 'l'))).toBe('ok');
    expect(verdict(() => assertLitTargetRelPath(' 资料', 'l'))).toBe('ok');
    expect(verdict(() => requireRelPath('ch', ' 资料', 'p'))).toBe('ok');
    // 含 '..' 但不是越界:放行(旧三份都拒 ⇒ 「v1..v2」这类夹列得出来进不去)
    expect(verdict(() => requireRelPath('ch', 'v1..v2', 'p'))).toBe('ok');
    expect(verdict(() => requireFolderName('ch', 'v1..v2', 'n'))).toBe('ok');
    // 真正的越界:仍拒
    expect(verdict(() => requireRelPath('ch', '..', 'p'))).toBe('reject');
    expect(verdict(() => requireRelPath('ch', '../a', 'p'))).toBe('reject');
    expect(verdict(() => requireRelPath('ch', 'a/../b', 'p'))).toBe('reject');
    expect(verdict(() => requireParentRelPath('ch', '..', 'p'))).toBe('reject');
  });

  it('mkdir:叶子段走创建策略(≤100 字符),父段只走路径规则(不限长)', () => {
    // 叶子超长 → 拒(app 自己不造超长名字)
    expect(verdict(() => requireNewFolderRelPath('ch', 'a'.repeat(MAX_FOLDER_NAME_CHARS + 1), 'p'))).toBe(
      'reject',
    );
    expect(verdict(() => requireNewFolderRelPath('ch', 'a'.repeat(MAX_FOLDER_NAME_CHARS), 'p'))).toBe(
      'ok',
    );
    // 父段超长但已存在于磁盘 → 放行(不能因此拒绝「在里面建子夹」)
    expect(
      verdict(() => requireNewFolderRelPath('ch', `${'a'.repeat(150)}/b`, 'p')),
    ).toBe('ok');
  });

  it('核心段规则是唯一的过滤器:listSubdirs 用同一份判据(不变量 I2)', () => {
    // 纯函数层:进不去的名字一律 false
    expect(isValidRelPathSegment('正常')).toBe(true);
    expect(isValidRelPathSegment(' 资料')).toBe(true);
    expect(isValidRelPathSegment('v1..v2')).toBe(true);
    expect(isValidRelPathSegment('.hidden')).toBe(false);
    expect(isValidRelPathSegment('a\\b')).toBe(false);
    expect(isValidRelPathSegment('a\u0000b')).toBe(false);
    expect(isValidRelPathSegment('a\u001fb')).toBe(false);
    expect(isValidRelPathSegment('..')).toBe(false);
  });
});

describe('不变量 I2:列得出来的,一定能进得去(r186)', () => {
  it('磁盘上「段首空白」的夹:列得出来,且列出来的 relPath 进得去', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'rkms-relpath-'));
    try {
      await fs.mkdir(join(root, 'notes', ' 资料'), { recursive: true });
      await fs.mkdir(join(root, 'notes', '正常'), { recursive: true });
      await fs.mkdir(join(root, 'notes', '.hidden'), { recursive: true });

      const dirs = await listSubdirs(root, 'note', null);
      const names = dirs.map((d) => d.name);
      expect(names).toContain(' 资料');
      expect(names).toContain('正常');
      expect(names).not.toContain('.hidden'); // dot 项历来不列

      // 关键:列出来的每个 relPath,都必须能被 IPC 的 path 入口接受 ——
      // 否则用户点进去只会得到一个 VALIDATION 报错(夹里的笔记在夹视图
      // 里看不到 = 数据在、界面找不到)。
      for (const d of dirs) {
        expect(verdict(() => requireParentRelPath('ch', d.relPath, 'parentRelPath'))).toBe('ok');
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('listSubdirs 的过滤判据来自 shared/rel-path(不另写一份正则)', async () => {
    const src = await fs.readFile(
      new URL('../../../src/main/utils/safe-write.ts', import.meta.url),
      'utf8',
    );
    // 判据若在 safe-write 里另写一份,两边迟早分叉 —— 分叉的后果就是
    // 「列得出来、进不去」的夹(用户可见 bug)。
    expect(src).toMatch(/isValidRelPathSegment/);
    expect(src).toMatch(/from '\.\.\/\.\.\/shared\/rel-path'/);
  });
});
