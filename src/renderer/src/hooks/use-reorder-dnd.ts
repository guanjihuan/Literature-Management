// use-reorder-dnd:列表行内拖拽重排(reorder)四件套 + 落点指示线 state。
//
// audit-r224 (2026-10-20):本 hook 是 NotesList / LiteratureList 里**逐字
//   同构**的 reorder 块收编(收编前两份各 ~75 行,唯一差异 = store items
//   访问器 / payload kind / 行类型)。行为一字未改,纯搬移:
//   - dragOver:有 reorder payload 才接管,按鼠标 y 与行中线比较给出
//     before/after 落点指示线,dropEffect='move';
//   - dragLeave:只在真正离开 row 时清指示线(relatedTarget 判;子元素
//     冒泡不清);
//   - drop:自身插回自己 = no-op;**跨目录落到另一行 = 委托 onCrossFolderMove
//     走「搬进目标行所在目录」**(2026-10-21,用户诉求:「文件移出文件夹,
//     应该任意位置都可以,不一定在底部空白区域」—— r176 旧设计是跨目录
//     静默拒绝,理由是 displayOrderById 全局顺序下跨目录 reorder 视觉错位
//     (B 目录看是「多出一条」,A 目录看是「A 没了」);但行落点全被
//     reorder dragover 接管 + stopPropagation,容器空白区根本收不到事件,
//     「移出文件夹」的唯一出口只剩列表底部那条小空白。现在行落点不再拒绝,
//     而是显式搬移:落到哪一行就搬进哪一行的目录(根行 = 根目录)—— 条目
//     真实出现在落点行旁边,不存在 r176 担心的「以为在排序其实在搬文件」的
//     静默错位。未注入 onCrossFolderMove 时维持 r176 旧拒绝语义);
//     同目录内按 before 插到目标行旁,
//     新顺序 = 全部 id 按 displayOrder 排序后 filter 掉 moving 再 splice;
//   - dragEnd:清指示线。
//
// 依赖注入而非直接 import store:两个 store 的 items 字段名不同(notes /
//   items),由 caller 传 `getItems` 访问器;`useLatestValue(opts)` 让四个
//   useCallback 全部空依赖(身份恒定 ⇒ 行组件 memo 不被打穿),回调内现读
//   最新值 —— 与 useListboxRove 的 audit-r33 deps 收敛同一模式。
//   注意:useLatestValue 的返回值必须显式列进 deps(exhaustive-deps 把
//   自定义 hook 返回值一律当不稳定值,见 useLatestValue.ts 头注 r34 更正)。

import { useCallback, useRef, useState, type DragEvent as ReactDragEvent } from 'react';
import type { ResourceKind } from '@shared/types';
import { hasReorderPayload, readReorderPayload } from '../lib/folder-dnd';
import { dirnameOfRelPath } from '../lib/folder-view';
import type { DisplayOrderMap } from '../lib/order-persistence';
import { useLatestValue } from './useLatestValue';

export interface ReorderIndicator {
  id: string;
  position: 'before' | 'after';
}

export interface UseReorderDndOptions<T> {
  /** 只接本域的 reorder payload(另一域的拖进来直接忽略)。 */
  kind: ResourceKind;
  /** 现读 store 全量行(模块单例 store,访问器语义恒定)。 */
  getItems: () => T[];
  displayOrderById: DisplayOrderMap;
  reorderByIds: (orderedIds: string[]) => void;
  /**
   * 跨目录 drop 到某一行 = 把拖拽项搬进**该行所在目录**('' = 根)。
   *   事件同时携带 MOVE payload(startItemsDrag 一次写 MOVE + REORDER 双
   *   MIME),由调用方转给 folders.handleTargetDrop 完成真实搬移 —— 多选
   *   batch 也走这条(MOVE payload 带全部 ids)。不传 = 维持 r176 的
   *   静默拒绝。
   */
  onCrossFolderMove?: (targetDir: string, e: ReactDragEvent) => void;
}

export function useReorderDnd<T extends { id: string; relPath?: string | null }>(
  opts: UseReorderDndOptions<T>,
): {
  reorderIndicator: ReorderIndicator | null;
  handleItemReorderDragOver: (item: T, e: ReactDragEvent) => void;
  handleItemReorderDragLeave: (item: T, e: ReactDragEvent) => void;
  handleItemReorderDrop: (item: T, e: ReactDragEvent) => void;
  handleItemReorderDragEnd: (e: ReactDragEvent) => void;
} {
  const latest = useLatestValue(opts);
  // audit-r143:落点指示线 —— 哪个 row + 哪一侧(before / after)。
  //   仅在拖动 reorder 时存在;reorder 结束 / 离开 row / drop 完成均清空。
  const [reorderIndicator, setReorderIndicator] = useState<ReorderIndicator | null>(null);
  // perf r247:指示线的「当前值」另存一份 ref —— 用来**在调 setState 之前**
  //   判断「落点语义是不是真的变了」。
  //   为什么不能只靠 setState 的 updater 同值短路?实测(React 18.3.1,
  //   原生 createRoot,见下)updater 原样返回**同一个对象引用**时,
  //   React 依旧会把这个组件重渲一次 —— 官方措辞是「React may still need
  //   to render that specific component again before bailing out」。
  //   也就是说「同值 bail-out」在 React 18 上**不成立**;
  //   ⇒ 想真的省掉那次重渲,只能**根本不调 setState**。
  const indicatorRef = useRef<ReorderIndicator | null>(null);

  // perf r247:唯一改指示线的入口 —— 同值直接 return(一次 setState 都不发)。
  const applyIndicator = useCallback((next: ReorderIndicator | null) => {
    const cur = indicatorRef.current;
    if (cur === next) return;
    if (cur !== null && next !== null && cur.id === next.id && cur.position === next.position) {
      return;
    }
    indicatorRef.current = next;
    setReorderIndicator(next);
  }, []);

  const handleItemReorderDragOver = useCallback(
    (item: T, e: ReactDragEvent) => {
      if (!hasReorderPayload(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const before = e.clientY - rect.top < rect.height / 2;
      const position: ReorderIndicator['position'] = before ? 'before' : 'after';
      // perf r247:同值**不 setState** ——
      //   dragover 是**高频**事件(鼠标一动就发,实测 ~60Hz)。旧实现每次都
      //   `setReorderIndicator({ id, position })` 造一个**新对象** ⇒ React 的
      //   「新 state 就是新引用 ⇒ 必须重渲」判定永远成立 ⇒ 每秒 60 次重渲。
      //   而重渲的是**整个列表组件**:NotesList / LiteratureList 的
      //   itemContent useCallback 把 reorderIndicator 列入 deps ⇒ 指示线一变
      //   itemContent 身份就变 ⇒ react-virtuoso 重新渲染**全部可见行**。
      //   也就是说「按住一行拖动」= 整列可见行 60Hz 重渲 —— 大库上必卡。
      //   指示线的**语义**只有 (id, position) 两个维度,同值时画面完全不变 ⇒
      //   连 setState 都不发(见上面 ref 的注释:updater 同值短路在 React 18
      //   上**不成立**)。
      //   效果:重渲频率从「每帧」降到「指示线真的换了位置/换了行」(拖一次
      //   通常 2~5 次),画面逐像素一致。
      applyIndicator({ id: item.id, position });
      e.dataTransfer.dropEffect = 'move';
    },
    [applyIndicator],
  );

  const handleItemReorderDragLeave = useCallback(
    (item: T, e: ReactDragEvent) => {
      if (!hasReorderPayload(e.dataTransfer)) return;
      // 只在真正离开 row 时清(用 relatedTarget 判;子元素冒泡不清)
      const related = e.relatedTarget as Node | null;
      if (related && (e.currentTarget as Node).contains(related)) return;
      // 只清「本行」的指示线;别的行的指示线不动(与旧 updater 语义一致)
      if (indicatorRef.current?.id !== item.id) return;
      applyIndicator(null);
    },
    [applyIndicator],
  );

  const handleItemReorderDrop = useCallback(
    (item: T, e: ReactDragEvent) => {
      const { kind, getItems, displayOrderById, reorderByIds } = latest.current;
      const payload = readReorderPayload(e.dataTransfer);
      applyIndicator(null);
      if (!payload) return;
      if (payload.kind !== kind) return;
      e.preventDefault();
      e.stopPropagation();
      // audit-r144:payload.targetId 是 dragstart 占位值(= payload.id),不再
      //   信任;落点 targetId = currentTarget 行 item.id,before 由鼠标 y 与
      //   中线比较。自身插回自己 = no-op(防御同一行拖到自身 anchor)。
      //   多选 batch 由 hasMovePayload 路径跨文件夹 move 接走;此路径取
      //   payload.id 作为唯一 moving,与「同文件夹内调整顺序」一致。
      const moving = payload.id;
      if (moving === item.id) return;
      // r176:跨目录重排**拒绝** —— displayOrderById 是全局顺序,跨目录把 A
      //   挪到 B 旁边,在 B 目录里看是「多出一条、顺序没变」,在 A 目录里
      //   则是「A 没了」。静默错位比不做更糟。跨目录搬移请拖到文件夹行 /
      //   空白区(落根)。
      const movingItem = getItems().find((x) => x.id === moving);
      if (!movingItem) return;
      const targetDir = dirnameOfRelPath(item);
      if (dirnameOfRelPath(movingItem) !== targetDir) {
        // 跨目录落行:委托 onCrossFolderMove 搬进目标行所在目录(见头注)。
        //   注意此处已 preventDefault + stopPropagation(上方),容器空白区
        //   的 ROOT 落点不会再二次处理同一事件。
        latest.current.onCrossFolderMove?.(targetDir, e);
        return;
      }
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const before = e.clientY - rect.top < rect.height / 2;
      const current = getItems()
        .map((x) => x.id)
        .sort((a, b) => {
          const oa = displayOrderById[a] ?? Number.POSITIVE_INFINITY;
          const ob = displayOrderById[b] ?? Number.POSITIVE_INFINITY;
          if (oa !== ob) return oa - ob;
          return 0;
        });
      const filtered: string[] = current.filter((x) => x !== moving);
      const idx = filtered.indexOf(item.id);
      if (idx < 0) return;
      const insertAt = before ? idx : idx + 1;
      filtered.splice(insertAt, 0, moving);
      reorderByIds(filtered);
    },
    [applyIndicator, latest],
  );

  const handleItemReorderDragEnd = useCallback(
    (_e: ReactDragEvent) => {
      applyIndicator(null);
    },
    [applyIndicator],
  );

  return {
    reorderIndicator,
    handleItemReorderDragOver,
    handleItemReorderDragLeave,
    handleItemReorderDrop,
    handleItemReorderDragEnd,
  };
}
