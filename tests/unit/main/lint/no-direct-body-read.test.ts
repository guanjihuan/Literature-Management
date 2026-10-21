// tests/unit/main/lint/no-direct-body-read.test.ts
//
// 守「笔记 / Markdown body 的读必须走单一入口」这条契约(2026-10-20,r203):
//
//   src/main/utils/body-cap.ts:readBodyWithCap —— 单 fd stat + read,
//   5MB 上限,超限抛 TOO_LARGE。
//
// 为什么这条是安全面(不是风格):fs.stat + fs.readFile 两步走法在 stat 与
// read 之间有 TOCTOU 窗口 —— AV 隔离 / OneDrive 重水合 / 用户 atomic-rename
// 都可能把文件换成 1GB+ 大文件,5MB 上限失效,主进程 OOM。走单一入口才有
// 单 fd 的 size 保护。
//
// 判定方式:静态扫 src/main/** 里的直接读调用(`readFile(` / `readFileSync(`),
// 路径参数**看起来像 .md / note / markdown** 的一律违规 —— 白名单只有两个:
//   - src/main/utils/body-cap.ts       (就是单一入口本身)
//   - src/main/notes/standalone.ts     (scan hot path 特化:块读 + 字节累计
//                                        + 早 abort,比通用入口更严)
//
// 覆盖边界(诚实声明):静态判定只能看出路径**字面**像 .md 的调用。
// 变量名完全不沾 md/note 的直接读(例如 `readFile(join(dir, entry))`,
// entry 来自 readdir)本守卫**看不见** —— 那类代码要靠 code review。
// 守卫的价值是拦住最常见的一手写法:`readFile(join(dir, 'x.md'))`。
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();

/** 唯一允许直接读 body 的文件(相对仓库根) */
const WHITELIST = new Set([
  'src/main/utils/body-cap.ts',
  'src/main/notes/standalone.ts',
]);

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkTs(full));
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** 取出 `name(` 之后的成对括号内容 */
function argsOf(src: string, openIdx: number): string {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return src.slice(openIdx + 1, i);
    }
  }
  return src.slice(openIdx + 1);
}

/** 第一个实参(顶层逗号切分) */
function firstArg(args: string): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) return args.slice(0, i);
  }
  return args;
}

/** 路径参数是否"看起来像" .md / note / markdown */
function looksLikeNoteBody(arg: string): boolean {
  if (/\.md\b/i.test(arg)) return true;
  if (/\b(md|note|notes|markdown)[A-Za-z]*\b/i.test(arg)) return true;
  return false;
}

interface Hit {
  file: string;
  line: number;
  snippet: string;
}

function collectHits(): Hit[] {
  const hits: Hit[] = [];
  for (const file of walkTs(join(ROOT, 'src/main'))) {
    const rel = file.slice(ROOT.length + 1).replaceAll('\\', '/');
    if (WHITELIST.has(rel)) continue;
    const src = readFileSync(file, 'utf8');
    // 只认独立的 readFile( / readFileSync( —— readFileForReader( 不算
    const re = /(?<![A-Za-z0-9_$])readFile(?:Sync)?\s*\(/g;
    for (const m of src.matchAll(re)) {
      const openIdx = m.index! + m[0].lastIndexOf('(');
      const arg = firstArg(argsOf(src, openIdx));
      if (!looksLikeNoteBody(arg)) continue;
      const line = src.slice(0, m.index).split('\n').length;
      hits.push({ file: rel, line, snippet: m[0].trim() + arg.trim().slice(0, 60) });
    }
  }
  return hits;
}

describe('笔记 body 单一入口守卫(r203)', () => {
  it('src/main/** 没有绕开 body-cap 直接读 .md', () => {
    const hits = collectHits();
    const detail = hits.map((h) => `  ${h.file}:${h.line} → ${h.snippet}`).join('\n');
    expect(
      hits,
      `以下位置疑似直接读笔记 body(应改走 utils/body-cap.ts:readBodyWithCap):\n${detail}`,
    ).toEqual([]);
  });

  it('白名单里的两个文件都还在(守卫不能指向不存在的例外)', () => {
    for (const w of WHITELIST) {
      expect(() => statSync(join(ROOT, w)), `白名单文件不存在:${w}`).not.toThrow();
    }
  });

  it('检测器本身能认出「.md 路径」与「无关路径」', () => {
    expect(looksLikeNoteBody("join(dir, 'note.md')")).toBe(true);
    expect(looksLikeNoteBody('notePath')).toBe(true);
    expect(looksLikeNoteBody('markdownFile')).toBe(true);
    expect(looksLikeNoteBody("join(def, 'settings.json')")).toBe(false);
    expect(looksLikeNoteBody('locationPath()')).toBe(false);
  });
});
