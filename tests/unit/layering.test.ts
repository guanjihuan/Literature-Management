// tests/unit/layering.test.ts
//
// 守卫:进程分层 import 边界。renderer↔main 之间只能通过 preload(window.api)
//   桥,不能直接 import 对方代码。
//
// 规则:
//   - src/main/**/*.{ts,tsx}     禁止  import renderer 代码
//   - src/renderer/src/**/*.{ts,tsx} 禁止  import 主进程模块(走 window.api 桥)
//   - src/preload/**/*.{ts,tsx}  允许  import main 的**类型**(IPC 类型 contract)
//                            禁止  import renderer(否则把 renderer 逻辑拉进 main)
//
// ── audit-r254:守卫自身从「正则匹配源码文本」升级为「解析 import 并解析真实路径」──
//
// 旧实现有三处**假绿**(守卫绿着,却拦不住它声称要拦的东西)。以下每条
// 都做过**实证**(把违规探针塞进 src/,跑旧守卫看它是否转红):
//
//   ① 跨语句吞并(P0)—— preload 那条规则用
//         /import\s+(?:type\s+)?[\s\S]*?from\s*['"](?:@main\/|\.\.\/main\/…)/g
//         `[\s\S]*?` 会把**两条相邻 import** 合成一条语句。于是
//             import type { A } from '@shared/types';      ← 纯类型
//             import { errMsg } from '../main/utils/error'; ← 运行时值(违规)
//         被并成一条,`isTypeOnlyImport` 看到行首的 `import type` ⇒ 判「纯类型」
//         ⇒ **放行真正的违规**。
//         实证:旧守卫对这段 preload 代码 **绿**(违规在)。
//
//   ② 别名漏网(P1)—— tsconfig paths 里 `@/*` 也指向 src/renderer/src,
//         而旧规则只认 `@renderer/` 与相对路径 ⇒ main 进程里写
//             import { x } from '@/components/foo';
//         **完全不被拦**。
//         实证:旧守卫对这段 main 代码 **绿**(违规在)。
//
//   ③ 动态 import 漏网(P1)—— 旧规则只匹配 `from '…'` 与 `require('…')`,
//         不含 `import('…')` ⇒ renderer 里写
//             const m = await import('@main/utils/error');
//         **完全不被拦**。
//         实证:旧守卫对这段 renderer 代码 **绿**(违规在)。
//
//   (另注:旧规则靠手写层级正则,`../../main` 是**子串**匹配 —— 幸运的是
//    它也能命中 `../../../main`(实测),所以相对路径这一维并没漏;但同样
//    的子串语义会误命中 `../../mainland` 这类目录名。改用真实路径解析后,
//    任意层级都对,且不再靠手写清单。)
//
//   新实现:先把源码里的注释剥掉(避免注释里的 import 字样误报/漏报),
//   再逐条**解析** import 语句拿到模块说明符,最后把说明符**解析成真实
//   绝对路径**并判定它落在哪一层 —— 别名(@main/ @renderer/ @shared/ @/)与
//   相对路径(任意层级)一律按解析结果判定,不再靠手写层级清单。
//
// 允许破例的清单(测试用例、源头已知安全)用 ALLOWED_REASON 注释说明。
import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative, resolve, sep } from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkTs(full));
    } else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

interface Violation {
  file: string;
  line: number;
  text: string;
}

type Layer = 'main' | 'renderer' | 'preload' | 'shared';

/**
 * 剥掉注释,只留「代码」文本(逐行,行号不变)。
 *
 * 为什么必须剥:守卫扫的是**源码文本**,注释里写一句
 *   // 曾经写过:import { x } from '../main/utils/y';
 *   就会把注释当成真 import(误报);反过来,注释里那句**真曾发生过**的
 *   违规也不会被记录(漏报的「历史痕迹」不算问题,但不能反过来把真代码
 *   也放过)。剥掉注释后,匹配到的就一定是真语句。
 *
 * 说明:模板字符串跨行时,本扫描器按「行内闭合」处理 —— 极端情况下会把
 * 模板里的一行截断(只会造成漏报,不会误报)。
 */
function codeLines(src: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of src.split('\n')) {
    let outLine = '';
    let i = 0;
    let quote: string | null = null;
    while (i < raw.length) {
      const c = raw[i]!;
      const n = raw[i + 1];
      if (inBlock) {
        if (c === '*' && n === '/') {
          inBlock = false;
          i += 2;
          continue;
        }
        i++;
        continue;
      }
      if (quote) {
        if (c === '\\') {
          outLine += c + (n ?? '');
          i += 2;
          continue;
        }
        if (c === quote) quote = null;
        outLine += c;
        i++;
        continue;
      }
      if (c === '/' && n === '*') {
        inBlock = true;
        i += 2;
        continue;
      }
      if (c === '/' && n === '/') break; // 行注释 → 本行剩余丢弃
      if (c === '"' || c === "'" || c === '`') {
        quote = c;
        outLine += c;
        i++;
        continue;
      }
      outLine += c;
      i++;
    }
    out.push(outLine);
  }
  return out;
}

interface ImportHit {
  /** 模块说明符(原样,如 '../main/utils/error') */
  spec: string;
  /** 命中的整条语句(归一化空白,便于报错展示) */
  stmt: string;
  /** 是否纯类型 import(不引入运行时值) */
  typeOnly: boolean;
  /** 1 基行号 */
  line: number;
}

// import 语句:`import type X from 'y'` / `import { a, type b } from 'y'` /
// `import 'y'`(副作用) / `export ... from 'y'`(再导出)。
//
// 关键:`[^;'"]*?` 而不是 `[\s\S]*?` —— 前者**不允许**跨过引号与分号,
// 于是相邻两条 import **不会**被合成一条(旧实现的 P0-1)。
const IMPORT_FROM_RE = /\bimport\s+(type\s+)?([^;'"]*?)from\s*['"]([^'"]+)['"]/g;
const EXPORT_FROM_RE = /\bexport\s+([^;'"]*?)from\s*['"]([^'"]+)['"]/g;
const BARE_IMPORT_RE = /\bimport\s*['"]([^'"]+)['"]/g;
const REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const DYNAMIC_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** 判断一条 import 语句是否**纯类型**(不引入运行时值)。 */
function isTypeOnlyImport(stmt: string): boolean {
  const t = stmt.trim();
  if (/^import\s+type\b/.test(t)) return true;
  const m = /import\s*\{([\s\S]*?)\}/.exec(t);
  if (!m) return false; // default / namespace import ⇒ 运行时值
  const specs = m[1]!
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return specs.length > 0 && specs.every((s) => s.startsWith('type '));
}

/** 收集一个文件里的所有 import / re-export / require / 动态 import。 */
function collectImports(src: string): ImportHit[] {
  const lines = codeLines(src);
  const hits: ImportHit[] = [];
  const push = (spec: string, stmt: string, line: number): void => {
    hits.push({ spec, stmt: stmt.replace(/\s+/g, ' ').trim(), typeOnly: isTypeOnlyImport(stmt), line });
  };
  lines.forEach((text, idx) => {
    for (const m of text.matchAll(IMPORT_FROM_RE)) {
      push(m[3]!, m[0], idx + 1);
    }
    for (const m of text.matchAll(EXPORT_FROM_RE)) {
      push(m[2]!, m[0], idx + 1);
    }
    for (const m of text.matchAll(BARE_IMPORT_RE)) {
      push(m[1]!, m[0], idx + 1);
    }
    for (const m of text.matchAll(REQUIRE_RE)) {
      push(m[1]!, m[0], idx + 1);
    }
    for (const m of text.matchAll(DYNAMIC_RE)) {
      push(m[1]!, m[0], idx + 1);
    }
  });
  return hits;
}

/**
 * 把模块说明符解析成「它落在哪一层」。
 *
 * 别名(tsconfig paths):
 *   @shared/*  → src/shared        (共享层,任何层都可引)
 *   @main/*    → src/main
 *   @renderer/*→ src/renderer/src
 *   @/*        → src/renderer/src
 * 相对路径:按**导入文件所在目录**解析成绝对路径 —— 任意层级都对,
 *           不再靠手写 `../../main` 这类层级清单(旧实现的 P0-2)。
 * 裸包名:返回 null(第三方依赖,不在分层管辖内)。
 */
function layerOfSpecifier(spec: string, importerRel: string): Layer | null {
  if (spec.startsWith('@shared/')) return 'shared';
  if (spec.startsWith('@main/')) return 'main';
  if (spec.startsWith('@renderer/') || spec.startsWith('@/')) return 'renderer';
  if (!spec.startsWith('.')) return null; // 第三方包
  const abs = resolve(ROOT, dirname(importerRel), spec);
  const rel = relative(ROOT, abs).split(sep).join('/');
  if (rel.startsWith('src/main/')) return 'main';
  if (rel.startsWith('src/renderer/src/')) return 'renderer';
  if (rel.startsWith('src/preload/')) return 'preload';
  if (rel.startsWith('src/shared/')) return 'shared';
  return null;
}

function detectLayer(relPath: string): Layer | null {
  const rel = relPath.split(sep).join('/');
  if (rel.startsWith('src/main/')) return 'main';
  if (rel.startsWith('src/renderer/src/')) return 'renderer';
  if (rel.startsWith('src/preload/')) return 'preload';
  return null;
}

interface Rule {
  layer: Exclude<Layer, 'shared'>;
  /** 目标层:命中即越层 */
  forbiddenTarget: Exclude<Layer, 'shared'>;
  reason: string;
}

const RULES: Rule[] = [
  {
    layer: 'main',
    forbiddenTarget: 'renderer',
    reason: 'main 进程不应 import renderer 代码(IPC 是唯一通道)。',
  },
  {
    layer: 'renderer',
    forbiddenTarget: 'main',
    reason: 'renderer 代码不应 import 主进程模块(走 window.api 桥)。',
  },
  {
    layer: 'preload',
    forbiddenTarget: 'renderer',
    reason: 'preload 是 bridge,不应 import renderer(否则把 renderer 逻辑拉进 main)。',
  },
];

describe('进程分层 import 边界', () => {
  const sourceFiles = walkTs(join(ROOT, 'src'));

  for (const rule of RULES) {
    it(`${rule.layer}: ${rule.reason}`, () => {
      const violations: Violation[] = [];
      for (const file of sourceFiles) {
        const rel = relative(ROOT, file);
        if (detectLayer(rel) !== rule.layer) continue;
        const src = readFileSync(file, 'utf8');
        for (const hit of collectImports(src)) {
          if (layerOfSpecifier(hit.spec, rel) !== rule.forbiddenTarget) continue;
          violations.push({ file: rel, line: hit.line, text: hit.stmt });
        }
      }
      if (violations.length > 0) {
        // eslint-disable-next-line no-console
        console.error('layering violations:', violations);
      }
      expect(violations).toEqual([]);
    });
  }

  /**
   * audit-r229:preload 只能 import main 的**类型**(IPC 类型 contract),
   * 不得 import main 的**运行时值**。
   *
   * 事故形态:src/preload/index.ts 曾写
   *   `import { errMsg } from '../main/utils/error';`
   * —— 这是**值** import(不是 import type),把 main 的模块图拖进 preload,
   * 进而拖进 renderer 进程的启动路径。ARCHITECTURE「preload 只做桥、不含业务」
   * 与本文件头注「允许 import @main/*(IPC 类型 contract)」都只授权**类型**。
   * 同一文件里 r140 刚把 MAX_TOAST_MESSAGE_CHARS 从 main 搬到
   * @shared/limits/ipc「让 preload 跨进程 import main 间接」—— 同一个文件里
   * 一半搬走一半留下,自相矛盾。
   *
   * 修法(r229):errMsg 本体下沉到 @shared/display-string,preload 直连 shared。
   * 本规则把「preload 不得运行时引 main」钉住,防止下一个 helper 又走老路。
   */
  it('preload: 不得 import main 的运行时值(只允许类型)', () => {
    const violations: Violation[] = [];
    for (const file of sourceFiles) {
      const rel = relative(ROOT, file);
      if (detectLayer(rel) !== 'preload') continue;
      const src = readFileSync(file, 'utf8');
      for (const hit of collectImports(src)) {
        if (layerOfSpecifier(hit.spec, rel) !== 'main') continue;
        if (hit.typeOnly) continue;
        violations.push({ file: rel, line: hit.line, text: hit.stmt });
      }
    }
    if (violations.length > 0) {
      // eslint-disable-next-line no-console
      console.error('preload→main runtime import violations:', violations);
    }
    expect(violations).toEqual([]);
  });
});
