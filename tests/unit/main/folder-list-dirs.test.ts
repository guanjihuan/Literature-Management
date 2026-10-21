// tests/unit/main/folder-list-dirs.test.ts
//
// 守 r174「笔记侧栏一个文件夹都不显示」契约 —— listSubdirs 的物理目录名。
//
// 用户报「笔记中 好像没正常显示文件夹」。根因:listSubdirs 拿 **逻辑 kind**
//   ('note' / 'literature')当磁盘目录名 join,notes 域于是去读
//   <rootPath>/note —— 而笔记真实住在 <rootPath>/notes/(WORKSPACE_DATA_LAYOUT
//   .NOTES_DIR)。readdir ENOENT 被当「空目录」静默吞掉,UI 侧文件夹行恒为
//   0 条,且**全程零报错**。literature 域侥幸:kind 'literature' 恰好等于
//   目录名 'literature',所以只有文献能显示文件夹。
//
// 本测锁三件事:
//   1. kind='note' 读 <root>/notes(不是 <root>/note);
//   2. kind='literature' 读 <root>/literature(回归保护);
//   3. 两域互不串:在错误的目录名(<root>/note)下造夹,不得被列出来。
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { listSubdirs } from '../../../src/main/utils/safe-write';
// 跨层(仅测试内允许,src/** 仍受 layering.test.ts 约束):renderer 侧纯函数
//   —— 树形行合成 + 按 dirname(relPath) 分组。folder-tree.ts / folder-view.ts
//   只 import 类型,不带 React / DOM,node 环境下安全。
//   r176:钻入式的 visibleFolderRows / visibleItemRows 已下线,行合成改由
//   buildTreeRows(树)+ groupItemsByDir(分组)承担。
import {
  buildTreeRows,
  groupItemsByDir,
} from '../../../src/renderer/src/lib/folder-tree';

describe('listSubdirs 的物理目录名(r174)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'rkms-listdirs-'));
    await fs.mkdir(join(root, 'notes', 'sub'), { recursive: true });
    await fs.mkdir(join(root, 'literature', 'lit'), { recursive: true });
    // 诱饵:错误的目录名 —— 修好之前 notes 域读的就是这里
    await fs.mkdir(join(root, 'note', 'decoy'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  it("kind='note' 列出 <root>/notes 的子目录", async () => {
    const dirs = await listSubdirs(root, 'note', null);
    expect(dirs.map((d) => d.name)).toEqual(['sub']);
    expect(dirs[0]?.relPath).toBe('sub');
    expect(dirs[0]?.parentRelPath).toBeNull();
  });

  it("kind='literature' 列出 <root>/literature 的子目录", async () => {
    const dirs = await listSubdirs(root, 'literature', null);
    expect(dirs.map((d) => d.name)).toEqual(['lit']);
  });

  it('诱饵目录 <root>/note 不被列出(kind 与目录名不再混用)', async () => {
    const notes = await listSubdirs(root, 'note', null);
    const lit = await listSubdirs(root, 'literature', null);
    expect(notes.map((d) => d.name)).not.toContain('decoy');
    expect(lit.map((d) => d.name)).not.toContain('decoy');
  });

  it('二级钻入:parentRelPath 走同一套目录名', async () => {
    await fs.mkdir(join(root, 'notes', 'sub', 'deep'), { recursive: true });
    const dirs = await listSubdirs(root, 'note', 'sub');
    expect(dirs.map((d) => d.relPath)).toEqual(['sub/deep']);
    expect(dirs[0]?.parentRelPath).toBe('sub');
  });

  it('目录不存在时返回空数组(不抛)', async () => {
    const dirs = await listSubdirs(root, 'note', 'nope');
    expect(dirs).toEqual([]);
  });

  // === 跨层:磁盘 → renderer 文件夹行 / 笔记归属分组 ===
  //   这条就是用户报的「笔记里没正常显示文件夹」的可观测形态:
  //   磁盘上有目录 + 目录里有笔记,UI 既要出文件夹行,也要在**展开**后
  //   显示目录里的笔记(且根视图不再重复显示它)。
  //   r176:树形态下「进入目录」= 展开,不再是钻入 —— 同一份磁盘数据
  //   喂给 buildTreeRows,折叠时只出文件夹行,展开才带上目录内笔记。
  it('跨层:磁盘目录 → 树行 + 目录内笔记归属(r174 / r176)', async () => {
    await fs.writeFile(join(root, 'notes', 'sub', 'inner.md'), 'x');
    await fs.writeFile(join(root, 'notes', 'top.md'), 'x');
    const summaries = [
      { id: 'i1', relPath: 'sub/inner.md' },
      { id: 'i2', relPath: 'top.md' },
    ];

    const rootDirs = await listSubdirs(root, 'note', null);
    const subDirs = await listSubdirs(root, 'note', 'sub');
    const childrenByDir = new Map<string, typeof rootDirs>([
      ['', rootDirs],
      ['sub', subDirs],
    ]);
    const itemsByDir = groupItemsByDir(summaries);

    // 折叠:只出文件夹行 + 根层笔记(sub 里的笔记不露头)
    const collapsed = buildTreeRows<{ id: string; relPath: string }>({
      childrenByDir,
      itemsByDir,
      expanded: new Set(),
      targetRelPath: null,
      searchActive: false,
    });
    expect(collapsed.map((r) => r.id)).toEqual(['folder:sub', 'i2']);

    // 展开:子目录的笔记作为子行出现(depth 1),根层笔记仍在 depth 0
    const expanded = buildTreeRows<{ id: string; relPath: string }>({
      childrenByDir,
      itemsByDir,
      expanded: new Set(['sub']),
      targetRelPath: null,
      searchActive: false,
    });
    expect(expanded.map((r) => r.id)).toEqual(['folder:sub', 'i1', 'i2']);
    const byId = new Map(expanded.map((r) => [r.id, r]));
    expect(byId.get('i1')?.depth).toBe(1);
    expect(byId.get('i2')?.depth).toBe(0);
  });
});
