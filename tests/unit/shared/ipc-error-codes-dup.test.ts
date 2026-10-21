// tests/unit/shared/ipc-error-codes-dup.test.ts
//
// 守 IPC 错误码 union 的两条不变式(2026-10-20,r201):
//
//   1. IPC_ERROR_CODES 里**没有重复元素**。
//      历史事故(r35/r37):同一个 'CONFLICT' 被补了两次。Set 去重让运行时
//      无影响,但未来删/改其中一个时,漏改的那处会让 wrap.ts 的
//      "code ∈ union?" 判定走 INTERNAL 兜底 ⇒ 具体的冲突提示退化成
//      泛化的 "internal error"。
//
//   2. src/ 里**每一个** `new AppError('X'` / `new LibraryError('X'`
//      的字面量 code 都必须落在 union 内。
//      为什么这条要单独锁:AppError 的 code 参数是 `string`(向后兼容),
//      TS **不会**报错;而 wrap.ts 在出口处发现 code 不在 union 里会
//      fallback 成 INTERNAL **并擦掉 message** ⇒ 用户看到的是
//      "internal error",而真正的原因(比如 'NOT_READY'、'EOPEN')被吞掉。
//      这类 bug 只有 runtime 断言能拦。
//
// 另附:isIpcErrorCode 的运行时行为(union 内 / union 外)。
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

import { IPC_ERROR_CODES, isIpcErrorCode } from '../../../src/shared/types';

const ROOT = process.cwd();

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkTs(full));
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

describe('IPC_ERROR_CODES — 单一真相源(r201)', () => {
  it('tuple 元素互不重复(r35/r37 事故回归锁)', () => {
    const seen = new Set<string>();
    const dups = IPC_ERROR_CODES.filter((c) => {
      if (seen.has(c)) return true;
      seen.add(c);
      return false;
    });
    expect(dups, `IPC_ERROR_CODES 里有重复元素: ${dups.join(', ')}`).toEqual([]);
  });

  it('每个 code 都是非空大写 snake 串', () => {
    for (const c of IPC_ERROR_CODES) {
      expect(c, `code 不合法: ${c}`).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  it('isIpcErrorCode:union 内 → true,union 外 → false', () => {
    for (const c of IPC_ERROR_CODES) {
      expect(isIpcErrorCode(c), c).toBe(true);
    }
    expect(isIpcErrorCode('DUPLICATE_NAMES')).toBe(false);
    expect(isIpcErrorCode('NOT_A_REAL_CODE')).toBe(false);
    expect(isIpcErrorCode('')).toBe(false);
  });

  it('src/ 里每个 AppError/LibraryError 字面量 code 都在 union 内', () => {
    const union = new Set<string>(IPC_ERROR_CODES);
    const bad: string[] = [];
    const re = /new\s+(?:AppError|LibraryError)\(\s*'([A-Z][A-Z0-9_]*)'/g;
    for (const file of walkTs(join(ROOT, 'src'))) {
      const src = readFileSync(file, 'utf8');
      const rel = file.slice(ROOT.length + 1).replaceAll('\\', '/');
      for (const m of src.matchAll(re)) {
        if (!union.has(m[1])) bad.push(`${rel} → '${m[1]}'`);
      }
    }
    expect(
      bad,
      `以下 code 不在 IPC_ERROR_CODES 里 —— wrap.ts 会 fallback INTERNAL 并擦掉 message:\n${bad.join(
        '\n',
      )}`,
    ).toEqual([]);
  });
});
