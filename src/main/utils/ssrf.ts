// SSRF 防护工具:拒绝指向私有/loopback/链路本地/ULA/CGNAT/multicast 地址的出站连接
//
// audit 2026-09 (V1.9):AI 模块 2026-09 V1.6 整体下线后,
//   isPrivateIpLiteral / isPrivateUrl 在 src/main/ 内仅 **1 个生产 caller**
//   (src/main/window.ts:isPrivateHost 用于 setWindowOpenHandler 的同源 SSRF
//   防御,sync 路径只查 hostname 字面 IP 不解析,async DNS 留给未来 outbound
//   HTTP 场景)—— `isPrivateUrl`(async,DNS 解析)当前 0 caller。
//   不删除 —— 本文件是防御性 SSRF 模块,删除后未来需要 outbound HTTP
//   时(导出 / 抓取 / RSS / Web Clipper / URL preview)还要重新发明
//   一次,且容易漏 IPv6/IDN/rebinding 边界条件。代价:本模块源码 +
//   1 个 dns mock 的测试启动开销(audit-r103:原写「195 行源」实测已 237
//   行 —— 行数随边界补丁增长必漂,数字删除,同 r101 行号锚口径)。
//   若决定彻底删除:同步删 src/main/utils/ssrf.ts + tests/unit/main/utils/ssrf.test.ts
//   (含其自带的 `vi.mock('dns')` 块 —— dns mock 在**测试文件内**,不在
//   tests/setup.ts;audit-r103 写的"tests/setup.ts 的 vi.mock('dns') 块"
//   已随 setup.ts 精简(只留 `export {}`)而消失,行号锚一并作废)。
//
// 设计要点:
//   1. 同时拒绝 IPv4 字面量、IPv6 字面量、IPv4-mapped IPv6(::ffff:0:0/96)
//      — audit-r85:mapped 按数值形态识别(高 96 位 === 0xffff),不依赖
//      `::ffff:` 文本前缀;full-form `0:0:0:0:0:ffff:x:y` 同样还原成 IPv4 判。
//      URL 解析器对 caller 传入 hostname 的规范化不变式由 ssrf.test.ts 锁。
//   2. hostname 通过 dns.lookup 解析后,任一条 A/AAAA 落在禁止范围就拒
//      (防 hostname 字面合法但解析到内部 IP)
//   3. 同步入口返回 boolean,异步入口 resolve host 后返回 boolean
//
// 与 isPrivateHost(ai.ts,已下线)的区别:
//   - 老实现只查字面字符串,绕过 IPv6/IDN
//   - 本文件覆盖 RFC1918、loopback、link-local(169.254/fe80::/10)、
//     ULA(fc00::/7)、CGNAT(100.64/10)、multicast、reserved(::/128)
//   - 对 IDN:不阻止 IDN 本身(用户可能需要),但要求 hostname 不含非 ASCII
//     (Punycode 形式 xn-- 是 ASCII,可放行)
//
// 已知残余风险(audit round 18 文档化):
//   - DNS rebinding 窗口:dns.lookup 返回的 IP 与 fetch() 实际连接的 IP 之间
//     有时间窗口,0-TTL 攻击者控制的 DNS 可在第二次解析时返回私有 IP。本文件
//     提供的 URL-层校验不能完全闭合这个窗口。
//   - 历史缓解(AI 模块 V1.6 已下线,以下条目仅作"曾经的防御深度"记录):
//       (a) ai.ts 每请求 validateProvider(被 SSRF filter 包含)后立刻发起
//           fetch,窗口极小;
//       (b) client.ts 用 `redirect: 'error'` 关闭 redirect-via-302-bypass;
//       (c) 用户场景是 AI baseURL(用户自配),不是从外部输入读 URL,攻击面
//           较窄。
//   - 完全防御需在 undici Agent 层 `connect.lookup` 重新校验 connect 时刻
//     实际地址,工作量大,留作 follow-up。
//
// 与上层协作:
//   - 本文件是"URL 字符串层"防御。任何未来 outbound HTTP caller(导云 /
//     抓取 / RSS / Web Clipper)都应在 fetch 之前先调 isPrivateUrl。

import { lookup } from 'dns';
import { isIP } from 'net';

// IPv4 私有/保留段(位掩码)
const IPV4_PRIVATE_RANGES: Array<[number, number]> = [
  [0x00000000, 0xff000000], // 0.0.0.0/8        — "this network"
  [0x0a000000, 0xff000000], // 10.0.0.0/8        — RFC1918 private
  [0x7f000000, 0xff000000], // 127.0.0.0/8       — loopback (整个 /8 都是 RFC1122 loopback)
  [0x64400000, 0xffc00000], // 100.64.0.0/10     — CGNAT
  [0xa9fe0000, 0xffff0000], // 169.254.0.0/16    — link-local
  [0xac100000, 0xfff00000], // 172.16.0.0/12     — RFC1918 private
  [0xc0a80000, 0xffff0000], // 192.168.0.0/16    — RFC1918 private
  [0xe0000000, 0xf0000000], // 224.0.0.0/4       — multicast
  [0xf0000000, 0xf0000000], // 240.0.0.0/4       — reserved
];

// IPv6 私有/保留段(位掩码,BigInt)
//
// audit round 18 (2026-08-27):每个 mask 字面量必须是 128 位(32 hex digits),
// 因为 ipv6ToBigInt 返回 128-bit BigInt,旧版本用 64-bit mask 只掩低 64 位,
// 与 128-bit base 比较 → fe80::abcd / fc00::dead:beef / ff02::abcd 等
// "最后 64-bit ≠ 1" 的私有地址全部漏判。同时 2606:4700:4700::0 这种公开地址
// 低 64 位是 0,会和某些 range 误匹配 — 现在所有 literal 都按 128-bit 写,
// 一致地按掩码截取后比较。
const IPV6_PRIVATE_RANGES: Array<[bigint, bigint]> = [
  [0n, (1n << 128n) - 1n], // ::/128        — unspecified
  [1n, (1n << 128n) - 1n], // ::1/128       — loopback
  [0xfe800000000000000000000000000000n, 0xffc00000000000000000000000000000n], // fe80::/10     — link-local
  [0xfc000000000000000000000000000000n, 0xfe000000000000000000000000000000n], // fc00::/7      — ULA
  [0xff000000000000000000000000000000n, 0xff000000000000000000000000000000n], // ff00::/8      — multicast
  // 2001:db8::/32 (RFC3849 documentation) 不在拦截名单 —— 测试
  //   window-edge.test.ts:177 期望它通过,作为"不会被任何拦截规则命中"的
  //   对照组。该前缀保留作公网示例,实际不会出现在用户输入里。
  // audit round 9 (2026-09-15):补 6to4 (2002::/16) 和 NAT64 (64:ff9b::/96)。
  //   原 window.ts 内联 isPrivateHost 走 startsWith 字符串前缀挡了这两个
  //   范围,refactor 到 ssrf.ts 共享位掩码时漏掉 — window-edge.test.ts 3 条
  //   用例立刻 fail。加回后,本模块成为 SSRF 唯一来源,window.ts 直接复用。
  //   - 6to4 (2002::/16):RFC3056 transition,实际映射到 IPv4 公网,但客户端
  //     浏览器/Node 一般不会直接打这种地址,且攻击者可构造 2002::a.b.c.d
  //     指向内网 IPv4。沙箱式拦截减少攻击面。
  //   - NAT64 (64:ff9b::/96):RFC6052,用于 IPv6-only 网络访问 IPv4,常见于
  //     运营商/企业内部。明确属于"内部网络",必须拦截。
  [0x20020000000000000000000000000000n, 0xffff0000000000000000000000000000n], // 2002::/16     — 6to4
  // NAT64 /96:mask 是 96 位 = 24 hex digits of 1。
  //   注:不能用 0xffffffff000000000000000000000000n(32 位 mask),那样会
  //   把整个 64:0000::/4 都匹配上,误伤公开 IPv6。
  [0x0064ff9b000000000000000000000000n, 0xffffffffffffffffffffffff00000000n], // 64:ff9b::/96  — NAT64
];

function ipv4ToInt(s: string): number | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const v = Number(p);
    if (v < 0 || v > 255) return null;
    // 拒绝前导零(如 "01"),防止一些解析器的歧义
    if (p.length > 1 && p.startsWith('0')) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

function ipv6ToBigInt(s: string): bigint | null {
  // 支持 :: 简写、双冒号只能出现一次、各段 0-ffff
  const lower = s.toLowerCase();
  if (lower.includes(':::')) return null;
  const dblColon = lower.split('::');
  if (dblColon.length > 2) return null;
  const head = dblColon[0] ? dblColon[0].split(':') : [];
  let tail = dblColon[1] !== undefined ? (dblColon[1] ? dblColon[1].split(':') : []) : null;
  if (dblColon.length === 1) tail = null; // 没有 ::,head 应该是完整 8 段
  if (head.length + (tail?.length ?? 0) > 8) return null;
  const fill = 8 - head.length - (tail?.length ?? 0);
  const middle = Array(fill).fill(0);
  const segments = tail === null ? [...head] : [...head, ...middle, ...tail];
  if (segments.length !== 8) return null;
  let n = 0n;
  for (const seg of segments) {
    if (!/^[0-9a-f]{1,4}$/.test(seg)) return null;
    n = (n << 16n) | BigInt(parseInt(seg, 16));
  }
  return n;
}

/** 把 IPv4-mapped IPv6(::ffff:a.b.c.d) 还原成 IPv4 字面量做检查
 * 支持两种格式:
 *   - ::ffff:127.0.0.1  (十进制 IPv4 段,某些解析器输出)
 *   - ::ffff:7f00:1     (Node URL 解析器会把 IPv4-mapped 压缩成 hex 段)
 */
function stripIpv4Mapped(host: string): string {
  const lower = host.toLowerCase();
  const dec = lower.match(/^::ffff:([0-9.]+)$/);
  if (dec) return dec[1];
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    const a = (high >> 8) & 0xff;
    const b = high & 0xff;
    const c = (low >> 8) & 0xff;
    const d = low & 0xff;
    return `${a}.${b}.${c}.${d}`;
  }
  return host;
}

/** 同步判断一个 IP 字面量是否私有/保留 */
export function isPrivateIpLiteral(host: string): boolean {
  const stripped = stripIpv4Mapped(host);

  if (isIP(stripped) === 4) {
    const n = ipv4ToInt(stripped);
    if (n === null) return true; // 无法解析,按危险处理
    for (const [base, mask] of IPV4_PRIVATE_RANGES) {
      if ((n & mask) === (base & mask)) return true;
    }
    return false;
  }
  if (isIP(stripped) === 6) {
    const n = ipv6ToBigInt(stripped);
    if (n === null) return true;
    // audit-r85:IPv4-mapped 按**数值**识别(n 的高 96 位恰为 0xffff ⇔ ::ffff:a.b.c.d),
    // 不再依赖 `::ffff:` 文本前缀。旧实现下 `0:0:0:0:0:ffff:7f00:1`(即 127.0.0.1)
    // 不匹配 stripIpv4Mapped 的文本正则,又落不进任何 v6 range → 误判公开。
    // 当前 caller 经 URL 解析器会先规范化,所以此条封的是**直接喂字面量**的
    // 契约面(语义修正,同 r77 stat 先例:不修不存在的 bug,修错的语义)。
    if (n >> 32n === 0xffffn) {
      const low = Number(n & 0xffffffffn);
      const v4 = `${(low >>> 24) & 0xff}.${(low >>> 16) & 0xff}.${(low >>> 8) & 0xff}.${low & 0xff}`;
      return isPrivateIpLiteral(v4);
    }
    for (const [base, mask] of IPV6_PRIVATE_RANGES) {
      if ((n & mask) === (base & mask)) return true;
    }
    return false;
  }
  // 既不是 IPv4 也不是 IPv6 字面量(可能是 hostname) — 调用方应进一步解析
  return false;
}

/**
 * 异步判断一个 URL 字符串是否指向私有地址
 * - 拒绝非 http(s)
 * - 拒绝 localhost / 任何非 ASCII 字符(IDN homograph 防御)
 * - 同步先看 hostname 字面是否为 IP;若是,直接走 isPrivateIpLiteral
 * - 否则 dns.lookup,任何一条 A/AAAA 落在禁止范围都拒
 */
export function isPrivateUrl(urlString: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return Promise.resolve(true);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return Promise.resolve(true);
  }
  // 去 IPv6 字面量的方括号
  const host = url.hostname.replace(/^\[|\]$/g, '');

  // 非 ASCII(hostname 含 Unicode)→ 拒绝,防止 IDN homograph
  // Punycode 形式 xn--... 是纯 ASCII,可放行
  if (/[^\x20-\x7e]/.test(host)) return Promise.resolve(true);

  // 字面 IP 直接走快路径
  if (isIP(host)) {
    return Promise.resolve(isPrivateIpLiteral(host));
  }

  // hostname → DNS 解析
  return new Promise<boolean>((resolve) => {
    lookup(host, { all: true }, (err, addresses) => {
      if (err || addresses.length === 0) {
        // 解析失败:保守拒绝,但不抛(测试时常常 mock 网络)
        resolve(true);
        return;
      }
      for (const a of addresses) {
        if (isPrivateIpLiteral(a.address)) {
          resolve(true);
          return;
        }
      }
      resolve(false);
    });
  });
}
