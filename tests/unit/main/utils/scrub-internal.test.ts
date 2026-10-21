// tests/unit/main/utils/scrub-internal.test.ts
//
// 守 scrubInternal 的**脱敏**契约(2026-10-20,r201):
//
//   把 INTERNAL 错误消息里的用户家目录替换成 <rootPath> 占位符。
//
// 为什么这是隐私面:IPC 错误消息会被结构化日志全量记录(以及任何抓 IPC
// 错误日志的 telemetry 渠道)。fs 抛错原文含 `failed at
// C:\Users\foo\ResearchHub\notes\x.md` ⇒ 家目录一路泄到 renderer / 日志。
//
// 本文件锁住:
//   1. root 全路径被替换成 <rootPath>(后面必须跟分隔符或字符串结尾 ——
//      `ResearchHubX\y` 不是 `ResearchHub` 的子目录,不能误伤);
//   2. 大小写不敏感文件系统(win32/darwin)上大小写变体同样脱敏;
//   3. root 带尾分隔符(盘根 `C:\`)时也能正确脱敏(r124 修的静默失效);
//   4. 正则元字符(root 里有 `+` `[` `(` 等)被正确转义;
//   5. 超过 500 字符截断(防单条消息炸 IPC buffer);
//   6. rootPath 未初始化 → 原样返回(不阻断错误上报);
import { describe, expect, it, vi } from 'vitest';

import { isCaseInsensitiveFs } from '../../../../src/main/utils/platform';

const ROOT = 'C:\\Users\\foo\\ResearchHub';

/** 盘根(`C:\`)/POSIX 根(`/`)两条语义都依赖 platform,分别用 skipIf 隔离 */
const isWin = process.platform === 'win32';

/** 加载一份全新的模块实例(safe-write 的 rootPath 是 module 级单例) */
async function load(root?: string): Promise<(msg: string) => string> {
  vi.resetModules();
  if (root !== undefined) {
    const { setRootPath } = await import('../../../../src/main/utils/safe-write');
    setRootPath(root);
  }
  const { scrubInternal } = await import('../../../../src/main/utils/scrub-internal');
  return scrubInternal;
}

describe('scrubInternal — 家目录脱敏(r201)', () => {
  it('root 全路径 → <rootPath> 占位符', async () => {
    const scrub = await load(ROOT);
    const out = scrub(`failed at ${ROOT}\\notes\\x.md`);
    expect(out).toBe('failed at <rootPath>\\notes\\x.md');
    expect(out).not.toContain('Users');
  });

  it('root 出现在字符串结尾 → 同样替换', async () => {
    const scrub = await load(ROOT);
    expect(scrub(`path is ${ROOT}`)).toBe('path is <rootPath>');
  });

  it('仅是前缀相同的兄弟目录(ResearchHubX)→ 不误伤', async () => {
    const scrub = await load(ROOT);
    const out = scrub(`failed at ${ROOT}X\\y.md`);
    expect(out).toContain('ResearchHubX');
    expect(out).not.toContain('<rootPath>');
  });

  it('与 root 无关的路径 → 原样保留', async () => {
    const scrub = await load(ROOT);
    const msg = 'failed at D:\\other\\place\\y.md';
    expect(scrub(msg)).toBe(msg);
  });

  it.skipIf(!isCaseInsensitiveFs)(
    '大小写不敏感 FS(win32/darwin):大小写变体同样脱敏',
    async () => {
      const scrub = await load(ROOT);
      const out = scrub('failed at c:\\users\\FOO\\researchhub\\notes\\x.md');
      expect(out).toBe('failed at <rootPath>\\notes\\x.md');
    },
  );

  it.skipIf(isCaseInsensitiveFs || isWin)('大小写敏感 FS(POSIX):大小写变体不脱敏', async () => {
    const scrub = await load('/srv/data');
    const out = scrub('failed at /SRV/DATA/x.md');
    expect(out).toBe('failed at /SRV/DATA/x.md');
  });

  it.skipIf(!isWin)('root 带尾分隔符(盘根 C:\\)→ 盘内路径仍被脱敏(r124)', async () => {
    const scrub = await load('C:\\');
    const out = scrub('failed at C:\\Users\\foo\\ResearchHub\\notes\\x.md');
    expect(out).toBe('failed at <rootPath>\\Users\\foo\\ResearchHub\\notes\\x.md');
    expect(out).not.toContain('C:\\Users');
  });

  it.skipIf(isWin)('root 长度 < 2(POSIX 根 /)→ 保守跳过,整条消息原样', async () => {
    const scrub = await load('/');
    const msg = 'failed at /srv/data/x.md';
    expect(scrub(msg)).toBe(msg);
  });

  it('root 含正则元字符 → 被正确转义(不误伤、不漏伤)', async () => {
    const weird = 'C:\\a+b[test]\\root';
    const scrub = await load(weird);
    const out = scrub(`failed at ${weird}\\notes\\x.md`);
    expect(out).toBe('failed at <rootPath>\\notes\\x.md');
  });

  it('超长消息 → 截断到 500 字符 + 省略号(防炸 IPC buffer)', async () => {
    const scrub = await load(ROOT);
    const long = 'x'.repeat(600);
    const out = scrub(long);
    expect(out).toHaveLength(501);
    expect(out.endsWith('…')).toBe(true);
  });

  it('rootPath 未初始化 → 原样返回(不阻断错误上报)', async () => {
    const scrub = await load();
    const msg = 'failed at C:\\Users\\foo\\secret\\x.md';
    expect(scrub(msg)).toBe(msg);
  });
});
