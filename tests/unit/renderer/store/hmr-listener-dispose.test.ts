// tests/unit/renderer/store/hmr-listener-dispose.test.ts
//
// 守「模块级订阅 onXxxChanged 的 store 必须有 import.meta.hot 自卸载」这条
// 约定(r213)。
//
// ── 被守卫的缺陷(不是风格问题,是 dev 态的监听器泄漏)─────────────────
//   这些 store 在**模块顶层**订阅主进程推送(`_ensureInit()` 里
//   `_unsubscribe = window.api.onNotesChanged(...)`,模块一加载就订,不等
//   React mount)。dev 模式下 vite-plugin-react 改**任意** source file 都会
//   触发本模块的 HMR 重求值,模块顶层副作用会**再跑一次** —— 于是旧
//   listener(指向旧模块闭包)没被摘掉、新 listener 又订上一份。
//
//   后果:N 次热更后监听器集合单调增长到 N 份,一次 NOTES_CHANGED /
//   LITERATURE_CHANGED 广播触发 **N 次并发** listNotes / listLiterature IPC
//   与 N 轮全列表重渲,而且这些旧监听器**永远无法回收**(teardown 函数只有
//   测试调用,生产路径从不摘)。
//
//   修法 = 在每个这种 store 里加 `import.meta.hot?.dispose(() => { …摘监听… })`
//   —— 在 HMR 替换本模块**之前**跑,摘掉旧 listener,让新一轮 `_ensureInit`
//   重订一次。生产 build `import.meta.hot === undefined`,自然不挂这条逻辑。
//   对照:`store/literature.ts`(r136 M7)与 `store/workspace.ts` 都有这条;
//   `store/notes.ts` **漏了**(r213 补上)。
//
// ── 判定方式 ───────────────────────────────────────────────────────
//   静态扫 src/renderer/src/store/*.ts:凡是出现**模块级订阅**形态
//   `window.api.on…Changed(` 的文件,必须同时出现 `import.meta.hot`
//   (dispose 钩子的标记)。这是结构守卫 —— 它锁「该有 dispose 的文件不许漏」,
//   而不是去模拟 HMR 运行时(jsdom 没法重放 Vite 的模块替换)。
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const STORE_DIR = join(ROOT, 'src', 'renderer', 'src', 'store');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

function relOf(abs: string): string {
  return relative(ROOT, abs).split('\\').join('/');
}

/** 模块级推送订阅的形态(window.api.on<…>Changed( —— 含 notes / literature 等) */
const PUSH_SUBSCRIBE_RE = /window\.api\.on\w*Changed\(/;
/** HMR 自卸载的标记 */
const HMR_DISPOSE_RE = /import\.meta\.hot/;

describe('模块级推送订阅必须有 HMR 自卸载(r213)', () => {
  it('每个订阅 onXxxChanged 的 store 都有 import.meta.hot dispose', () => {
    const violations: string[] = [];
    for (const file of walk(STORE_DIR)) {
      const src = readFileSync(file, 'utf-8');
      if (!PUSH_SUBSCRIBE_RE.test(src)) continue; // 不订阅推送的 store 不适用
      if (HMR_DISPOSE_RE.test(src)) continue; // 有 dispose ⇒ 通过
      violations.push(relOf(file));
    }

    expect(
      violations,
      violations.length > 0
        ? `这些 store 在模块顶层订阅了 onXxxChanged,却没有 import.meta.hot dispose:\n` +
          violations.map((v) => `  ${v}`).join('\n') +
          `\n后果:dev 态每次 HMR 都泄漏一个 listener,N 次热更后一次广播触发 N 次\n` +
          `并发 IPC 与 N 轮全列表重渲,旧 listener 永远回收不掉。\n` +
          `修法:照 store/literature.ts 的 r136 M7 模式补一段 ——\n` +
          `  if (typeof import.meta.hot !== 'undefined') {\n` +
          `    import.meta.hot?.dispose(() => { /* _unsubscribe(); _initialized=false */ });\n` +
          `  }`
        : '',
    ).toEqual([]);
  });

  it('守卫本身是有效的(变异对照:有订阅无 dispose ⇒ 抓得到)', () => {
    // fake 用**正则源文本**(字符串)表达,避免 import.meta.hot 字面量被
    // esbuild 在测试构建时静态处理掉(它会让断言依赖构建期行为,不可靠)。
    const disposeMarker = new RegExp(HMR_DISPOSE_RE.source);
    const fake = [
      "const _unsub = window.api.onNotesChanged(() => { /* … */ });",
      '// 这个文件没有任何 HMR dispose',
    ].join('\n');
    expect(PUSH_SUBSCRIBE_RE.test(fake)).toBe(true);
    expect(disposeMarker.test(fake)).toBe(false); // ⇒ 这条 fake 会被主守卫抓到

    // 反向:有订阅 + 有 dispose ⇒ 通过
    const good = fake + '\n' + 'if (import.meta.hot) { import.meta.hot.dispose(() => {}); }';
    expect(PUSH_SUBSCRIBE_RE.test(good)).toBe(true);
    expect(disposeMarker.test(good)).toBe(true);
  });

  it('非订阅文件(纯逻辑 store)不适用本约定(对照)', () => {
    const pure = "export const x = 1;\nif (import.meta.hot) { /* 别的用途 */ }";
    expect(PUSH_SUBSCRIBE_RE.test(pure)).toBe(false); // ⇒ 不在本守卫的作用集里
  });
});
