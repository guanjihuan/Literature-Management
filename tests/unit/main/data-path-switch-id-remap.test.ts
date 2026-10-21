// tests/unit/main/data-path-switch-id-remap.test.ts
//
// 守卫 r204:切换数据目录后,文献 id 必须重算成新根下的形态。
//
// ── 被守卫的缺陷(用户可见)──────────────────────────────────────────
//   文献 id = 'lit:' + toPosix(absPath) —— 与绝对路径强绑定。切数据目录时:
//     - changeDataPath 是**复制**(旧目录原样保留);
//     - SQLite 库在 userData/index/index.sqlite(全局,不在数据根下)
//       ⇒ 切换**不会**产生新库,DB 里旧根下的文献行全部存活。
//   之后 literature service 重绑 → reload() 重扫新根:
//     - 新根的文件算出新 id → disk-only 分支插新行;
//     - 旧行不在新根的 diskIdSet 里 → db-only 分支,而旧目录的文件**还在**
//       ⇒ existsSync(旧 absPath) 为真 ⇒ 「保留」。
//   ⇒ 同一个 PDF 在 DB 里两行:文献列表**每个 PDF 出现两次**、搜索**结果重复**、
//     ★ 挂在旧 id 那条上(用户在新目录里看到的是没星的那条)。
//
// ── 本测锁的契约 ───────────────────────────────────────────────────
//   A. remapLiteratureIdsForRootSwitch:旧根下的文献行 → **一次**
//      renameResource(旧 id → 新行),新 id / 新 absPath 都是新根下的形态;
//      不在旧根下的行、note 行**一律不动**。
//   B. switchDataPath 必须真的调用它(否则功能只存在于一个没人调的函数里),
//      且顺序是:DB 重算 → favorites 重绑 → ★ 改写 → literature 重扫。
//      ★ 改写**必须**在 favorites.start() 之后(否则改写落回旧目录的副本)。
//
// 边界:真库(electron app.getPath)在测试环境不可用 → resources-repo 整体 mock;
// 被测行为(调哪个 DB 原语、id 算成什么样、顺序对不对)全在 main 层。
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { LiteratureResource, NoteResource, ResourceId } from '../../../src/shared/types';

const state = vi.hoisted(() => ({
  order: [] as string[],
  listResources: vi.fn(() => [] as unknown[]),
  renameResource: vi.fn(
    (_prevId: string, _r: LiteratureResource, _body: string, _abs: string) => {
      state.order.push('db.renameResource');
    },
  ),
  remapIds: vi.fn((_map: Map<string, string>, _pathMap?: Map<string, string>) => {
    state.order.push('favorites.remapIds');
    return 0;
  }),
}));

vi.mock('../../../src/main/db/resources-repo', () => ({
  listResources: state.listResources,
  renameResource: state.renameResource,
}));

vi.mock('../../../src/main/settings/store', () => ({
  changeDataPath: async () => ({ oldPath: 'old', newPath: 'new' }),
  initSettings: async () => ({}),
  resetSettings: () => ({ current: {}, path: '' }),
  captureSettingsSnapshot: () => ({ current: {}, path: '' }),
}));

vi.mock('../../../src/main/db/sqlite', () => ({
  closeDB: () => {},
  initDB: () => {},
}));

vi.mock('../../../src/main/location', () => ({
  writeLocation: async () => {},
}));

vi.mock('../../../src/main/notes/service', () => ({
  getNotesService: () => ({
    start: async () => {
      state.order.push('notes.start');
    },
    stop: async () => {
      state.order.push('notes.stop');
    },
  }),
}));

vi.mock('../../../src/main/workspace/favorites', () => ({
  getFavoritesService: () => ({
    start: async () => {
      state.order.push('favorites.start');
    },
    stop: async () => {
      state.order.push('favorites.stop');
    },
    remapIds: async (map: Map<string, string>, pathMap?: Map<string, string>) => {
      state.remapIds(map, pathMap);
      return 0;
    },
  }),
}));

vi.mock('../../../src/main/literature/literature-service', () => ({
  getLiteratureService: () => ({
    start: async () => {
      state.order.push('literature.start');
    },
    stop: async () => {
      state.order.push('literature.stop');
    },
  }),
}));

import { setRootPath } from '../../../src/main/utils/safe-write';
import {
  remapLiteratureIdsForRootSwitch,
  relUnderRoot,
} from '../../../src/main/settings/root-remap';
import { switchDataPath } from '../../../src/main/settings/migration';

// ⚠ 临时根必须**每次跑测唯一**(mkdtemp):固定目录名会让两次并发的跑测
//   互删对方正在用的目录树 ⇒ 一片 ENOENT / ENOTEMPTY 假红。
//   守卫:tests/unit/main/lint/no-fixed-temp-dir.test.ts
const TMP = await fs.mkdtemp(join(tmpdir(), 'rkms-r204-'));
const OLD_ROOT = join(TMP, 'old');
const NEW_ROOT = join(TMP, 'new');

function litId(absPath: string): string {
  return 'lit:' + absPath.split('\\').join('/');
}

function litRow(absPath: string): LiteratureResource {
  return {
    id: litId(absPath) as ResourceId,
    kind: 'literature',
    title: 'paper.pdf',
    mtime: 1,
    size: 10,
    indexedAt: 0,
    absPath,
    rootId: null,
    extractStatus: 'filename-only',
  };
}

function noteRow(id: string): NoteResource {
  return {
    id: id as ResourceId,
    kind: 'note',
    title: 'n.md',
    mtime: 1,
    size: 10,
    indexedAt: 1,
    relPath: 'n.md',
    tags: [],
  };
}

describe('切换数据目录 → 文献 id 重算(r204)', () => {
  beforeEach(() => {
    state.order.length = 0;
    state.listResources.mockClear();
    state.listResources.mockReturnValue([]);
    state.renameResource.mockClear();
    state.remapIds.mockClear();
  });

  afterEach(() => {
    setRootPath(OLD_ROOT);
  });

  // 跑完把这次唯一的临时根删掉
  afterAll(async () => {
    await fs.rm(TMP, { recursive: true, force: true });
  });

  // === A. remapLiteratureIdsForRootSwitch 的单元行为 ===
  describe('remapLiteratureIdsForRootSwitch', () => {
    it('A1 旧根下的文献行 → 一次 renameResource,id / absPath 都是新根下的形态', () => {
      const oldAbs = join(OLD_ROOT, 'literature', 'paper.pdf');
      const newAbs = join(NEW_ROOT, 'literature', 'paper.pdf');
      state.listResources.mockReturnValue([litRow(oldAbs)]);

      const remaps = remapLiteratureIdsForRootSwitch(OLD_ROOT, NEW_ROOT);

      expect(state.renameResource).toHaveBeenCalledTimes(1);
      const [prevId, next, body, abs] = state.renameResource.mock.calls[0] as [
        string,
        LiteratureResource,
        string,
        string,
      ];
      expect(prevId).toBe(litId(oldAbs));
      expect(next.id).toBe(litId(newAbs));
      expect(next.absPath).toBe(newAbs);
      expect(body).toBe(''); // 文献的 FTS 正文一直是空的
      expect(abs).toBe(newAbs);
      // 返回的映射表供 favorites 改写 fileId / relPath
      expect(remaps).toEqual([{ oldId: litId(oldAbs), newId: litId(newAbs), path: newAbs }]);
    });

    it('A2 不在旧根下的文献行 → 一行都不动(别把别的库的行也改了)', () => {
      const elsewhere = join(TMP, 'other-root', 'literature', 'x.pdf');
      state.listResources.mockReturnValue([litRow(elsewhere)]);

      const remaps = remapLiteratureIdsForRootSwitch(OLD_ROOT, NEW_ROOT);

      expect(state.renameResource).not.toHaveBeenCalled();
      expect(remaps).toEqual([]);
    });

    it('A3 note 行 → 不动(note id 与 relPath 绑定,换根不变)', () => {
      state.listResources.mockReturnValue([noteRow('note:abc')]);

      const remaps = remapLiteratureIdsForRootSwitch(OLD_ROOT, NEW_ROOT);

      expect(state.renameResource).not.toHaveBeenCalled();
      expect(remaps).toEqual([]);
    });

    it('A4 旧根 === 新根 → 直接空转,连 DB 都不查', () => {
      state.listResources.mockReturnValue([litRow(join(OLD_ROOT, 'literature', 'p.pdf'))]);

      const remaps = remapLiteratureIdsForRootSwitch(OLD_ROOT, OLD_ROOT);

      expect(remaps).toEqual([]);
      expect(state.listResources).not.toHaveBeenCalled();
    });

    it('A5 relUnderRoot 边界:兄弟目录(名含 ".." 前缀)与根本身都不算「在根下」', () => {
      expect(relUnderRoot(OLD_ROOT, join(OLD_ROOT, 'literature', 'p.pdf'))).toBe(
        join('literature', 'p.pdf'),
      );
      expect(relUnderRoot(OLD_ROOT, OLD_ROOT)).toBeNull();
      expect(relUnderRoot(OLD_ROOT, join(OLD_ROOT, '..', '..foo', 'p.pdf'))).toBeNull();
      expect(relUnderRoot(OLD_ROOT, join(OLD_ROOT, '..', 'sibling', 'p.pdf'))).toBeNull();
    });
  });

  // === B. switchDataPath 的接线与顺序 ===
  describe('switchDataPath', () => {
    it('B1 切换 → 文献 id 重算 + ★ 的 fileId / relPath 跟着改,且顺序正确', async () => {
      const oldAbs = join(OLD_ROOT, 'literature', 'paper.pdf');
      const newAbs = join(NEW_ROOT, 'literature', 'paper.pdf');
      setRootPath(OLD_ROOT);
      state.listResources.mockReturnValue([litRow(oldAbs)]);

      await switchDataPath(NEW_ROOT);

      // DB 重算发生了一次
      expect(state.renameResource).toHaveBeenCalledTimes(1);
      const [prevId, next] = state.renameResource.mock.calls[0] as unknown as [
        string,
        LiteratureResource,
      ];
      expect(prevId).toBe(litId(oldAbs));
      expect(next.id).toBe(litId(newAbs));

      // ★ 的 fileId + relPath 一起改
      expect(state.remapIds).toHaveBeenCalledTimes(1);
      const [idMap, pathMap] = state.remapIds.mock.calls[0] as [
        Map<string, string>,
        Map<string, string>,
      ];
      expect(idMap.get(litId(oldAbs))).toBe(litId(newAbs));
      expect(pathMap.get(litId(oldAbs))).toBe(newAbs);

      // 顺序:DB 重算 → favorites 重绑 → ★ 改写 → literature 重扫
      const idx = (label: string): number => state.order.indexOf(label);
      expect(idx('db.renameResource')).toBeGreaterThanOrEqual(0);
      expect(idx('db.renameResource')).toBeLessThan(idx('favorites.start'));
      expect(idx('favorites.start')).toBeLessThan(idx('favorites.remapIds'));
      expect(idx('favorites.remapIds')).toBeLessThan(idx('literature.start'));
    });
  });
});
