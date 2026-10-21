// tests/unit/main/utils/self-write-echo.test.ts
//
// 守 perf r239「自写回声抑制器」的**契约**(不碰 service,单测纯逻辑):
//
//   1. 打点后、同指纹 ⇒ 命中(自写回声,抑制重扫)。
//   2. 指纹不同 ⇒ 不命中(文件被别人动过 ⇒ 外部改动必须可见)。
//      —— 这条是**时间窗口实现的老洞**:窗口内的外部改动会被一起吞掉。
//   3. 记录**不被消费**:同一份指纹要能反复命中(应用连续 autosave 时
//      指纹会被新的写入覆盖,不会互相干扰)。
//   4. TTL 之外 ⇒ 不命中(平台丢事件 / 回声迟到太久 ⇒ 宁可多重扫,
//      不可漏扫)。
//   5. 路径大小写 / 分隔符差异 ⇒ 同一把钥匙(win32 不区分大小写)。
//   6. 过期打点不会永久占位(map 会自清理)。
import { describe, expect, it } from 'vitest';
import {
  SelfWriteEchoSuppressor,
  sameFingerprint,
} from '../../../../src/main/utils/self-write-echo';
import type { FileFingerprint } from '../../../../src/main/utils/self-write-echo';
import { isCaseInsensitiveFs } from '../../../../src/main/utils/platform';

const fp = (over: Partial<FileFingerprint> = {}): FileFingerprint => ({
  mtimeMs: 1000,
  size: 200,
  ino: 7,
  ...over,
});

describe('SelfWriteEchoSuppressor(r239)', () => {
  it('同指纹 ⇒ 命中自写回声', () => {
    const s = new SelfWriteEchoSuppressor(30_000);
    s.mark('C:/lib/a.md', fp(), 0);
    expect(s.isSelfEcho('C:/lib/a.md', fp(), 100)).toBe(true);
  });

  it('指纹不同 ⇒ 不命中(外部改动必须可见)', () => {
    const s = new SelfWriteEchoSuppressor(30_000);
    s.mark('C:/lib/a.md', fp(), 0);
    // 外部工具改过 ⇒ mtime 变 / size 变 / inode 变,任一不同即不命中
    expect(s.isSelfEcho('C:/lib/a.md', fp({ mtimeMs: 2000 }), 100)).toBe(false);
    expect(s.isSelfEcho('C:/lib/a.md', fp({ size: 201 }), 100)).toBe(false);
    expect(s.isSelfEcho('C:/lib/a.md', fp({ ino: 8 }), 100)).toBe(false);
  });

  it('记录不被消费:同一份指纹反复命中', () => {
    const s = new SelfWriteEchoSuppressor(30_000);
    s.mark('C:/lib/a.md', fp(), 0);
    expect(s.isSelfEcho('C:/lib/a.md', fp(), 100)).toBe(true);
    expect(s.isSelfEcho('C:/lib/a.md', fp(), 200)).toBe(true);
  });

  it('TTL 之外不命中(回声迟到太久 / 平台丢事件)', () => {
    const s = new SelfWriteEchoSuppressor(30_000);
    s.mark('C:/lib/a.md', fp(), 0);
    expect(s.isSelfEcho('C:/lib/a.md', fp(), 30_001)).toBe(false);
  });

  it('没打点过的路径不命中', () => {
    const s = new SelfWriteEchoSuppressor(30_000);
    expect(s.isSelfEcho('C:/lib/never-written.md', fp(), 10)).toBe(false);
  });

  it('分隔符风格差异视为同一把钥匙', () => {
    const s = new SelfWriteEchoSuppressor(30_000);
    s.mark('C:\\lib\\a.md', fp(), 0);
    expect(s.isSelfEcho('C:/lib/a.md', fp(), 10)).toBe(true);
  });

  it('大小写不敏感文件系统上大小写差异也算同一把钥匙', () => {
    const s = new SelfWriteEchoSuppressor(30_000);
    s.mark('C:\\lib\\a.md', fp(), 0);
    // 大小写折叠只发生在 case-insensitive FS 上(win32 / macOS APFS);
    // POSIX 上大小写是路径语义的一部分 ⇒ 不能折叠。
    const same = isCaseInsensitiveFs
      ? s.isSelfEcho('C:/LIB/A.md', fp(), 10)
      : !s.isSelfEcho('C:/LIB/A.md', fp(), 10);
    expect(same).toBe(true);
  });

  it('过期打点被清掉,不会永久占位', () => {
    const s = new SelfWriteEchoSuppressor(30_000);
    s.mark('C:/lib/a.md', fp(), 0);
    expect(s.size).toBe(1);
    // 之后的 mark 会顺手 prune 掉过期的
    s.mark('C:/lib/b.md', fp(), 50_000);
    expect(s.size).toBe(1);
    expect(s.isSelfEcho('C:/lib/b.md', fp(), 50_100)).toBe(true);
  });

  it('sameFingerprint:三因子全等才算同一份内容', () => {
    expect(sameFingerprint(fp(), fp())).toBe(true);
    expect(sameFingerprint(fp(), fp({ mtimeMs: 1 }))).toBe(false);
    expect(sameFingerprint(fp(), fp({ size: 1 }))).toBe(false);
    expect(sameFingerprint(fp(), fp({ ino: 1 }))).toBe(false);
  });
});
