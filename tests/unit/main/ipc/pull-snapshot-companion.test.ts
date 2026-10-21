// tests/unit/main/ipc/pull-snapshot-companion.test.ts
//
// 守 r54 I4「pull-snapshot 配对」这条 IPC 契约(🔒 标记自 r54 一直挂在这个
// 路径上,r211 补上守卫本体)。
//
// ── 被守卫的缺陷(不是风格问题,是契约空洞)──────────────────────────
//   r54 I4 的设计:每个 push 通道配一条 GET_STATE invoke,让 renderer 在
//   mount 时主动拉一份 baseline,补「主进程 push 已先于 listener 注册」的
//   race。配套的注释在五层里都写得很认真:
//
//     src/shared/types.ts        「每个配对 push 都对应一条 GET_STATE invoke」
//     src/preload/index.ts       「防『主进程 push 已先于 renderer listener』竞态」
//     src/main/ipc/workspace.ts  「renderer remount 时若 listener 还没注册会错过」
//     src/renderer/.../literature.ts 「pull-snapshot 由 literatureGetState 兜底」
//
//   但 LITERATURE_GET_STATE 与 FAVORITES_GET_STATE **从没有任何 renderer
//   调用点**(实测:src/renderer/ 全域 grep 零命中,只有注释提到它们)。
//   而两者的 handler 又与同域的 LIST 通道同源同形:
//     literature:get-state → svc.list()          ≡ literature:list
//     favorites:get-state  → listEntries()+filter ≡ favorites:list
//   ⇒ 它们是两条**空壳 API**:既骗注释(宣称兜底一个并不存在的 race),
//     又是五层(enum / preload / api-types / main handler / schema)里的死代码。
//
//   那个 race 的真实修法是「**先订阅再 load**」,不是额外一次 pull:
//     favorites: useSyncStores 的 useEffect —— 先 api.onFavoritesChanged(…),
//               再 useFavoritesStore.getState().load()(2026-09-10 的修法)
//     literature: store 模块顶层 _ensureInit() 订阅(严格早于任何组件挂载),
//               LiteratureList 的 useEffect 里首次 load()
//   订阅严格早于首次拉取 ⇒ 不存在漏事件窗口 ⇒ 额外 pull 是多余的。
//
//   r211 的处置:两条空壳配对整对下线(enum / preload / api-types / main /
//   schema 全清),配对表只剩启动进度一条(STARTUP_PROGRESS →
//   STARTUP_GET_STATE,它的 renderer 调用方是 useSyncStores 的
//   api.getStartupState())。
//
// ── 本测锁的契约 ───────────────────────────────────────────────────
//   A. 配对表与 IPC 枚举**完全一致**:
//      A1 枚举里每个 *_GET_STATE 通道都在配对表里
//         (表外的 *_GET_STATE 必然是空壳 —— 那正是本轮清掉的两条)
//      A2/A3 配对表里每个通道都还在枚举里(表不许写得过时)
//   B. 每一对的 **push** 通道五层齐:preload 有 ipcRenderer.on 订阅方法 →
//      api-types 的 Api 接口声明了它 → renderer 真的调用了它 → 主进程有
//      真实 send 点(且不在 ipc/ handler 层里)
//   C. 每一对的 **get_state** 通道五层齐:preload 有 invokeGuard 方法 →
//      api-types 声明 → renderer **真的调用了它** → src/main/ipc 有 handler
//      —— C 里的「renderer 真的调用了它」是本守卫的核心:少了这一条,
//      空壳配对就能一路混过五层而不被发现(当初就是这么混过去的)
//   D. 已退役的 LITERATURE_GET_STATE / FAVORITES_GET_STATE 不得复活
//      (enum / preload / api-types / main / schemas 任一处出现都红)
//
// ── 判定方式 ───────────────────────────────────────────────────────
//   纯静态扫源码(不 import electron / 不起进程):枚举、正则切方法体、
//   递归找调用点。注释先剥掉,免得「注释里提到通道名」被当成接线。
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf-8');
}

/** 剥掉块注释与行注释(行注释的 `//` 前不许是 `:` —— 免得砍掉 https://) */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function relOf(abs: string): string {
  return relative(ROOT, abs).split('\\').join('/');
}

// ── IPC 枚举 ────────────────────────────────────────────────────────

/** src/shared/types.ts 里 IPC 常量的成员名 */
function ipcChannelKeys(): string[] {
  const src = read('src/shared/types.ts');
  const start = src.indexOf('export const IPC = {');
  const end = src.indexOf('} as const;', start);
  expect(start, 'src/shared/types.ts 里找不到 `export const IPC = {`').toBeGreaterThan(-1);
  expect(end, 'src/shared/types.ts 里找不到 `} as const;`').toBeGreaterThan(-1);
  const body = src.slice(start, end);
  const keys: string[] = [];
  for (const m of body.matchAll(/^\s{2}([A-Z][A-Z0-9_]*):/gm)) keys.push(m[1]);
  return keys;
}

// ── preload ─────────────────────────────────────────────────────────

/**
 * preload 顶层 `const api: Api = { … }` 的方法名 → 方法体(注释已剥)。
 * 方法体 = 下一个顶层方法起点之前的全部文本。
 */
function preloadMethodBodies(): Map<string, string> {
  const src = stripComments(read('src/preload/index.ts'));
  const marks: Array<{ name: string; start: number }> = [];
  for (const m of src.matchAll(/^ {2}([A-Za-z_$][\w$]*):/gm)) {
    marks.push({ name: m[1], start: m.index });
  }
  const bodies = new Map<string, string>();
  marks.forEach((mk, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].start : src.length;
    bodies.set(mk.name, src.slice(mk.start, end));
  });
  return bodies;
}

/** preload 里「订阅了 IPC.<channel>」的方法名 */
function preloadOnMethod(channel: string): string | null {
  for (const [name, body] of preloadMethodBodies()) {
    if (body.includes(`ipcRenderer.on(IPC.${channel}`)) return name;
  }
  return null;
}

/** preload 里「invoke 了 IPC.<channel>」的方法名 */
function preloadInvokeMethod(channel: string): string | null {
  for (const [name, body] of preloadMethodBodies()) {
    if (!body.includes(`IPC.${channel}`)) continue;
    if (!body.includes('invokeGuard')) continue;
    return name;
  }
  return null;
}

// ── api-types(Api 接口 = preload 的类型真相)────────────────────────

/** shared/api-types.ts 的 `Api` 接口体(注释已剥) */
function apiInterfaceBody(): string {
  const src = stripComments(read('src/shared/api-types.ts'));
  const start = src.indexOf('export interface Api {');
  expect(start, 'src/shared/api-types.ts 里找不到 `export interface Api {`').toBeGreaterThan(-1);
  const end = src.indexOf('\n}', start);
  expect(end, 'Api 接口没有闭合的 `\\n}`').toBeGreaterThan(-1);
  return src.slice(start, end);
}

function apiTypesDeclares(method: string): boolean {
  return new RegExp(`^\\s{2}${method}\\s*\\(`, 'm').test(apiInterfaceBody());
}

// ── renderer ────────────────────────────────────────────────────────

/** renderer 里调用了 `.<method>(` 的文件(相对路径) */
function rendererCallers(method: string): string[] {
  const hits: string[] = [];
  for (const file of walk(join(ROOT, 'src', 'renderer'))) {
    const src = read(relOf(file));
    if (new RegExp(`\\.${method}\\s*\\(`).test(src)) hits.push(relOf(file));
  }
  return hits;
}

// ── main ────────────────────────────────────────────────────────────

/** main 侧 IPC.<channel> 的 send 点(不在 ipc/ handler 层里) */
function mainSendPoints(channel: string): string[] {
  const hits: string[] = [];
  for (const file of walk(join(ROOT, 'src', 'main'))) {
    const rel = relOf(file);
    if (rel.startsWith('src/main/ipc/')) continue; // handler 层不算 send 点
    for (const line of read(rel).split('\n')) {
      if (!line.includes(`IPC.${channel}`)) continue;
      if (!/send|broadcast|postMessage/i.test(line)) continue;
      hits.push(rel);
    }
  }
  return hits;
}

/** main/ipc 层里注册了 IPC.<channel> 的文件 */
function mainHandlerFiles(channel: string): string[] {
  const hits: string[] = [];
  for (const file of walk(join(ROOT, 'src', 'main', 'ipc'))) {
    if (read(relOf(file)).includes(`IPC.${channel}`)) hits.push(relOf(file));
  }
  return hits;
}

// ── 配对表 ──────────────────────────────────────────────────────────

/**
 * 现存的 pull-snapshot 配对。改这张表 = 改 IPC 契约,必须同时改
 * enum / preload / api-types / main handler / renderer 调用点。
 */
const PAIRS: ReadonlyArray<{ push: string; getState: string }> = [
  { push: 'STARTUP_PROGRESS', getState: 'STARTUP_GET_STATE' },
];

/** r211 整对下线的通道 —— 不得复活(复活即空壳) */
const RETIRED_GET_STATE = ['LITERATURE_GET_STATE', 'FAVORITES_GET_STATE'];

describe('pull-snapshot 配对契约(r54 I4 / r211)', () => {
  const channels = ipcChannelKeys();

  describe('A. 配对表与 IPC 枚举一致', () => {
    it('A1 枚举里每个 *_GET_STATE 通道都在配对表里(表外的必然是空壳)', () => {
      const inEnum = channels.filter((c) => c.endsWith('_GET_STATE'));
      const table = new Set(PAIRS.map((p) => p.getState));
      const orphans = inEnum.filter((c) => !table.has(c));
      expect(
        orphans,
        orphans.length > 0
          ? `这些 *_GET_STATE 通道不在配对表里:\n` +
            orphans.map((c) => `  IPC.${c}`).join('\n') +
            `\n空壳通道的典型症状 = 五层都齐(enum/preload/api-types/main)、` +
            `但 renderer 从不调用它。要么接上真实调用方,要么整对下线。`
          : '',
      ).toEqual([]);
    });

    it('A2 配对表里每个 get_state 通道都还在枚举里', () => {
      const missing = PAIRS.map((p) => p.getState).filter((c) => !channels.includes(c));
      expect(missing, `配对表里的通道不在 IPC 枚举里: ${missing.join(', ')}`).toEqual([]);
    });

    it('A3 配对表里每个 push 通道都还在枚举里', () => {
      const missing = PAIRS.map((p) => p.push).filter((c) => !channels.includes(c));
      expect(missing, `配对表里的通道不在 IPC 枚举里: ${missing.join(', ')}`).toEqual([]);
    });
  });

  describe('B. 每对的 push 通道五层齐', () => {
    for (const pair of PAIRS) {
      it(`B ${pair.push}:preload 订阅 → api-types 声明 → renderer 调用 → main 有 send 点`, () => {
        const onMethod = preloadOnMethod(pair.push);
        expect(onMethod, `preload 里找不到 ipcRenderer.on(IPC.${pair.push}, …)`).not.toBeNull();
        expect(
          apiTypesDeclares(onMethod as string),
          `api-types 的 Api 接口没声明 preload 的订阅方法 ${onMethod}`,
        ).toBe(true);
        const callers = rendererCallers(onMethod as string);
        expect(
          callers,
          `renderer 里没人调用 ${onMethod}(…) ⇒ 这条 push 通道根本没人听`,
        ).not.toEqual([]);
        const sends = mainSendPoints(pair.push);
        expect(
          sends,
          `主进程里找不到 IPC.${pair.push} 的 send 点(要有一个含 send/broadcast 的调用)`,
        ).not.toEqual([]);
      });
    }
  });

  describe('C. 每对的 get_state 通道五层齐(含 renderer 真实调用方)', () => {
    for (const pair of PAIRS) {
      it(`C ${pair.getState}:preload invoke → api-types 声明 → renderer 调用 → main handler`, () => {
        const invokeMethod = preloadInvokeMethod(pair.getState);
        expect(
          invokeMethod,
          `preload 里找不到 invokeGuard(… IPC.${pair.getState} …)`,
        ).not.toBeNull();
        expect(
          apiTypesDeclares(invokeMethod as string),
          `api-types 的 Api 接口没声明 preload 的 invoke 方法 ${invokeMethod}`,
        ).toBe(true);
        const callers = rendererCallers(invokeMethod as string);
        expect(
          callers,
          `renderer 里没人调用 ${invokeMethod}(…) ⇒ 这条 GET_STATE 是空壳\n` +
            `(五层都齐,但没人用 —— r211 清掉的 LITERATURE/FAVORITES 两对就是\n` +
            ` 这个形状:与同域 LIST 通道同源同形,注释还宣称它兜底 race。\n` +
            ` 修法二选一:① 接上真实调用方(并在注释里说明为什么需要它);\n` +
            `          ② 整对下线(enum/preload/api-types/main/schema 全清),\n` +
            `             把「先订阅再 load」的顺序写成真正的兜底说明。)`,
        ).not.toEqual([]);
        const handlers = mainHandlerFiles(pair.getState);
        expect(handlers, `src/main/ipc 下没有注册 IPC.${pair.getState} 的 handler`).not.toEqual([]);
      });
    }
  });

  describe('D. 已退役的 GET_STATE 通道不得复活', () => {
    for (const channel of RETIRED_GET_STATE) {
      it(`D ${channel}:enum / preload / api-types / main / schemas 全域不得出现`, () => {
        expect(
          channels,
          `IPC 枚举里复活了 ${channel}(r211 已把它整对下线 —— 它是空壳:` +
            `与同域 LIST 通道同源同形,且 renderer 从来没调用过)`,
        ).not.toContain(channel);

        // 只看**代码**,不看注释:退役说明本身要在注释里提到通道名(那是
        // 给人看的历史记录),把注释也算进「复活」会让这条守卫没法用。
        const base = channel.replace(/_GET_STATE$/, '');
        const pascal = base.charAt(0) + base.slice(1).toLowerCase();
        const patterns = [`IPC.${channel}`, `Zod${pascal}GetState`];

        const scanned: Array<[string, string]> = [
          ['src/preload/index.ts', stripComments(read('src/preload/index.ts'))],
          ['src/shared/api-types.ts', stripComments(read('src/shared/api-types.ts'))],
          ['src/shared/schemas/ipc.ts', stripComments(read('src/shared/schemas/ipc.ts'))],
        ];
        for (const file of walk(join(ROOT, 'src', 'main'))) {
          scanned.push([relOf(file), stripComments(read(relOf(file)))]);
        }
        const alive = scanned
          .filter(([, src]) => patterns.some((p) => src.includes(p)))
          .map(([f]) => f);
        expect(
          alive,
          `${channel} 在这些文件里复活了:\n` + alive.map((f) => `  ${f}`).join('\n'),
        ).toEqual([]);
      });
    }
  });

  describe('E. 守卫自身有效(变异对照)', () => {
    it('E1 方法体切分能把「注释里提到通道名」与「真的订阅了」区分开', () => {
      // 造一段假的 preload:方法 a 的注释里提到 IPC.FAKE_PUSH,方法 b 才真的订阅
      const fake = [
        'const api = {',
        '  // 说明文字:方法 a 的注释里提到 IPC.FAKE_PUSH',
        '  a: () => {',
        '    // IPC.FAKE_PUSH',
        '  },',
        '  b: () => {',
        '    ipcRenderer.on(IPC.FAKE_PUSH, listener);',
        '  },',
        '};',
      ].join('\n');
      const marks: Array<{ name: string; start: number }> = [];
      for (const m of fake.matchAll(/^ {2}([A-Za-z_$][\w$]*):/gm)) {
        marks.push({ name: m[1], start: m.index });
      }
      const bodies = new Map<string, string>();
      marks.forEach((mk, i) => {
        const end = i + 1 < marks.length ? marks[i + 1].start : fake.length;
        bodies.set(mk.name, fake.slice(mk.start, end));
      });
      const found = [...bodies].find(([, body]) => body.includes('ipcRenderer.on(IPC.FAKE_PUSH'));
      expect(found?.[0]).toBe('b');
    });

    it('E2 真实仓库里 preload 的 STARTUP 订阅方法查得到、且不是被注释骗到', () => {
      const method = preloadOnMethod('STARTUP_PROGRESS');
      expect(method).toBe('onStartupProgress');
      expect(apiTypesDeclares(method as string)).toBe(true);
      expect(rendererCallers(method as string).length).toBeGreaterThan(0);
    });
  });
});
