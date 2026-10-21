// tests/unit/renderer/store/self-write-window-parity.test.ts
//
// 守 r221「自写抑制窗口两域数值刻意不同」这条文档-代码一致性契约。
//
// ── 背景(peer r217 登记的未修项 ③)────────────────────────────────
//   自写抑制窗口(写操作后跳过自己引发的 CHANGED 推送)在两域取值不同:
//     src/renderer/src/store/notes.ts       SELF_WRITE_SUPPRESS_WINDOW_MS = 500
//     src/renderer/src/store/literature.ts  SELF_WRITE_SUPPRESS_WINDOW_MS = 200
//   而注释互相矛盾:notes 注释说「500ms 比 IPC roundtrip 略长」(真话是
//   要盖 watcher echo);ARCHITECTURE §8② 说两域都是 ~200ms;main/index.ts
//   的 literature 广播注释还停在 r136 M3 收紧前的「500ms self-write」。
//
// ── 为什么不是「统一成一个值」(r221 对账结论)─────────────────────
//   notes 500ms:save() 走乐观 patch、**不自己 load**,窗口必须盖过
//     watcher echo(chokidar awaitWriteFinish 50ms + reload 去抖 100ms +
//     scan/广播 ≈ 写后 150~400ms);收 200ms 会让 echo 漏出窗口 ⇒ 每秒
//     autosave 多一次全量拉 + 全列表重渲(perf 2026-09-04 的优化失效)。
//   literature 200ms:writer 自己 force load,窗口只需盖主进程同步 echo
//     (≈130ms);它的 watcher echo(awf 200ms + 去抖 100ms ≥ 300ms)
//     本来就盖不住,漏出的那次 force load 当 no-op 兜底接受(r136 注释
//     明示)。窗口越宽,窗口内的**外部**变更被当自写吞掉越久 ⇒
//     literature 坚持 200ms 是 r136 的刻意收紧,notes 保留 500ms 是
//     上述时序的必然。两值不同是设计,不是漂移。
//
// ── 本测锁的契约 ───────────────────────────────────────────────────
//   A. 两个常量保持 500 / 200(回归锚 —— 数值本身是设计决策);
//   B. main/index.ts 的 literature 广播注释不再谎称 500ms(r136 旧值);
//   D. notes 的常量注释块必须说明 500ms 的真实原因(watcher echo);
//   E. 两侧注释块互相交叉引用对方数值(防未来「好心统一」时不读理由)。
//
//   (原契约 C 锁 ARCHITECTURE.md §8② 同时写出两个值;2026-10-20 文档
//    三合一并入 README 后该文件删除,设计理由的单一真相源收编进两侧
//    代码注释 —— 即契约 D/E,ARCH 守卫随之退役。)
//
// 纯静态扫源码文本,不起进程。
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf-8');

const NOTES_STORE = 'src/renderer/src/store/notes.ts';
const LIT_STORE = 'src/renderer/src/store/literature.ts';
const MAIN_INDEX = 'src/main/index.ts';

/** 取常量定义行之前的注释块(理由就写在那里)。 */
function commentBlockBefore(src: string, anchor: string, span = 1800): string {
  const i = src.indexOf(anchor);
  expect(i, `锚点缺失:${anchor}`).toBeGreaterThanOrEqual(0);
  return src.slice(Math.max(0, i - span), i);
}

describe('自写抑制窗口两域刻意不同(r221)', () => {
  it('A1 notes 窗口 = 500ms(回归锚:盖 watcher echo 的必然值)', () => {
    expect(read(NOTES_STORE)).toContain('SELF_WRITE_SUPPRESS_WINDOW_MS = 500');
  });

  it('A2 literature 窗口 = 200ms(回归锚:r136 M3 刻意收紧值)', () => {
    expect(read(LIT_STORE)).toContain('SELF_WRITE_SUPPRESS_WINDOW_MS = 200');
  });

  it('B main/index.ts 的 literature 广播注释不再谎称窗口是 500ms', () => {
    const src = read(MAIN_INDEX);
    const block = commentBlockBefore(src, "literatureService.on('changed'");
    // 谎的具体形态 = 「订阅 + 500ms self-write 抑制窗口」(r136 M3 收紧前的
    // 旧值);注释里交叉引用 notes 的 500ms 是允许的。
    expect(block, 'literature 广播注释还停在 r136 M3 收紧前的 500ms 旧值').not.toMatch(
      /订阅 \+ 500ms/,
    );
    expect(block).toMatch(/订阅 \+ 200ms/);
  });

  it('D notes 的 500ms 注释块说明真实原因(watcher echo),不是「比 IPC roundtrip 略长」', () => {
    const block = commentBlockBefore(
      read(NOTES_STORE),
      'SELF_WRITE_SUPPRESS_WINDOW_MS = 500',
    );
    expect(block, '500ms 的真实原因是盖 watcher echo,注释必须写明').toContain(
      'watcher echo',
    );
  });

  it('E 两侧注释块交叉引用对方数值(防未来「好心统一」时不读理由)', () => {
    const notesBlock = commentBlockBefore(
      read(NOTES_STORE),
      'SELF_WRITE_SUPPRESS_WINDOW_MS = 500',
    );
    const litBlock = commentBlockBefore(
      read(LIT_STORE),
      'SELF_WRITE_SUPPRESS_WINDOW_MS = 200',
    );
    expect(notesBlock, 'notes 注释必须点名 literature 的 200ms 及差异原因').toContain(
      'literature 的 200ms',
    );
    expect(litBlock, 'literature 注释必须点名 notes 的 500ms 及差异原因').toContain(
      'notes 域是 500ms',
    );
  });
});
