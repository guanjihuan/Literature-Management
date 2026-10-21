// tests/unit/main/lint/stale-test-reference.test.ts
//
// 守卫(r180):源码注释里引用的**测试文件路径必须真实存在**,否则要么
// 明确标注为「守卫缺失」。
//
// 为什么需要这条:2026-10-19 的 docs 大下线把整棵 tests/ 目录删掉了
// (CHANGELOG 记录曾达 2501 例),但源码注释里 45 处「行为锁:xxx.test.ts」
// 的指针还指着已经不存在的文件。后果不是编译错误,而是**更坏的**:
//   - 后来的人 grep 那个测试名 → 找不到 → 以为「这行为没被测过」→
//     重写一遍(白干),或者
//   - 以为「有测试兜着」→ 不写测试就改行为 → 回归无人拦。
// 注释里的测试指针是**契约的一部分**,指针死了必须显式说「死了」。
//
// 约定:引用一个已不存在的测试文件时,同一行必须带 🔒 标记。
// 现状:45 处已按约定标注(逐条改成 `路径 🔒(守卫缺失)`)。
// 这条测试只拦**未标注**的死指针 —— 标注过的允许存在(它们是历史记录,
// 补回测试时把 🔒 去掉即可,这条测试会继续守着)。
//
// audit-r203 补上**反向**方向:🔒 标记会**过期** —— 守卫测试补齐后,
// 源码里的 `路径 🔒(守卫缺失)` 就不再成立,读者仍会以为「这块没测试兜着」
// 而重复造轮子(或反过来,以为「🔒 = 有问题」而不敢动)。约定是
// 「补回测试就把 🔒 去掉」,那就让机器来查有没有人忘了去掉。
import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const MARKER = '🔒';

// 只在源码目录里扫(测试文件之间互相引用少见,且会让本文件自指)。
const SCAN_DIRS = ['src'];

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkTs(full));
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

// 匹配注释 / 字符串里出现的「测试文件路径」字面量。
// 写成拼接形式,避免本文件自身被自己的正则命中。
const TEST_PATH_RE = new RegExp('tests[/\\\\][A-Za-z0-9_\\\\/-]+?\\.test\\.tsx?', 'g');

interface Violation {
  file: string;
  line: number;
  target: string;
  text: string;
}

/** 取出该行引用的全部测试路径(去重) */
function targetsIn(text: string): string[] {
  TEST_PATH_RE.lastIndex = 0;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = TEST_PATH_RE.exec(text)) !== null) {
    const t = m[0].replaceAll('\\', '/');
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

function collectViolations(): Violation[] {
  const violations: Violation[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walkTs(join(ROOT, dir))) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((text, i) => {
        TEST_PATH_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = TEST_PATH_RE.exec(text)) !== null) {
          const target = m[0].replaceAll('\\', '/');
          if (existsSync(join(ROOT, target))) continue;
          if (text.includes(MARKER)) continue; // 已显式标注「守卫缺失」
          violations.push({
            file: file.slice(ROOT.length + 1),
            line: i + 1,
            target,
            text: text.trim().slice(0, 120),
          });
        }
      });
    }
  }
  return violations;
}

/**
 * 收集**过期**的 🔒 标记:某行带 🔒,且它引用的测试文件**全部**都已存在
 * ⇒ 这条 🔒 已经过期,应当去掉。
 *
 * 判据用「全部存在」而不是「任一存在」:一行里可能同时引用多个测试
 * (有的存在、有的仍缺),此时 🔒 仍然必要(还指着缺失的那个)。
 */
function collectStaleMarkers(): Violation[] {
  const violations: Violation[] = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walkTs(join(ROOT, dir))) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((text, i) => {
        if (!text.includes(MARKER)) return;
        const targets = targetsIn(text);
        if (targets.length === 0) return;
        if (!targets.every((t) => existsSync(join(ROOT, t)))) return;
        violations.push({
          file: file.slice(ROOT.length + 1),
          line: i + 1,
          target: targets.join(', '),
          text: text.trim().slice(0, 120),
        });
      });
    }
  }
  return violations;
}

describe('源码注释里的测试指针(r180)', () => {
  it('引用的测试文件必须存在,或已在同一行标注 🔒 守卫缺失', () => {
    const violations = collectViolations();
    const detail = violations
      .map((v) => `  ${v.file}:${v.line} → ${v.target}\n      ${v.text}`)
      .join('\n');
    expect(
      violations,
      `以下注释引用了不存在的测试文件,且没有 🔒(守卫缺失)标注:\n${detail}`,
    ).toEqual([]);
  });

  it('扫描器本身能认出「已标注」与「未标注」两种状态', () => {
    // 探针:确认正则与标注约定真的生效(否则上面那条可能因为正则失配而空过)
    const sample = [
      '// 行为锁:tests/unit/definitely/absent.test.ts',
      '// 行为锁:tests/unit/definitely/absent.test.ts 🔒(守卫缺失)',
    ];
    const hits = sample.filter((line) => {
      TEST_PATH_RE.lastIndex = 0;
      const m = TEST_PATH_RE.exec(line);
      return m !== null && !line.includes(MARKER);
    });
    expect(hits).toHaveLength(1);
  });
});

describe('🔒(守卫缺失)标记的时效性(r203)', () => {
  it('守卫测试已补齐的行,不许还留着 🔒 标记', () => {
    const stale = collectStaleMarkers();
    const detail = stale.map((v) => `  ${v.file}:${v.line} → ${v.target}\n      ${v.text}`).join('\n');
    expect(
      stale,
      `以下行的测试已存在,🔒(守卫缺失)标记已过期,请去掉:\n${detail}`,
    ).toEqual([]);
  });

  it('扫描器能区分「过期标记」与「仍然有效的标记」', () => {
    // 探针:一个引用真实存在文件的 🔒 行 → 过期;一个引用不存在文件的 🔒
    // 行 → 仍然有效。两条判据都跑一遍,防止上面那条因为逻辑写反而空过。
    const realFile = 'tests/unit/main/lint/stale-test-reference.test.ts';
    const absentFile = 'tests/unit/definitely/absent.test.ts';
    const realTargets = targetsIn(`// ${realFile} ${MARKER}`);
    const absentTargets = targetsIn(`// ${absentFile} ${MARKER}`);
    expect(realTargets).toEqual([realFile]);
    expect(existsSync(join(ROOT, realTargets[0]))).toBe(true);
    expect(existsSync(join(ROOT, absentTargets[0]))).toBe(false);
  });
});
