// tests/unit/renderer/store/notes-load-seq-guard.test.ts
//
// 守 r218「notes store load() 序号守卫 + 不做 in-flight join」契约。
//
// ── 被守卫的缺陷(用户可见)──────────────────────────────────────────
//   旧实现 load() 走 `loadOnce` 单飞 join:第二次 load 若撞上第一次在途,
//   **不发新 IPC**,直接并到那个在途 promise 上。于是一条现实的时序链:
//     t0  load#1 发出(慢 IPC —— 主进程正忙着 reload / DB 写入);
//     t1  一篇笔记被删掉(本窗口 / 另一个窗口 / 同步盘),主进程广播
//         NOTES_CHANGED ⇒ renderer 推送监听器调 load();
//     t2  这次 load **并到 load#1 上**(listNotes 的请求在 t0 就已到达
//         主进程、先于删除被处理 ⇒ 返回的旧快照里**还有刚删的笔记**);
//     t3  旧快照落地 —— 之后**没有任何后续 fetch**。
//   ⇒ 列表永远停在旧状态:刚删的笔记还在列表里,要等下一次无关的外部
//   事件才自愈。join 是缓存设计的残留,与 r193「不缓存、每次都真发 IPC」
//   的意图直接矛盾。
//
// ── 修法(r218)────────────────────────────────────────────────────────
//   镜像 literature store 的 r73 序号守卫,且 notes 侧**不做 join**:
//   每次 load 都发新 IPC(listNotes 在主进程是内存 map 直读,并发几发
//   没有成本);`_loadIssued` 每请求 +1,`_loadApplied` 记录已落地的最新
//   序号,迟到的旧快照 / 旧失败 `seq < _loadApplied` 直接丢弃。
//
// ── 本测锁的三条 ─────────────────────────────────────────────────────
//   A. 在途旧 load 期间再 load ⇒ 必须发**第二次** IPC,且最终落地**新**
//      快照(缺陷本体;HEAD 上 join ⇒ 只发 1 次且拿到旧快照 ⇒ 红);
//   B. 乱序到达:新快照先落地、旧响应后到达 ⇒ 旧响应被序号闸丢弃;
//   C. 迟到的**旧失败**不得把已落地的新快照标成 lastError(catch 也过闸)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/renderer/src/store/workspace', () => ({
  useWorkspaceStore: {
    getState: () => ({
      pendingFocusNote: { hasPending: false, payload: null },
      consumeFocusNoteRequest: () => {},
    }),
  },
}));
vi.mock('../../../../src/renderer/src/lib/toast', () => ({
  useToast: {
    getState: () => ({ show: () => {} }),
  },
}));

import { useNotesStore } from '../../../../src/renderer/src/store/notes';
import type { StandaloneNoteSummary } from '../../../../src/shared/types';

function summary(id: string, relPath: string): StandaloneNoteSummary {
  return { id, relPath, filename: relPath, title: null, tags: null, mtime: 0 };
}

interface Deferred {
  promise: Promise<{ ok: true; data: StandaloneNoteSummary[] }>;
  resolve: (v: { ok: true; data: StandaloneNoteSummary[] }) => void;
  reject: (e: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: Deferred['resolve'];
  let reject!: Deferred['reject'];
  const promise = new Promise<{ ok: true; data: StandaloneNoteSummary[] }>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('notes store load() 序号守卫(r218)', () => {
  let listNotes: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    listNotes = vi.fn();
    (globalThis as unknown as { window: { api: unknown } }).window = {
      api: {
        listNotes,
        onNotesChanged: vi.fn().mockReturnValue(() => {}),
      },
    };
    useNotesStore.setState({
      notes: [],
      selectedIds: new Set<string>(),
      selectedId: null,
      activeNoteFull: null,
      anchorId: null,
      clipboard: null,
      lastError: null,
      displayOrderById: {},
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('A 在途旧 load 期间再 load ⇒ 发第二次 IPC,最终落地新快照', async () => {
    const d1 = deferred();
    const d2 = deferred();
    listNotes.mockReturnValueOnce(d1.promise).mockReturnValueOnce(d2.promise);

    const l1 = useNotesStore.getState().load(); // 变更前发出的慢请求
    const l2 = useNotesStore.getState().load(); // 变更后(NOTES_CHANGED)的刷新

    expect(
      listNotes,
      '第二次 load 并到了在途 promise 上 ⇒ 变更后的状态永远拉不到',
    ).toHaveBeenCalledTimes(2);

    d1.resolve({ ok: true, data: [summary('stale', 'stale.md')] });
    await l1;
    d2.resolve({ ok: true, data: [] }); // 删除后的真实列表
    await l2;

    expect(
      useNotesStore.getState().notes.map((n) => n.id),
      '旧快照盖过了新快照(刚删的笔记还在列表里)',
    ).toEqual([]);
  });

  it('B 乱序到达:新快照先落地,迟到的旧响应被丢弃', async () => {
    const d1 = deferred();
    const d2 = deferred();
    listNotes.mockReturnValueOnce(d1.promise).mockReturnValueOnce(d2.promise);

    const l1 = useNotesStore.getState().load();
    const l2 = useNotesStore.getState().load();
    expect(listNotes).toHaveBeenCalledTimes(2);

    // 新快照先回来并落地
    d2.resolve({ ok: true, data: [summary('b', 'b.md')] });
    await l2;
    // 旧快照**后**回来 —— 必须被序号闸丢掉
    d1.resolve({ ok: true, data: [summary('a', 'a.md')] });
    await l1;

    expect(useNotesStore.getState().notes.map((n) => n.id)).toEqual(['b']);
  });

  it('C 迟到的旧失败不得把已落地的新快照标成 lastError', async () => {
    const d1 = deferred();
    const d2 = deferred();
    listNotes.mockReturnValueOnce(d1.promise).mockReturnValueOnce(d2.promise);

    const l1 = useNotesStore.getState().load();
    const l2 = useNotesStore.getState().load();
    expect(listNotes).toHaveBeenCalledTimes(2);

    d2.resolve({ ok: true, data: [summary('b', 'b.md')] });
    await l2;
    expect(useNotesStore.getState().lastError).toBeNull();

    // 旧请求**之后**失败 —— 不得覆盖新快照,也不得置 lastError
    d1.reject(new Error('boom'));
    await l1;

    expect(useNotesStore.getState().notes.map((n) => n.id)).toEqual(['b']);
    expect(
      useNotesStore.getState().lastError,
      '迟到的旧失败把新列表标成了「load 失败」',
    ).toBeNull();
  });

  it('D 单次 load 正常落地(防回归)', async () => {
    listNotes.mockResolvedValue({ ok: true, data: [summary('a', 'a.md')] });
    await useNotesStore.getState().load();
    expect(useNotesStore.getState().notes.map((n) => n.id)).toEqual(['a']);
    expect(useNotesStore.getState().lastError).toBeNull();
  });
});
