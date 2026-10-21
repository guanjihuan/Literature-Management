// tests/unit/renderer/lib/click-select-route.test.ts
//
// 守 r228「修饰键点击路由单一真相源」契约:
//
//   旧状态(实测分叉):NotesList / LiteratureList 的 handleSelect 各写一份
//   mode 分支。文献域的 toggle / range 分支会 setActiveId(让 listbox 本地
//   键盘光标 / aria-activedescendant 跟手),**笔记域漏了** ⇒ 笔记侧
//   Ctrl+点击后光标仍停在旧行,紧接着按 F2 会重命名**旧行**而不是刚点的那
//   行(r160 B7 那次「click 后把焦点搬到 listbox」的修复只进了文献侧)。
//
//   修法不是给笔记补一行 setActiveId(下次还会分叉),而是把路由本体上收到
//   lib/multi-select.applyClickSelectRoute,两域共用一份 ⇒ 分叉不可能再长
//   出来(同 isReallyGone 上收 utils/file-check.ts 的做法)。
//
// 锁两类东西:
//   1. 行为契约(applyClickSelectRoute):
//      toggle ⇒ toggleSelect + setActiveId(光标跟手),不动主选中相关动作;
//      range  ⇒ selectRange + setActiveId,同上;
//      single ⇒ selectOnly + select(设主选中),**不**调 setActiveId
//               (两域的 activeId 靠「selectedId 变化 → effect 同步」跟随,
//                在路由里再写一次属重复);
//   2. 端到端一条:修饰键 → 模式 → 路由动作串起来(防「模式解析与路由
//      各改各的」)。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  applyClickSelectRoute,
  resolveClickSelectMode,
  type ClickSelectMode,
} from '../../../../src/renderer/src/lib/multi-select';

function makeActions() {
  const calls: string[] = [];
  // audit-r229:参数类型放宽到 `string | null` —— 路由契约里 setActiveId 的
  //   签名是 `(id: TId | null) => void`,而 applyClickSelectRoute 的 TId
  //   由字面量 id 推断成 'n1' / 'n2' 这类**窄字面量类型** ⇒ mock 若只写
  //   `(id: string) => void`,把 mock 传给路由时 TS2345 报错
  //   (peer 在途文件的 typecheck 红,本轮顺手收口)。函数参数逆变 ⇒
  //   宽参类型可赋给窄参类型,行为一字未改。
  const rec = (name: string) => (id: string | null) => {
    calls.push(`${name}:${id}`);
  };
  return {
    calls,
    actions: {
      toggleSelect: rec('toggle'),
      selectRange: rec('range'),
      selectOnly: rec('only'),
      select: rec('select'),
      setActiveId: rec('active'),
    },
  };
}

describe('applyClickSelectRoute(r228 路由单一真相源)', () => {
  it('toggle:切多选成员 + 键盘光标跟手;不动主选中', () => {
    const { calls, actions } = makeActions();
    applyClickSelectRoute('toggle', 'n1', actions);
    expect(calls).toEqual(['toggle:n1', 'active:n1']);
  });

  it('range:范围选择 + 键盘光标跟手;不动主选中', () => {
    const { calls, actions } = makeActions();
    applyClickSelectRoute('range', 'n2', actions);
    expect(calls).toEqual(['range:n2', 'active:n2']);
  });

  it('single:作用集收成该行 + 设主选中;不调 setActiveId', () => {
    const { calls, actions } = makeActions();
    applyClickSelectRoute('single', 'n3', actions);
    expect(calls).toEqual(['only:n3', 'select:n3']);
  });

  it('端到端:修饰键 → 模式 → 动作(Ctrl=toggle / Shift=range / 其它=single)', () => {
    const run = (e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => {
      const { calls, actions } = makeActions();
      applyClickSelectRoute(resolveClickSelectMode(e), 'x', actions);
      return calls;
    };
    expect(run({ ctrlKey: true, metaKey: false, shiftKey: false })).toEqual([
      'toggle:x',
      'active:x',
    ]);
    expect(run({ ctrlKey: false, metaKey: true, shiftKey: false })).toEqual([
      'toggle:x',
      'active:x',
    ]);
    expect(run({ ctrlKey: false, metaKey: false, shiftKey: true })).toEqual([
      'range:x',
      'active:x',
    ]);
    expect(run({ ctrlKey: false, metaKey: false, shiftKey: false })).toEqual([
      'only:x',
      'select:x',
    ]);
  });

  it('模式解析的取值域就是路由的三分支(新增模式必须同时改路由)', () => {
    const modes: ClickSelectMode[] = ['single', 'toggle', 'range'];
    for (const m of modes) {
      const { calls, actions } = makeActions();
      applyClickSelectRoute(m, 'id', actions);
      expect(calls.length).toBeGreaterThan(0);
    }
  });
});

describe('r228 结构契约:两域必须共用同一份路由(孪生分支不得复活)', () => {
  const ROOT = process.cwd();
  const FILES = [
    'src/renderer/src/components/notes/NotesList.tsx',
    'src/renderer/src/components/literature/LiteratureList.tsx',
  ];
  for (const rel of FILES) {
    it(`${rel} 走 lib/multi-select.applyClickSelectRoute`, () => {
      const src = readFileSync(join(ROOT, rel), 'utf-8');
      expect(src, '点击路由必须走 lib/multi-select 的单一真相源').toContain('applyClickSelectRoute');
      expect(
        src,
        '孪生块复活:组件里又内联了 mode 分支(两域会再次分叉)',
      ).not.toContain("if (mode === 'toggle')");
    });
  }
});
