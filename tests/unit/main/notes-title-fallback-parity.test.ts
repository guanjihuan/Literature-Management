// tests/unit/main/notes-title-fallback-parity.test.ts
//
// 守 r222「无标题笔记的 title 兜底口径」契约。
//
// ── 被守卫的缺陷 ───────────────────────────────────────────────────
//   「笔记没有 fm.title 时显示什么」在代码里曾有**三个口径**:
//     ① scan(readNoteHeader,standalone.ts):cleanTitle(fm) ?? stripExt(filename)
//       —— 去扩展名的文件名;
//     ② read(readNote):cleanTitle(fm) —— 允许 null(编辑器靠 null 显示
//       占位符,且**不能把兜底值写回 fm.title**,这个 null 是语义载体);
//     ③ DB 写入(noteResourceOf,service.ts):n.title ?? n.filename
//       —— **带 .md 扩展名**!
//   ③只在「行来自 readNote/writeNote(title 可为 null)」时触发 ⇒ 无标题
//   笔记每次保存后,resources.title 在 'foo'(scan 写的)与 'foo.md'
//   (save 写的)之间**翻转**,FTS SearchHit.title 跟着翻,搜索结果显示
//   带扩展名的标题,与其它条目不一致。
//   另一个同源缺口:cleanTitle 对外部手改的 `title: ""` / 纯空白返回 ''
//   —— '' 不是 null,所有 `?? 兜底` 对它失效 ⇒ 列表/DB/搜索出现空标题。
//
//   修法(r222):
//     - noteResourceOf 兜底改 stripExt(n.filename),与 scan 同口径;
//     - cleanTitle 把空串/纯空白归一为 null(写路径 writeNote 的
//       `title.trim() || undefined` 本就写不出空 title,只有外部手改能
//       造出来)。
//
// ── 本测锁四件事 ───────────────────────────────────────────────────
//   A. 无标题外部笔记 **save 后** DB title 仍是 stripExt 文件名(修前红:
//      HEAD 写成 'foo.md');
//   B. fm.title = ''(外部手改)⇒ scan 列表标题走文件名兜底(修前红:
//      HEAD 给出空串);
//   C. 有 fm.title 的笔记:scan 列表 + save 后 DB title 都不变(回归锚);
//   D. 无标题外部笔记 scan 后 DB title = stripExt 文件名(回归锚,scan
//      路径本来就是对的那一边)。
//
// 真库(electron app.getPath)在测试环境不可用 → resources-repo 整体 mock
// 成内存 Map(与 notes-reload-db-sync.test.ts 同款 harness)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

interface FakeRow {
  id: string;
  kind: string;
  title: string;
  relPath: string;
  mtime: number;
  indexedAt: number;
  body: string;
  absPath: string;
}

const db = vi.hoisted(() => {
  const rows = new Map<string, FakeRow>();
  return { rows };
});

vi.mock('../../../src/main/db/resources-repo', () => ({
  upsertResource: vi.fn((r: FakeRow, body: string, absPath: string) => {
    db.rows.set(r.id, { ...r, body, absPath });
  }),
  deleteResource: vi.fn((id: string) => {
    db.rows.delete(id);
  }),
  listResources: vi.fn((kind?: string) =>
    [...db.rows.values()].filter((r) => !kind || r.kind === kind),
  ),
  listResourceRelPaths: vi.fn((kind: string) =>
    [...db.rows.values()].filter((r) => r.kind === kind).map((r) => r.relPath),
  ),
  listStaleIndexIds: vi.fn((kind: string) =>
    [...db.rows.values()].filter((r) => r.kind === kind && r.indexedAt === 0).map((r) => r.id),
  ),
  renameResource: vi.fn((prevId: string, r: FakeRow, body: string, absPath: string) => {
    db.rows.delete(prevId);
    db.rows.set(r.id, { ...r, body, absPath });
  }),
}));

// electron 需整体 mock:safe-write 用 shell.trashItem(节点环境没有真回收站)
vi.mock('electron', () => ({
  shell: {
    trashItem: async (target: string) => {
      const { rename } = await import('fs/promises');
      const { basename, join: j } = await import('path');
      const trashDir = j(target, '..', '..', '.trash');
      await fs.mkdir(trashDir, { recursive: true });
      await rename(target, j(trashDir, basename(target)));
    },
  },
}));

import { setRootPath } from '../../../src/main/utils/safe-write';
import { NotesService } from '../../../src/main/notes/service';
import { noteResourceId } from '../../../src/shared/resource-id';

describe('无标题笔记的 title 兜底口径(r222)', () => {
  let root: string;
  let notesDir: string;
  let svc: NotesService;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'rkms-notetitle-'));
    setRootPath(root);
    notesDir = join(root, 'notes');
    await fs.mkdir(notesDir, { recursive: true });
    db.rows.clear();
    svc = new NotesService();
    await svc.start({ skipInitialLoad: true });
  });

  afterEach(async () => {
    await svc.stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('A 无标题外部笔记 save 后 DB title 仍是 stripExt 文件名(不带 .md)', async () => {
    // 外部丢进来的纯 markdown,没有 frontmatter ⇒ fm.title 缺失
    await fs.writeFile(join(notesDir, 'plain.md'), '# 外部笔记\n\n正文\n', 'utf-8');
    await svc.load();
    const note = svc.list()[0];
    expect(note).toBeDefined();
    const rowId = noteResourceId(note!.id);
    expect(db.rows.get(rowId)?.title).toBe('plain'); // scan 路径(对的那一边)

    // 应用内保存一次(不写 title ⇒ preserveExisting 保持无 title)
    await svc.write(note!.id, '# 外部笔记\n\n正文,改过了\n');

    expect(
      db.rows.get(rowId)?.title,
      'save 路径的 DB 兜底把扩展名写进 title ⇒ 搜索结果显示 plain.md,与列表的 plain 翻转',
    ).toBe('plain');
  });

  it("B fm.title = ''(外部手改)⇒ 列表标题走文件名兜底,不是空串", async () => {
    await fs.writeFile(
      join(notesDir, 'blank-title.md'),
      '---\ntitle: ""\n---\n\n正文\n',
      'utf-8',
    );
    await svc.load();
    const note = svc.list()[0];
    expect(
      note?.title,
      "cleanTitle 把 '' 当有效标题返回 ⇒ ?? 兜底失效 ⇒ 列表空标题",
    ).toBe('blank-title');
    // DB 同样不许是空串
    expect(db.rows.get(noteResourceId(note!.id))?.title).toBe('blank-title');
  });

  it('C 有 fm.title 的笔记:列表与 save 后 DB title 都保持 fm.title(回归锚)', async () => {
    await fs.writeFile(
      join(notesDir, 'titled.md'),
      '---\ntitle: 我的标题\n---\n\n正文\n',
      'utf-8',
    );
    await svc.load();
    const note = svc.list()[0];
    expect(note?.title).toBe('我的标题');
    await svc.write(note!.id, '正文,改过了\n');
    expect(db.rows.get(noteResourceId(note!.id))?.title).toBe('我的标题');
  });

  it('D 无标题外部笔记 scan 后 DB title = stripExt 文件名(回归锚)', async () => {
    await fs.writeFile(join(notesDir, 'scanned.md'), '正文,连标题行都没有\n', 'utf-8');
    await svc.load();
    const note = svc.list()[0];
    expect(note?.title).toBe('scanned');
    expect(db.rows.get(noteResourceId(note!.id))?.title).toBe('scanned');
  });
});
