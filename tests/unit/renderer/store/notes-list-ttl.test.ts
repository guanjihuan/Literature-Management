// tests/unit/renderer/store/notes-list-ttl.test.ts
//
// 守 r193「notes 列表其实被缓存了 1 秒」契约。
//
// 现象(用户可复现):
//   1. 侧栏打开着笔记列表(第一次 load 已完成);
//   2. 1 秒内,磁盘上**新增/改动**了笔记 —— 另一个窗口保存、chokidar 事件、
//      网盘同步落盘…… ⇒ 主进程广播 NOTES_CHANGED ⇒ renderer 走 load();
//   3. 侧栏列表**不变**:新笔记不出现、已删笔记还在,直到用户再点一次别的
//      刷新才「突然跳」到正确内容。
//
// 根因(旧实现):`loadOnce` 在 loader 成功时**无条件**写 `cache.ts =
// Date.now()`。notesCache 声明上虽然没有 `ts` 字段(TypeScript 层面看不见),
// 但运行时第一次 load 之后它**凭空多出一个 ts 属性** ⇒ loadOnce 的 TTL
// 分支从**第二次** load 起就成立 ⇒ 笔记列表被实打实地缓存 1 秒,
// 1 秒内的 NOTES_CHANGED 推送**连 IPC 都不发**,直接拿回上一次的旧数组。
//
// r218 补记:`loadOnce`(lib/store-helpers.ts)已整体下线 —— 它唯一的生产
// 消费方就是 notes store,序号守卫(r218,见 notes-load-seq-guard.test.ts)
// 落地后成了零调用点死代码。「不缓存」从 helper 的字段约定升级为结构事实:
// 每次 load 直发新 IPC,没有缓存对象可写。本测原有两条 loadOnce 单元用例
// (TTL 显式 opt-in / 不凭空补 ts)随被测对象一并删除,保留的这条是
// **store 行为级**契约,与被删的 helper 无关,必须继续守。
//
// 本测锁:
//   1 秒内连续两次 load() ⇒ **两次都真发 IPC**(listNotes 调用 2 次),
//   且第二次拿到的是**新列表**。
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

describe('notes 列表不该被 TTL 缓存(r193)', () => {
  let listNotes: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    listNotes = vi.fn().mockResolvedValue({ ok: true, data: [] });
    (globalThis as unknown as { window: { api: unknown } }).window = {
      api: {
        listNotes,
        renameNoteFile: vi.fn(),
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

  it('1 秒内连续两次 load(),两次都真发 IPC', async () => {
    listNotes.mockResolvedValue({ ok: true, data: [summary('a', 'a.md')] });
    await useNotesStore.getState().load();
    expect(listNotes).toHaveBeenCalledTimes(1);

    // 第二次:列表内容已经变了(NOTES_CHANGED 之后的典型情形)
    listNotes.mockResolvedValue({ ok: true, data: [summary('a', 'a.md'), summary('b', 'b.md')] });
    await useNotesStore.getState().load();

    expect(listNotes, '第二次 load 命中了缓存 ⇒ 没发 IPC').toHaveBeenCalledTimes(2);
    expect(useNotesStore.getState().notes.map((n) => n.id)).toEqual(['a', 'b']);
  });
});
