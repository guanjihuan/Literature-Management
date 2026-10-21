// tests/unit/main/favorites-malformed-entries.test.ts
//
// 守 r197「favorites.md 形态非法不得静默销毁用户收藏」契约。
//
// favorites.md 是**支持手编**的文件(文件头注明「人类可读优先」)。手编时
// 把 frontmatter.entries 写成映射 / 留空 / 写成字符串,是极常见的笔误。
//
// 旧实现(favorites.ts parse):
//   const entries = Array.isArray(fm.entries) ? fm.entries : [];
// ⇒ 形态非法被降级成**空列表**,解析**不抛错** ⇒ AtomicFile.start() 的
//   quarantine 分支不触发 ⇒ 下一次 ★ toggle 就拿空内存态 persist 覆盖整个
//   文件 ⇒ 用户的收藏**永久消失**,磁盘上没有 .corrupt 备份,日志里只有
//   一条 warn(用户视角:「收藏全没了」)。
//
// 本测锁:形态非法 → parse 抛错 → AtomicFile 走 quarantine(原文件被改名成
// `.corrupt-<ts>` 保留内容)→ 随后的 toggle 覆盖的是**新**文件,原数据仍在。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('electron', () => ({
  ipcMain: { handle: () => undefined },
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
import { FavoritesService } from '../../../src/main/workspace/favorites';
import { WORKSPACE_DATA_LAYOUT } from '../../../src/shared/types';

describe('favorites.md 形态非法(r197)', () => {
  let root: string;
  let favPath: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'rkms-favmal-'));
    setRootPath(root);
    favPath = join(root, WORKSPACE_DATA_LAYOUT.FAVORITES_FILE);
    await fs.mkdir(join(favPath, '..'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('entries 不是数组 → 原文件被 quarantine 成 .corrupt-*,内容不丢', async () => {
    const original = [
      '---',
      'schemaVersion: 1',
      'entries:',
      '  a: 1',
      '---',
      '',
      '# 收藏',
      '',
    ].join('\n');
    await fs.writeFile(favPath, original, 'utf-8');

    const fav = new FavoritesService();
    await fav.start();
    try {
      // 内存态回落空列表(功能降级但**不崩**)
      expect(fav.listEntries()).toEqual([]);

      // 关键:原文件被改名保留,不是原地被覆盖
      const siblings = await fs.readdir(join(favPath, '..'));
      const quarantined = siblings.filter((n) => n.startsWith('favorites.md.corrupt-'));
      expect(quarantined).toHaveLength(1);
      const kept = await fs.readFile(join(favPath, '..', quarantined[0] as string), 'utf-8');
      expect(kept).toBe(original);
    } finally {
      await fav.stop();
    }
  });

  it('形态非法后再 toggle:覆盖的是新文件,quarantine 备份仍在', async () => {
    await fs.writeFile(
      favPath,
      ['---', 'schemaVersion: 1', 'entries:', '  a: 1', '---', '', 'x', ''].join('\n'),
      'utf-8',
    );
    const fav = new FavoritesService();
    await fav.start();
    try {
      await fav.toggle('lit:abc', { title: 'T', relPath: 'p.pdf' });
      // 新文件被正常写入
      const fresh = await fs.readFile(favPath, 'utf-8');
      expect(fresh).toContain('lit:abc');
      // 旧数据仍以 .corrupt-* 形式保留(用户还能手工抢救)
      const siblings = await fs.readdir(join(favPath, '..'));
      expect(siblings.filter((n) => n.startsWith('favorites.md.corrupt-'))).toHaveLength(1);
    } finally {
      await fav.stop();
    }
  });

  it('正常数组 entries → 不 quarantine(契约不因本轮改动而松动)', async () => {
    const good = [
      '---',
      'schemaVersion: 1',
      'entries:',
      '  - kind: file',
      '    id: e1',
      '    fileId: lit:x',
      '    title: T',
      '    relPath: p.pdf',
      '    addedAt: 2024-01-01T00:00:00.000Z',
      '---',
      '',
      '# 收藏',
      '',
    ].join('\n');
    await fs.writeFile(favPath, good, 'utf-8');
    const fav = new FavoritesService();
    await fav.start();
    try {
      expect(fav.listEntries()).toHaveLength(1);
      const siblings = await fs.readdir(join(favPath, '..'));
      expect(siblings.filter((n) => n.startsWith('favorites.md.corrupt-'))).toHaveLength(0);
    } finally {
      await fav.stop();
    }
  });
});
