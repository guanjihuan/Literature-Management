// tests/unit/main/utils/ssrf.test.ts
//
// 守 SSRF 防护的**范围判定**契约(2026-10-20,r201):
//
//   isPrivateIpLiteral(host) : 同步,判字面 IP 是否落在禁止段
//   isPrivateUrl(urlString)  : 异步,判整个 URL 是否指向禁止地址
//
// 这份文件是主进程唯一的出站地址白名单(当前 caller:window.ts 的
// setWindowOpenHandler 同源防御)。判错的方向是"把公网当内网拦掉"
//(误伤)或"把内网当公网放行"(SSRF)—— 两个方向都要锁。
//
// 覆盖的段位(源码 IPV4_PRIVATE_RANGES / IPV6_PRIVATE_RANGES 的语义):
//   IPv4 : 0/8 10/8 127/8 100.64/10 169.254/16 172.16/12 192.168/16
//          224/4(multicast) 240/4(reserved)
//   IPv6 : ::/128 ::1/128 fe80::/10 fc00::/7 ff00::/8 2002::/16(6to4)
//          64:ff9b::/96(NAT64)
//   IPv4-mapped IPv6(::ffff:a.b.c.d)按**数值**识别(r85),不依赖文本前缀。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));

vi.mock('dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('dns')>();
  return { ...actual, lookup: lookupMock };
});

import { isPrivateIpLiteral, isPrivateUrl } from '../../../../src/main/utils/ssrf';

/** 让 mock 的 dns.lookup 回调返回给定的地址列表 */
function resolveTo(...addresses: string[]): void {
  lookupMock.mockImplementation(
    (_host: string, _opts: unknown, cb: (err: unknown, addrs: unknown[]) => void) => {
      cb(null, addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
    },
  );
}

describe('isPrivateIpLiteral — IPv4 段位(r201)', () => {
  it('RFC1918 / loopback / CGNAT / link-local / multicast / reserved 全拦', () => {
    for (const ip of [
      '0.0.0.0',
      '10.0.0.1',
      '127.0.0.1',
      '127.1.2.3',
      '100.64.0.1',
      '169.254.1.1',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '224.0.0.1',
      '240.0.0.1',
    ]) {
      expect(isPrivateIpLiteral(ip), ip).toBe(true);
    }
  });

  it('公网地址放行', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '172.15.255.255', '100.128.0.1', '223.255.255.255']) {
      expect(isPrivateIpLiteral(ip), ip).toBe(false);
    }
  });

  it('非 IP 字面量(hostname)→ false,交由调用方进一步解析', () => {
    expect(isPrivateIpLiteral('example.com')).toBe(false);
    expect(isPrivateIpLiteral('localhost')).toBe(false);
  });
});

describe('isPrivateIpLiteral — IPv6 段位(r201)', () => {
  it('loopback / unspecified / link-local / ULA / multicast / 6to4 / NAT64 全拦', () => {
    for (const ip of [
      '::',
      '::1',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
      'ff02::1',
      '2002::1',
      '64:ff9b::1',
    ]) {
      expect(isPrivateIpLiteral(ip), ip).toBe(true);
    }
  });

  it('公网 IPv6 放行', () => {
    expect(isPrivateIpLiteral('2606:4700:4700::1')).toBe(false);
    expect(isPrivateIpLiteral('2001:db8::1')).toBe(false);
  });

  it('IPv4-mapped IPv6 按数值识别(r85):三种写法都拦', () => {
    expect(isPrivateIpLiteral('::ffff:127.0.0.1')).toBe(true);
    expect(isPrivateIpLiteral('::ffff:7f00:1')).toBe(true);
    expect(isPrivateIpLiteral('0:0:0:0:0:ffff:7f00:1')).toBe(true);
  });

  it('IPv4-mapped 公网地址放行', () => {
    expect(isPrivateIpLiteral('::ffff:8.8.8.8')).toBe(false);
  });
});

describe('isPrivateUrl — URL 层(r201)', () => {
  beforeEach(() => {
    lookupMock.mockReset();
    resolveTo('93.184.216.34');
  });

  it('非 http(s) 协议 → 拒', async () => {
    await expect(isPrivateUrl('file:///C:/Windows/System32')).resolves.toBe(true);
    await expect(isPrivateUrl('ftp://example.com/x')).resolves.toBe(true);
  });

  it('非法 URL → 拒(不抛)', async () => {
    await expect(isPrivateUrl('not a url')).resolves.toBe(true);
  });

  it('host 是私有 IP 字面量 → 拒(不走 DNS)', async () => {
    await expect(isPrivateUrl('http://127.0.0.1:8080/x')).resolves.toBe(true);
    await expect(isPrivateUrl('http://[::1]/x')).resolves.toBe(true);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('host 是公网 IP 字面量 → 放行', async () => {
    await expect(isPrivateUrl('https://8.8.8.8/x')).resolves.toBe(false);
  });

  it('hostname 解析到内网 IP → 拒(防"字面合法、解析到内网")', async () => {
    resolveTo('93.184.216.34', '10.0.0.5');
    await expect(isPrivateUrl('https://sneaky.example.com/x')).resolves.toBe(true);
  });

  it('hostname 全部解析到公网 → 放行', async () => {
    resolveTo('93.184.216.34');
    await expect(isPrivateUrl('https://example.com/x')).resolves.toBe(false);
  });

  it('DNS 解析失败 → 保守拒(不抛)', async () => {
    lookupMock.mockImplementation(
      (_host: string, _opts: unknown, cb: (err: unknown, addrs: unknown[]) => void) => {
        cb(new Error('ENOTFOUND'), []);
      },
    );
    await expect(isPrivateUrl('https://example.com/x')).resolves.toBe(true);
  });

  it('IDN 域名:URL 解析器已转 punycode(纯 ASCII)→ 走 DNS 判定', async () => {
    // 源码注释说「拒绝非 ASCII hostname」,但 URL 的 hostname 一定是
    // punycode 形式(ASCII)—— 该分支对 URL 入参实际不可达。此处锁住
    // **真实行为**(punycode 放行),避免有人以为 IDN 会被拦而误改。
    await expect(isPrivateUrl('https://例え.jp/x')).resolves.toBe(false);
  });
});
