// tests/unit/main/lint/no-fixed-temp-dir.test.ts
//
// 守「测试的临时目录必须每次跑测唯一」这条约定(r209)。
//
// ── 被守卫的缺陷(不是风格问题,是并发跑测时的假红)────────────────────
//   约定:临时目录用 `fs.mkdtemp(join(tmpdir(), 'prefix-'))` —— 名字带
//   随机后缀,每次跑测唯一。仓库里 34 处测试都这么写。
//
//   偏离:少数几个测试文件用**固定**目录名 + 递归删:
//     const TMP = join(tmpdir(), 'rkms-r205');
//     beforeEach(async () => { await fs.rm(TMP, { recursive: true, force: true }); … })
//
//   后果:两次**并发**的跑测(CI 分片 / watch 模式重跑 / 两个 checkout 同时
//   跑 / 一条命令跑全量 + 另一条命令单跑某个文件)会用**同一个**目录,
//   于是一个进程的 `fs.rm -rf` 把另一个进程**正在用**的目录树删掉 ⇒
//   一片 ENOENT / ENOTEMPTY 假红,而两个测试**单跑都是绿的**。
//
//   实测(2026-10-20,真机):一条命令跑全量(81 文件)、另一条并行单跑
//   rkms-r205 那个文件 ⇒ 该文件 4 例红:
//     ENOENT: chmod '…\rkms-r205\default\notes'   (fs.cp 刚建好的目录没了)
//     ENOENT: scandir '…\rkms-r205\current'
//     ENOENT: mkdir '…\rkms-r205\current'
//     ENOTEMPTY: rmdir '…\rkms-r205\default'
//   两条命令**各自单跑**都 7/7 绿 ⇒ 竞争,不是被测代码的缺陷。
//   这类假红最贵:它看起来像「代码被改坏了」,会让人去改**没错**的产品代码。
//
// ── 判定方式 ───────────────────────────────────────────────────────
//   静态扫 tests/**:凡是 `join(tmpdir(), '<字面量>')` 形式的**固定**路径,
//   必须紧跟在 `mkdtemp(` 之后(即由 mkdtemp 生成唯一名)。
//   - `mkdtemp(join(tmpdir(), 'rkms-x-'))`  → 放行
//   - `join(tmpdir(), 'rkms-x')`            → 违规(固定名)
//
//   覆盖边界(诚实声明):静态判定只认**字面量**路径。写成
//   `join(tmpdir(), \`rkms-${Date.now()}\`)` 的动态名**放行**(它每次都不同),
//   但那种写法不是原子唯一的 —— 两个进程在同一毫秒起跑仍可能撞名,
//   所以约定仍然是 mkdtemp。
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const TESTS_DIR = join(ROOT, 'tests');

/**
 * 本守卫自己 exempt:它的源码里必然出现「固定 tmpdir 路径」的字面写法
 * (注释与正则),扫到自己会误报。
 */
const SELF = 'tests/unit/main/lint/no-fixed-temp-dir.test.ts';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** `join(tmpdir(), '…')` / `join(os.tmpdir(), '…')` 里的字面量参数 */
const FIXED_TMP_PATH_RE = /join\(\s*(?:os\.)?tmpdir\(\)\s*,\s*(['"`])([^'"`]*)\1\s*\)/g;

interface Violation {
  file: string;
  line: number;
  snippet: string;
}

function scanFile(abs: string): Violation[] {
  const src = readFileSync(abs, 'utf-8');
  const rel = abs.slice(ROOT.length + 1).split('\\').join('/');
  if (rel === SELF) return [];

  const out: Violation[] = [];
  for (const m of src.matchAll(FIXED_TMP_PATH_RE)) {
    const literal = m[2] ?? '';
    // 动态名(带插值)每次都不同 —— 放行(但约定上仍该用 mkdtemp)
    if (literal.includes('${')) continue;
    const before = src.slice(0, m.index);
    // 紧跟在 mkdtemp( 之后 ⇒ 由 mkdtemp 生成唯一名 ⇒ 放行
    if (/mkdtemp\(\s*$/.test(before)) continue;
    const line = src.slice(0, m.index).split('\n').length;
    out.push({ file: rel, line, snippet: m[0].replace(/\s+/g, ' ') });
  }
  return out;
}

describe('临时目录必须每次跑测唯一(静态守卫)', () => {
  it('tests/ 下不得出现固定的 tmpdir 路径(必须是 mkdtemp)', () => {
    const violations = walk(TESTS_DIR).flatMap(scanFile);

    expect(
      violations,
      violations.length > 0
        ? `固定临时目录名会让并发的两轮跑测互删对方的目录树(实测假红):\n` +
          violations.map((v) => `  ${v.file}:${v.line}  ${v.snippet}`).join('\n') +
          `\n改法:const TMP = await fs.mkdtemp(join(tmpdir(), 'rkms-xxx-'));`
        : '',
    ).toEqual([]);
  });

  it('守卫本身是有效的(拿一个已知的违规写法做对照)', () => {
    const fake = [
      "const TMP = join(tmpdir(), 'rkms-fake');",
      "const OK = await fs.mkdtemp(join(tmpdir(), 'rkms-fake-'));",
      "const ALSO_OK = join(tmpdir(), `rkms-${Date.now()}`);",
    ].join('\n');
    const src = fake;
    const hits: string[] = [];
    for (const m of src.matchAll(FIXED_TMP_PATH_RE)) {
      const literal = m[2] ?? '';
      if (literal.includes('${')) continue;
      const before = src.slice(0, m.index);
      if (/mkdtemp\(\s*$/.test(before)) continue;
      hits.push(m[0]);
    }
    // 第一条(固定名)被抓到,后两条(mkdtemp / 动态名)放行
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain('rkms-fake');
  });
});
