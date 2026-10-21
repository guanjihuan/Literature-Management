// tests/unit/renderer/hooks/use-reorder-dnd.test.ts
//
// 守 r224「reorder 拖拽四件套收编」契约:
//   NotesList / LiteratureList 里逐字同构的 reorder 块(dragOver/dragLeave/
//   drop/dragEnd + 落点指示线 state)收编进 hooks/use-reorder-dnd.ts。
//
// ── 锁两类东西 ─────────────────────────────────────────────────────
//   1. 行为契约:
//      dragOver 给 before/after 指示线 + dropEffect='move';
//      dragLeave 只在真正离开 row 时清(relatedTarget 判);
//      drop 守卫 = 无 payload / 异 kind / 拖回自身 no-op;跨目录落行
//      (2026-10-21 起,用户诉求「移出文件夹任意位置都行」)委托
//      onCrossFolderMove(未注入则维持 r176 静默拒绝);同目录才按
//      「filter 掉 moving + before 插位 splice」算新顺序调 reorderByIds;
//      dragEnd 清指示线;
//   2. 结构契约(防孪生块复活):两个组件源码里不得再出现
//      hasReorderPayload / setReorderIndicator —— 谁把四件套抄回组件里,
//      这条立刻红。
import { describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { DragEvent as ReactDragEvent } from 'react';
import { useReorderDnd } from '../../../../src/renderer/src/hooks/use-reorder-dnd';
import { writeReorderPayload } from '../../../../src/renderer/src/lib/folder-dnd';

interface Row {
  id: string;
  relPath: string;
}

const ROWS: Row[] = [
  { id: 'a', relPath: 'a.md' },
  { id: 'b', relPath: 'b.md' },
  { id: 'c', relPath: 'c.md' },
  { id: 'd', relPath: 'sub/d.md' },
];
const ORDER = { a: 0, b: 1, c: 2, d: 3 };

function makeDataTransfer() {
  const types: string[] = [];
  const store = new Map<string, string>();
  return {
    types,
    setData(mime: string, val: string) {
      if (!store.has(mime)) types.push(mime);
      store.set(mime, val);
    },
    getData(mime: string) {
      return store.get(mime) ?? '';
    },
    effectAllowed: 'move',
    dropEffect: 'move',
  } as unknown as DataTransfer;
}

function makeDragEvent(dt: DataTransfer, clientY = 10, rect?: Partial<DOMRect>) {
  const el = {
    getBoundingClientRect: () =>
      ({ top: 0, height: 20, ...rect }) as DOMRect,
    contains: () => false,
  };
  return {
    dataTransfer: dt,
    clientY,
    currentTarget: el,
    relatedTarget: null,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as ReactDragEvent;
}

function setup(kind: 'note' | 'literature' = 'note') {
  const reorderByIds = vi.fn();
  const hook = renderHook(() =>
    useReorderDnd<Row>({
      kind,
      getItems: () => ROWS,
      displayOrderById: ORDER,
      reorderByIds,
    }),
  );
  return { ...hook, reorderByIds };
}

describe('useReorderDnd(r224 收编块的行为契约)', () => {
  it('dragOver 按鼠标 y 与行中线给 before/after 指示线 + dropEffect=move', () => {
    const { result } = setup();
    const dt = makeDataTransfer();
    writeReorderPayload(dt, { id: 'a', targetId: 'a', before: true, kind: 'note' });

    act(() => {
      result.current.handleItemReorderDragOver(ROWS[1], makeDragEvent(dt, 15)); // 15 > 中线 10
    });
    expect(result.current.reorderIndicator).toEqual({ id: 'b', position: 'after' });
    expect(dt.dropEffect).toBe('move');

    act(() => {
      result.current.handleItemReorderDragOver(ROWS[1], makeDragEvent(dt, 3)); // 3 < 中线 10
    });
    expect(result.current.reorderIndicator).toEqual({ id: 'b', position: 'before' });
  });

  it('无 reorder payload 的 dragOver 不接管(不 preventDefault)', () => {
    const { result } = setup();
    const e = makeDragEvent(makeDataTransfer());
    act(() => {
      result.current.handleItemReorderDragOver(ROWS[1], e);
    });
    expect(result.current.reorderIndicator).toBeNull();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it('drop 同目录 after 插入:filter 掉 moving 再 splice,reorderByIds 拿全新顺序', () => {
    const { result, reorderByIds } = setup();
    const dt = makeDataTransfer();
    writeReorderPayload(dt, { id: 'a', targetId: 'a', before: true, kind: 'note' });
    // 拖 a 到 b 的下半部分(after)→ [b, a, c]
    act(() => {
      result.current.handleItemReorderDrop(ROWS[1], makeDragEvent(dt, 15));
    });
    expect(reorderByIds).toHaveBeenCalledTimes(1);
    expect(reorderByIds).toHaveBeenCalledWith(['b', 'a', 'c', 'd']);
    expect(result.current.reorderIndicator).toBeNull();
  });

  it('drop 同目录 before 插入:拖 a 到 b 的上半部分 → [a, b, c]', () => {
    const { result, reorderByIds } = setup();
    const dt = makeDataTransfer();
    writeReorderPayload(dt, { id: 'c', targetId: 'c', before: true, kind: 'note' });
    // 拖 c 到 a 的上半部分(before)→ [c, a, b, d]
    act(() => {
      result.current.handleItemReorderDrop(ROWS[0], makeDragEvent(dt, 3));
    });
    expect(reorderByIds).toHaveBeenCalledWith(['c', 'a', 'b', 'd']);
  });

  it('drop 四道守卫:拖回自身 / 跨目录 / 异 kind / 无 payload 全部 no-op', () => {
    const { result, reorderByIds } = setup();
    // ① 拖回自身
    let dt = makeDataTransfer();
    writeReorderPayload(dt, { id: 'a', targetId: 'a', before: true, kind: 'note' });
    act(() => {
      result.current.handleItemReorderDrop(ROWS[0], makeDragEvent(dt, 3));
    });
    // ② 跨目录(d 在 sub/,a 在根)→ 未注入 onCrossFolderMove 时维持 r176 拒绝
    dt = makeDataTransfer();
    writeReorderPayload(dt, { id: 'd', targetId: 'd', before: true, kind: 'note' });
    act(() => {
      result.current.handleItemReorderDrop(ROWS[0], makeDragEvent(dt, 3));
    });
    // ③ 异 kind(literature payload 落进 note 列表)
    dt = makeDataTransfer();
    writeReorderPayload(dt, { id: 'b', targetId: 'b', before: true, kind: 'literature' });
    act(() => {
      result.current.handleItemReorderDrop(ROWS[0], makeDragEvent(dt, 3));
    });
    // ④ 无 payload
    act(() => {
      result.current.handleItemReorderDrop(ROWS[0], makeDragEvent(makeDataTransfer(), 3));
    });
    expect(reorderByIds).not.toHaveBeenCalled();
  });

  it('dragLeave 真正离开才清指示线;dragEnd 无条件清', () => {
    const { result } = setup();
    const dt = makeDataTransfer();
    writeReorderPayload(dt, { id: 'a', targetId: 'a', before: true, kind: 'note' });
    act(() => {
      result.current.handleItemReorderDragOver(ROWS[1], makeDragEvent(dt, 15));
    });
    expect(result.current.reorderIndicator).not.toBeNull();

    // relatedTarget 在 row 内(contains=true)→ 不清
    const innerLeave = makeDragEvent(dt, 15);
    (innerLeave.currentTarget as unknown as { contains: () => boolean }).contains = () => true;
    (innerLeave as { relatedTarget: unknown }).relatedTarget = {};
    act(() => {
      result.current.handleItemReorderDragLeave(ROWS[1], innerLeave);
    });
    expect(result.current.reorderIndicator).not.toBeNull();

    // 真正离开 → 清
    act(() => {
      result.current.handleItemReorderDragLeave(ROWS[1], makeDragEvent(dt, 15));
    });
    expect(result.current.reorderIndicator).toBeNull();

    // 再拖出指示线后 dragEnd → 清
    act(() => {
      result.current.handleItemReorderDragOver(ROWS[1], makeDragEvent(dt, 15));
    });
    act(() => {
      result.current.handleItemReorderDragEnd(makeDragEvent(dt));
    });
    expect(result.current.reorderIndicator).toBeNull();
  });
});

describe('跨目录落行 = 委托 onCrossFolderMove(2026-10-21 「移出文件夹任意位置」)', () => {
  function setupWithMove() {
    const reorderByIds = vi.fn();
    const onCrossFolderMove = vi.fn();
    const hook = renderHook(() =>
      useReorderDnd<Row>({
        kind: 'note',
        getItems: () => ROWS,
        displayOrderById: ORDER,
        reorderByIds,
        onCrossFolderMove,
      }),
    );
    return { ...hook, reorderByIds, onCrossFolderMove };
  }

  it('子目录条目 d 落到根行 a ⇒ 委托,targetDir=\'\',不走 reorder', () => {
    const { result, reorderByIds, onCrossFolderMove } = setupWithMove();
    const dt = makeDataTransfer();
    writeReorderPayload(dt, { id: 'd', targetId: 'd', before: true, kind: 'note' });
    const e = makeDragEvent(dt, 3);
    act(() => {
      result.current.handleItemReorderDrop(ROWS[0], e);
    });
    expect(onCrossFolderMove).toHaveBeenCalledTimes(1);
    expect(onCrossFolderMove).toHaveBeenCalledWith('', e);
    expect(reorderByIds, '跨目录不得走 reorderByIds(视觉错位,r176)').not.toHaveBeenCalled();
    // 已 preventDefault + stopPropagation:容器空白区 ROOT 落点不得二次处理
    expect(e.preventDefault).toHaveBeenCalled();
    expect(e.stopPropagation).toHaveBeenCalled();
    // 指示线照常清(与 reorder 路径一致)
    expect(result.current.reorderIndicator).toBeNull();
  });

  it('根条目 a 落到 sub/ 目录的行 d ⇒ 委托,targetDir=\'sub\'', () => {
    const { result, reorderByIds, onCrossFolderMove } = setupWithMove();
    const dt = makeDataTransfer();
    writeReorderPayload(dt, { id: 'a', targetId: 'a', before: true, kind: 'note' });
    act(() => {
      result.current.handleItemReorderDrop(ROWS[3], makeDragEvent(dt, 3));
    });
    expect(onCrossFolderMove).toHaveBeenCalledTimes(1);
    expect(onCrossFolderMove.mock.calls[0]![0]).toBe('sub');
    expect(reorderByIds).not.toHaveBeenCalled();
  });

  it('同目录落行 ⇒ 不委托(走原 reorder 路径)', () => {
    const { result, reorderByIds, onCrossFolderMove } = setupWithMove();
    const dt = makeDataTransfer();
    writeReorderPayload(dt, { id: 'a', targetId: 'a', before: true, kind: 'note' });
    act(() => {
      result.current.handleItemReorderDrop(ROWS[1], makeDragEvent(dt, 15));
    });
    expect(onCrossFolderMove).not.toHaveBeenCalled();
    expect(reorderByIds).toHaveBeenCalledWith(['b', 'a', 'c', 'd']);
  });
});

describe('perf r247:拖拽期间的渲染预算(指示线同值不重渲)', () => {
  /**
   * 背景(用户诉求「使用流畅,不要有卡顿」):
   *   dragover 是**高频**事件(鼠标一动就发,实测 ~60Hz)。旧实现每次都
   *   `setReorderIndicator({ id, position })` 造一个**新对象** ⇒ React 的
   *   「新 state = 新引用 ⇒ 必须重渲」判定永远成立 ⇒ 每秒 60 次重渲。
   *   而重渲的是**整个列表组件**:NotesList / LiteratureList 的 itemContent
   *   useCallback 把 reorderIndicator 列入 deps ⇒ 指示线一变 itemContent
   *   身份就变 ⇒ react-virtuoso 重新渲染**全部可见行**。
   *   ⇒ 「按住一行拖动」= 整列可见行 60Hz 重渲,大库上必卡。
   *
   * 修法:落点语义(id + position)没变 ⇒ **连 setState 都不调**。
   *   注:曾试过「updater 原样返回 prev ⇒ React 同值 bail-out」,**不成立** ——
   *   实测 React 18.3.1(updater 返回同一引用)照样重渲一次,官方措辞是
   *   「React may still need to render that specific component again before
   *   bailing out」。所以只能靠「不发 setState」这一条路。
   * 本组用例锁「重渲次数」与「指示线对象身份」两个可观测量。
   */
  function setupCounting() {
    let renders = 0;
    const hook = renderHook(() => {
      renders += 1;
      return useReorderDnd<Row>({
        kind: 'note',
        getItems: () => ROWS,
        displayOrderById: ORDER,
        reorderByIds: vi.fn(),
      });
    });
    return { ...hook, renders: () => renders };
  }

  it('同一行同一侧连发 30 次 dragOver ⇒ 零额外重渲,指示线对象身份不变', () => {
    const { result, renders } = setupCounting();
    const dt = makeDataTransfer();
    writeReorderPayload(dt, { id: 'a', targetId: 'a', before: true, kind: 'note' });

    act(() => {
      result.current.handleItemReorderDragOver(ROWS[1], makeDragEvent(dt, 15)); // 下半部分 ⇒ after
    });
    const first = result.current.reorderIndicator;
    expect(first).toEqual({ id: 'b', position: 'after' });
    const rendersAfterFirst = renders();

    // 模拟 60Hz 拖拽:指针在同一行内小幅抖动(不跨中线)
    for (let i = 0; i < 30; i += 1) {
      act(() => {
        result.current.handleItemReorderDragOver(ROWS[1], makeDragEvent(dt, 15));
      });
    }
    expect(renders(), '同值 dragOver 不得触发任何重渲').toBe(rendersAfterFirst);
    expect(result.current.reorderIndicator, '指示线对象身份必须保持不变').toBe(first);
  });

  it('指示线**真的**变了(跨中线 / 换行)⇒ 仍然照常更新并重渲', () => {
    const { result, renders } = setupCounting();
    const dt = makeDataTransfer();
    writeReorderPayload(dt, { id: 'a', targetId: 'a', before: true, kind: 'note' });

    act(() => {
      result.current.handleItemReorderDragOver(ROWS[1], makeDragEvent(dt, 15)); // after
    });
    const after = result.current.reorderIndicator;
    const r0 = renders();

    // 跨中线 ⇒ before(语义变了 ⇒ 必须更新)
    act(() => {
      result.current.handleItemReorderDragOver(ROWS[1], makeDragEvent(dt, 3));
    });
    expect(result.current.reorderIndicator).toEqual({ id: 'b', position: 'before' });
    expect(result.current.reorderIndicator).not.toBe(after);
    expect(renders(), '语义变化必须重渲(否则指示线不更新)').toBeGreaterThan(r0);

    // 换到另一行 ⇒ id 变了 ⇒ 必须更新
    const before = result.current.reorderIndicator;
    act(() => {
      result.current.handleItemReorderDragOver(ROWS[2], makeDragEvent(dt, 15));
    });
    expect(result.current.reorderIndicator).toEqual({ id: 'c', position: 'after' });
    expect(result.current.reorderIndicator).not.toBe(before);
  });

  it('一次跨 3 行的拖拽 ⇒ 重渲次数跟「落点变化次数」走(远小于事件数)', () => {
    const { result, renders } = setupCounting();
    const dt = makeDataTransfer();
    writeReorderPayload(dt, { id: 'a', targetId: 'a', before: true, kind: 'note' });

    const r0 = renders();
    // 现实手势:指针在 3 行之间移动,**每行内 20 次小幅抖动**(不跨中线)。
    // ⇒ 落点只在「换行」时变(3 次),事件却发了 60 次。
    //   旧实现 = 60 次重渲;新实现 ≤ 4 次。
    for (let rowIdx = 0; rowIdx < 3; rowIdx += 1) {
      const row = ROWS[1 + rowIdx]!;
      for (let k = 0; k < 20; k += 1) {
        act(() => {
          result.current.handleItemReorderDragOver(row, makeDragEvent(dt, 15 + (k % 3)));
        });
      }
    }
    expect(renders() - r0, '重渲次数必须跟「落点变化次数」走,而不是事件数').toBeLessThanOrEqual(4);
  });
});

describe('r224 结构契约:孪生块不得复活', () => {
  const ROOT = process.cwd();
  for (const rel of [
    'src/renderer/src/components/notes/NotesList.tsx',
    'src/renderer/src/components/literature/LiteratureList.tsx',
  ]) {
    it(`${rel} 走 useReorderDnd,不再自带四件套`, () => {
      const src = readFileSync(join(ROOT, rel), 'utf-8');
      expect(src, 'reorder 四件套必须走 hooks/use-reorder-dnd').toContain('useReorderDnd');
      expect(src, '孪生块复活:组件里又出现 payload 判读').not.toContain('hasReorderPayload');
      expect(src, '孪生块复活:组件里又出现指示线 state').not.toContain('setReorderIndicator');
      // 2026-10-21:跨目录落行委托必须接线(漏接 = 静默退回 r176 拒绝,
      //   「移出文件夹只能拖底部空白」复发)。根行映射 ROOT_DROP_ID 同守。
      expect(src, '跨目录落行委托未接线 onCrossFolderMove').toContain('onCrossFolderMove');
      expect(src, '根行落点必须映射 ROOT_DROP_ID').toContain('ROOT_DROP_ID');
    });
  }
});
