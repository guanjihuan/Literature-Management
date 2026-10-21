// ResourceId 工具函数(audit-r64,2026-10-16)
// 设计来源:resource-model spec §1.2 —— 原文在 docs/superpowers/ 下,已随
// docs 大下线整体删除(541961f),契约现由本文件 + resource-id-contract.test.ts 承载
// (audit-r105:原指针死,改删除注记,同 r76 STORES.md 先例口径)。
// 硬约束:shared 层禁止 Node 内置模块(architecture.md — Vite browser 构建不
// polyfill),本文件保持纯字符串运算。
import type { ResourceId, ResourceKind } from './types';

export const RESOURCE_ID_PREFIX = { note: 'note:', literature: 'lit:' } as const;

/** note id(frontmatter id 或 relPath 的 sha256 截断)→ brand ResourceId */
export function noteResourceId(uuid: string): ResourceId {
  return `${RESOURCE_ID_PREFIX.note}${uuid}` as ResourceId;
}

/**
 * literature 路径 → brand ResourceId。
 *
 * audit-r124 参数语义校正:原 JSDoc 写「relPath(相对所属 root)」是早期设计的
 *   残留名 —— 唯一生产 caller(import.ts 的 `litResourceId(dst)` 复制落盘后的
 *   **绝对路径**)。DB 里确有两套后缀形态并存:本函数产出的新行
 *   'lit:'+absPath-POSIX 化,与 0005 迁移行遗留的 'lit:'+旧 relPath
 *   (literature.ts:51 注释记录了互斥不碰撞的前提)—— 函数本身不区分
 *   相对/绝对,只做分隔符归一。
 * 统一成 POSIX 分隔符,Windows 扫出来的 `foo\bar.pdf` 与 POSIX `foo/bar.pdf`
 * 归一到同一个 id;大小写折叠不归这里管(FS 相关性,由 caller 用
 * isCaseInsensitiveFs 门控,与 deleteStaleCaseRows 历史决策一致)。
 */
export function litResourceId(absPath: string): ResourceId {
  return `${RESOURCE_ID_PREFIX.literature}${absPath.replaceAll('\\', '/')}` as ResourceId;
}

const KNOWN_PREFIXES: ReadonlyMap<string, ResourceKind> = new Map(
  (Object.entries(RESOURCE_ID_PREFIX) as Array<[ResourceKind, string]>).map(([kind, p]) => [
    p,
    kind,
  ]),
);

// audit-r155:shared 层禁止 import main/utils/error(architecture.md — Vite
//   browser 构建不 polyfill),但 parseResourceId 失败时不能裸 throw plain
//   Error —— wrap.ts 把非 AppError 一律 INTERNAL,用户看到通用「内部错误」,
//   实际是上游 caller(DB 脏数据 / 手改 .md 引入了非法 id)传错。挂
//   `code: 'INVALID_RESOURCE_ID'` tag,主进程 caller 可 `instanceof Error
//   && err.code === 'INVALID_RESOURCE_ID'` 识别后重包装成 ValidationError。
export const INVALID_RESOURCE_ID = 'INVALID_RESOURCE_ID' as const;

/**
 * ResourceId → { kind, raw }。无冒号 / 未知 prefix 一律 throw ——
 * 宁可 fail-fast 也不静默把 `foo:bar` 当成 note id(spec §1.4 异常路径)。
 *
 * 失败时抛 Error with `code: INVALID_RESOURCE_ID`(见上注释)。
 */
export function parseResourceId(id: ResourceId): { kind: ResourceKind; raw: string } {
  const i = id.indexOf(':');
  if (i < 0) {
    throw Object.assign(new Error(`bad ResourceId: ${id}`), {
      code: INVALID_RESOURCE_ID,
    });
  }
  const kind = KNOWN_PREFIXES.get(id.slice(0, i + 1));
  if (!kind) {
    throw Object.assign(new Error(`bad ResourceId prefix: ${id}`), {
      code: INVALID_RESOURCE_ID,
    });
  }
  return { kind, raw: id.slice(i + 1) };
}
