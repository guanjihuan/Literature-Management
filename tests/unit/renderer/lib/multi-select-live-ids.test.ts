// tests/unit/renderer/lib/multi-select-live-ids.test.ts
//
// 守 r193「删除 / 移入回收站只对**活着的** id 动手」契约。
//
// 现象(用户可复现):
//   1. 侧栏 Ctrl 多选 5 篇笔记;
//   2. 其中 1 篇在别处被删了(另一个窗口删 / 网盘同步删 / 回收站清理);
//   3. 回到应用,侧栏仍显示 5 篇被选中(那一行还在,因为列表还没刷新);
//   4. 按 Delete / 右键「移入回收站」⇒ 抛 NOT_FOUND ⇒ **串行循环中断** ⇒
//      只删了 3 篇,后面 2 篇没删,还弹一个「移入回收站失败」toast。
//
// 现象(两侧不对称版):
//   同样的操作在**文献侧**是好的 —— literature 侧删除前用
//   `items.filter(r => selectedIds.has(r.id))` 过滤,死 id 被静默跳过;
//   笔记侧直接拿 selectedIds 全集去删 ⇒ 一边好用一边不好用。
//
// 本测锁:
//   1. liveSelectedIds:只返回列表里还活着的成员,按**列表顺序**;
//   2. 空选择集 → 空结果(不返回 undefined / 不抛);
//   3. 全部死 id → 空结果(而不是把死 id 原样吐出去);
//   4. 源码契约:两个列表组件的删除回调都必须经过 liveSelectedIds,
//      不得直接用 selectedIds 全集(防止以后又写回不对称的老写法)。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

import { liveSelectedIds } from '../../../../src/renderer/src/lib/multi-select';

const ROOT = process.cwd();
const NOTES = 'src/renderer/src/components/notes/NotesList.tsx';
const LIT = 'src/renderer/src/components/literature/LiteratureList.tsx';

interface Row {
  id: string;
}

/**
 * 取出某个 `useCallback(` 回调的**函数体**。
 *
 * audit-r254:旧实现用 `src.slice(src.indexOf(anchor))` +
 * `src.slice(0, src.indexOf(endAnchor))` 切片 —— **锚点缺失时 indexOf
 * 返回 -1**,而 `slice(-1)` 取的是**最后一个字符**、`slice(0, -1)` 取的是
 * 「除末字符外的全文」⇒ 切片范围**静默漂移**:
 *   - 起始锚点丢了(回调改名/删除)⇒ 拿到空串 ⇒ 断言红(报错信息难读);
 *   - 结束锚点丢了(**依赖清单一改就会丢**,最常见的改动)⇒ 范围悄悄放大
 *     成「从回调一直到文件尾」⇒ 断言 `toContain('liveSelectedIds(')` 可以
 *     被**函数体之外**的同名文本满足 ⇒ 回调真的不用 liveSelectedIds 了,
 *     守卫照样绿(假绿)。
 *
 * 这里改成:锚点缺失 / 顺序不对 ⇒ **直接失败**,让守卫真的失效;
 * 结束锚点只认 useCallback 的收尾形态 `}, [`(不写死依赖清单,免得依赖项
 * 一改守卫就假红 —— 那种红是「守卫跟不上实现」,不是「实现有病」)。
 */
function sliceCallbackBody(src: string, startAnchor: string): string {
  const s = src.indexOf(startAnchor);
  expect(s, `起始锚点缺失:${startAnchor}`).toBeGreaterThanOrEqual(0);
  const e = src.indexOf('\n  }, [', s);
  expect(e, `结束锚点缺失(未找到 useCallback 收尾):${startAnchor}`).toBeGreaterThan(s);
  return src.slice(s, e);
}

/**
 * 剥掉注释 —— 断言必须落在**真代码**上。
 *
 * 实证(旧守卫的第二个假绿面):LiteratureList.tsx 的删除回调里有一行**注释**
 *   // r193:与 notes 侧共用 liveSelectedIds(死 id 静默跳过,别让
 * 这行注释里含字面量 `liveSelectedIds(` ⇒ 旧守卫的
 * `expect(body).toContain('liveSelectedIds(')` 可以**被注释满足** ⇒
 * 把真正的调用换成 `Array.from(st.selectedIds)` 也不红。
 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('liveSelectedIds:作用集只含活着的成员(r193)', () => {
  it('只返回列表里还活着的成员,按列表顺序', () => {
    const items: Row[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    // 选择集里有 'b'(活着)+ 'zz'(不在列表里 ⇒ 死 id)
    const out = liveSelectedIds(items, new Set(['b', 'zz']));
    expect(out.map((x) => x.id)).toEqual(['b']);
  });

  it('选择集顺序与列表顺序不一致时,以**列表顺序**为准', () => {
    const items: Row[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const out = liveSelectedIds(items, new Set(['c', 'a']));
    expect(out.map((x) => x.id)).toEqual(['a', 'c']);
  });

  it('空选择集 → 空结果', () => {
    expect(liveSelectedIds([{ id: 'a' }], new Set<string>())).toEqual([]);
  });

  it('全是死 id → 空结果(不得把死 id 吐出去)', () => {
    const out = liveSelectedIds([{ id: 'a' }], new Set(['x', 'y']));
    expect(out).toEqual([]);
  });

  it('源码契约:两个域的删除回调都必须过滤成「活着的 id」', () => {
    const notesSrc = readFileSync(join(ROOT, NOTES), 'utf8');
    const litSrc = readFileSync(join(ROOT, LIT), 'utf8');

    // notes 侧:handleTrashSelection
    const notesTrashBody = stripComments(
      sliceCallbackBody(notesSrc, 'const handleTrashSelection = useCallback('),
    );
    expect(notesTrashBody, 'notes 侧删除必须用 liveSelectedIds 过滤').toContain('liveSelectedIds(');
    expect(
      notesTrashBody,
      'notes 侧不得再直接用 selectedIds 全集([...selectedIds])',
    ).not.toMatch(/\[\.\.\.\s*(?:useNotesStore\.getState\(\)\.)?selectedIds\]/);

    // literature 侧:handleDeleteSelection
    const litDeleteBody = stripComments(
      sliceCallbackBody(litSrc, 'const handleDeleteSelection = useCallback('),
    );
    expect(litDeleteBody, 'literature 侧删除必须用 liveSelectedIds 过滤').toContain('liveSelectedIds(');
    expect(
      litDeleteBody,
      'literature 侧也不得直接用 selectedIds 全集([...selectedIds])',
    ).not.toMatch(/\[\.\.\.\s*(?:useLiteratureStore\.getState\(\)\.)?selectedIds\]/);
  });
});
