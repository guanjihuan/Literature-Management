// tests/unit/main/db-id-swap-atomicity.test.ts
//
// 守卫 r201:资源「换 id」的 DB 写入必须是**一次事务**,不是两次独立事务。
//
// 背景(文献侧的真实 bug,本轮修):
//   文献的 id = 'lit:' + toPosix(absPath) ⇒ 改名 / 搬移都会换 id,
//   DB 里必须「删旧行 + 写新行」。旧实现是**两个独立事务**:
//     deleteResource(旧 id);        // 事务 1
//     upsertResource(新行);         // 事务 2
//   中间任何失败(DB 忙 / 磁盘满 / FTS 报错 / 进程被杀)都会留下**三态漂移**:
//     磁盘文件在新路径、DB 里旧行没了新行没进、内存 byId 还指着旧 id
//     ⇒ 这条文献从列表和搜索里**凭空消失**,而磁盘没动
//     ⇒ **没有任何 watcher 事件能触发自愈**(搬移期间 watcher 是被主动
//        释放的),要等下次启动 resync 差集才回来。
//   笔记侧一直用 `renameResource`(单事务「upsert 新行 + 删旧行」),文献侧
//   漏了 —— 两侧语义不一致。
//
// 本测锁的契约:
//   A. 文献改名 / 搬移 / 目录搬移 → DB 只发生**一次** renameResource 调用,
//      **不再**出现独立的 deleteResource / upsertResource;
//   B. **DB 写失败时不得留下半状态**:renameResource 抛错 ⇒ 错误上抛给
//      调用方,且 deleteResource **从未**被调用(⇒ 旧行还在 DB 里,不是
//      「旧行已删、新行未写」)。这条在旧实现下**必红**:deleteResource 已经
//      先执行了。
//   C. 笔记侧:改名 / 搬移的 DB 换键与 byId 换键走**同一份** helper
//      (applyNoteIdSwap),不再各写一份 —— 旧实现是 renameFile / moveFile
//      两处逐字重复(只差 log 文案与 i18n key),改一边漏另一边 = 「重命名
//      同步了 DB、搬移没同步」。
//
// 真库(electron app.getPath)在测试环境不可用 → resources-repo 整体 mock;
// 被测行为(调用哪个 DB 原语、失败时留下什么)全在 service 内。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readFileSync } from 'fs';

const repo = vi.hoisted(() => ({
  upsertResource: vi.fn(),
  deleteResource: vi.fn(),
  listResources: vi.fn(() => [] as unknown[]),
  listResourceRelPaths: vi.fn(() => [] as string[]),
  listStaleIndexIds: vi.fn(() => [] as string[]),
  renameResource: vi.fn(),
}));

vi.mock('../../../src/main/db/resources-repo', () => ({
  upsertResource: repo.upsertResource,
  deleteResource: repo.deleteResource,
  listResources: repo.listResources,
  listResourceRelPaths: repo.listResourceRelPaths,
  listStaleIndexIds: repo.listStaleIndexIds,
  renameResource: repo.renameResource,
}));

// chokidar mock(audit-r229):真 watcher 会在测试写文件时异步发 'add'/'change',
//   排一次 reload ⇒ reload 走 upsertResource ⇒ 本文件「换 id 不得出现独立
//   upsertResource」的断言变成**竞态**:全量跑测时机器负载高、awaitWriteFinish
//   的轮询被拖慢,reload 恰好落在 mockClear() 之后 ⇒ A3 偶发红
//   (实测:单跑 6/6 绿,全量跑 A3 红,报 upsertResource 被调用 1 次,
//   参数是 import 阶段那一行)。mock 掉 watcher 让 reload 只由测试显式驱动 ——
//   与 tests/unit/main/literature-stat-refresh.test.ts 同一处置(r212 的教训)。
vi.mock('chokidar', () => {
  const watch = vi.fn(() => {
    const w = {
      on: () => w,
      close: vi.fn(async () => {}),
      removeAllListeners: vi.fn(),
    };
    return w;
  });
  return { default: { watch }, watch };
});

import { setRootPath } from '../../../src/main/utils/safe-write';
import { NotesService } from '../../../src/main/notes/service';
import { LiteratureService } from '../../../src/main/literature/literature-service';

describe('资源换 id 的 DB 写入必须同事务(r201)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'rkms-idswap-'));
    setRootPath(root);
    await fs.mkdir(join(root, 'notes'), { recursive: true });
    await fs.mkdir(join(root, 'literature'), { recursive: true });
    repo.upsertResource.mockClear();
    repo.deleteResource.mockClear();
    repo.renameResource.mockClear();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  // === 文献侧(本轮修的真实 bug)===
  describe('LiteratureService —— 换 id 走单事务', () => {
    let lit: LiteratureService;

    beforeEach(async () => {
      lit = new LiteratureService();
      await lit.start({ skipInitialLoad: true });
    });

    afterEach(async () => {
      await lit.stop();
    });

    async function importPaper(name: string): Promise<string> {
      const src = join(root, name);
      await fs.writeFile(src, 'PDF-BYTES', 'utf-8');
      const imported = await lit.importFile(src);
      return imported.id;
    }

    it('A1 改名 → DB 只发生一次 renameResource(旧 id → 新行),无独立 delete/upsert', async () => {
      const id = await importPaper('paper.pdf');
      // 导入本身会调 upsertResource 写新行 —— 清掉计数,只断言「改名这一步」
      repo.upsertResource.mockClear();
      repo.deleteResource.mockClear();
      repo.renameResource.mockClear();

      const renamed = await lit.renameFile(id as never, 'thesis');

      expect(repo.renameResource).toHaveBeenCalledTimes(1);
      expect(repo.renameResource).toHaveBeenCalledWith(
        id,
        expect.objectContaining({ id: renamed.id }),
        '',
        expect.stringContaining('thesis.pdf'),
      );
      // 两个独立事务的调用**不许**再出现
      expect(repo.deleteResource).not.toHaveBeenCalled();
      expect(repo.upsertResource).not.toHaveBeenCalled();
    });

    it('A2 搬进子目录 → 同样只发生一次 renameResource', async () => {
      const id = await importPaper('paper.pdf');
      repo.upsertResource.mockClear();
      repo.deleteResource.mockClear();
      repo.renameResource.mockClear();

      const moved = await lit.moveFile(id as never, 'sub');

      expect(repo.renameResource).toHaveBeenCalledTimes(1);
      expect(repo.renameResource).toHaveBeenCalledWith(
        id,
        expect.objectContaining({ id: moved.id }),
        '',
        expect.stringContaining('sub'),
      );
      expect(repo.deleteResource).not.toHaveBeenCalled();
      expect(repo.upsertResource).not.toHaveBeenCalled();
    });

    it('A3 目录搬移 → 子树里每个文献各一次 renameResource,idRemap 一一对应', async () => {
      const id = await importPaper('paper.pdf');
      // 先搬进子目录 —— 这一步已经换过一次 id,子树搬移要换的是**这个** id
      const inSub = await lit.moveFile(id as never, 'sub');
      repo.upsertResource.mockClear();
      repo.deleteResource.mockClear();
      repo.renameResource.mockClear();

      const res = await lit.moveDir('sub', 'moved');

      expect(repo.renameResource).toHaveBeenCalledTimes(1);
      expect(res.idRemap).toHaveLength(1);
      expect(res.idRemap[0].oldId).toBe(inSub.id);
      expect(res.idRemap[0].newId).not.toBe(inSub.id);
      expect(repo.deleteResource).not.toHaveBeenCalled();
      expect(repo.upsertResource).not.toHaveBeenCalled();
    });

    it('B1 DB 写失败 → 错误上抛,且 deleteResource 从未被调用(不留「旧行已删」的半状态)', async () => {
      const id = await importPaper('paper.pdf');
      repo.renameResource.mockImplementationOnce(() => {
        throw new Error('DB busy');
      });

      await expect(lit.renameFile(id as never, 'thesis')).rejects.toThrow();

      // 关键断言:旧行**还在** DB 里(没有先被单独删掉)——
      // 两个独立事务的旧实现在这里 deleteResource 已经执行过了。
      expect(repo.deleteResource).not.toHaveBeenCalled();
    });

    it('B2 目录搬移时 DB 写失败 → 错误上抛,子树里没有任何一行被单独删掉', async () => {
      const id = await importPaper('paper.pdf');
      await lit.moveFile(id as never, 'sub');
      repo.renameResource.mockImplementationOnce(() => {
        throw new Error('DB busy');
      });

      await expect(lit.moveDir('sub', 'moved')).rejects.toThrow();

      expect(repo.deleteResource).not.toHaveBeenCalled();
    });
  });

  // === 笔记侧(本轮把两份逐字重复收成一份 helper)===
  describe('NotesService —— 换 id 的时序不变量单点化', () => {
    let svc: NotesService;

    beforeEach(async () => {
      svc = new NotesService();
      await svc.start({ skipInitialLoad: true });
    });

    afterEach(async () => {
      await svc.stop();
    });

    it('C1 改名 / 搬移的 DB 换键 + byId 换键走同一份 helper(源码里只有一处 renameResource 调用)', async () => {
      // 行为面:改名与搬移都只发生一次 DB 换键,且内存索引跟着换
      const n = await svc.create('a.md');
      repo.renameResource.mockClear();
      const renamed = await svc.renameFile(n.id, 'b');
      expect(repo.renameResource).toHaveBeenCalledTimes(1);
      expect(svc.findById(n.id)).toBeNull();
      expect(svc.findById(renamed.id)).not.toBeNull();

      repo.renameResource.mockClear();
      const moved = await svc.moveFile(renamed.id, 'sub');
      expect(repo.renameResource).toHaveBeenCalledTimes(1);
      expect(svc.findById(renamed.id)).toBeNull();
      expect(svc.findById(moved.id)).not.toBeNull();

      // 结构面:notes/service.ts 里 `renameResource(` 只应出现一次
      // (在 applyNoteIdSwap 内)。旧实现是 renameFile / moveFile /
      // moveDir / renameDir 各写一份 ⇒ 改一边漏另一边 = 「重命名同步了
      // DB、搬移没同步」这类漂移。
      // 注:先剥掉整行注释 —— 注释里提到 renameResource( 不算调用点。
      const src = readFileSync(
        join(process.cwd(), 'src', 'main', 'notes', 'service.ts'),
        'utf-8',
      );
      const code = src
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');
      const calls = code.match(/\brenameResource\(/g) ?? [];
      expect(calls).toHaveLength(1);
      // 两个调用点都走 helper
      expect(src).toMatch(/await this\.applyNoteIdSwap\(/);
    });
  });
});
