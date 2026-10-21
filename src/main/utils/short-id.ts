// 短随机 ID 生成器 — workspace 模块 id 来源
//
// 用 base64url 编码 6 字节随机数(48 bit),得到 8 字符 URL-safe 字符串。
// 碰撞概率:6 字节生日攻击 50% 概率 ≈ 2^24 ≈ 16M 个 id
// 对 favorites 等"单用户、几千条"场景绰绰有余(现存唯一 caller:
// src/main/workspace/favorites.ts 给 group / file entry 派生 id)。
//
// audit 2026-09-08:头注原写 "trash / tasks / recent" —— 三个模块整体
//   下线,实际只剩 favorites。
//
// 不要再用 hex(碰撞概率翻倍)、uuid(太长、太显眼)、Math.random()(非 CSPRNG)
import { randomBytes } from 'crypto';

/** 生成 8 字符 [A-Za-z0-9_-]+ 短 ID */
export function newShortId(): string {
  return randomBytes(6).toString('base64url');
}
