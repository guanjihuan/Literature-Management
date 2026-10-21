// src/renderer/src/lib/folder-dnd.ts
//
// 侧栏内部拖拽(HTML5 DnD)的载荷协议。
//   r161+ disk-folder:「把行拖进文件夹 / 面包屑」= 真实 fs.rename,不再
//   走 DB 列更新;items 仍按 id 列表传(资源 id 跨目录 rename 时会变,
//   接收端按新 id 重算),folder 用 relPath 定位(物理目录即真相)。
//   「OS 文件拖入」('Files')与本 MIME 通道刻意不同型 —— NotesList /
//   LiteratureList 的导入覆盖层 gate 都只看 types.includes('Files'),
//   内部 drag 天然不触发导入 overlay,两侧零改动互不串台。
//
// 安全纪律:renderer → renderer 自产自销,但 payload 依然过白名单解析
// (JSON.parse + 形状校验),不 `as` 糊弄 —— DevTools 手改 dataTransfer
// 也要能挡住。
import type { ResourceKind } from '@shared/types';

export const RKMS_MOVE_MIME = 'application/x-rkms-move';

export interface InternalMovePayload {
  /** items = 资源行批量(剪切粘贴/拖入),folder = 单个文件夹移动。 */
  type: 'items' | 'folder';
  /** 所属 kind 树;跨 kind 落到别的树的面包屑/根上直接忽略。 */
  kind: ResourceKind;
  /**
   * items:资源 id 列表;folder:单元素占位(= relPaths[0],即被搬目录的
   *   relPath)。**不能是空数组** —— readMovePayload 要求 ids 非空且每项
   *   非空串,folder 载荷若写 ids: [] 会在读端被整条拒收(这正是 r173
   *   之前「文件夹拖拽完全无效」的原因:写端写 ids: [],读端拒收)。
   */
  ids: string[];
  /** folder:单 relPath 字符串;items:空数组。两者互斥。 */
  relPaths: string[];
}

export function writeMovePayload(dt: DataTransfer, payload: InternalMovePayload): void {
  try {
    dt.setData(RKMS_MOVE_MIME, JSON.stringify(payload));
  } catch (err: unknown) {
    // 极少数环境 dataTransfer 锁定(异步 drop 后调用);吞掉,拖拽自然失败
    void err;
  }
  dt.effectAllowed = 'move';
}

export function hasMovePayload(dt: DataTransfer): boolean {
  return Array.from(dt.types).includes(RKMS_MOVE_MIME);
}

/** drop 时读取;形状不符(注入 / 旧版本残留)返回 null,调用方静默忽略。 */
export function readMovePayload(dt: DataTransfer): InternalMovePayload | null {
  try {
    const raw = dt.getData(RKMS_MOVE_MIME);
    if (!raw) return null;
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object') return null;
    const p = v as Partial<InternalMovePayload>;
    if (p.type !== 'items' && p.type !== 'folder') return null;
    if (p.kind !== 'note' && p.kind !== 'literature') return null;
    if (!Array.isArray(p.ids) || p.ids.length === 0 || p.ids.length > 2000) return null;
    if (!p.ids.every((x) => typeof x === 'string' && x.length > 0)) return null;
    if (!Array.isArray(p.relPaths)) return null;
    if (!p.relPaths.every((x) => typeof x === 'string')) return null;
    // 互斥:items 时 relPaths 必须空数组;folder 时 ids 只占 1 位
    if (p.type === 'items' && p.relPaths.length !== 0) return null;
    if (p.type === 'folder' && p.relPaths.length !== 1) return null;
    // folder:ids 占位必须与 relPaths[0] 一致(两者都是被搬目录的 relPath)——
    //   防止手改 dataTransfer 让读端拿到自相矛盾的载荷。
    if (p.type === 'folder' && (p.ids.length !== 1 || p.ids[0] !== p.relPaths[0])) {
      return null;
    }
    return {
      type: p.type,
      kind: p.kind,
      ids: p.ids as string[],
      relPaths: p.relPaths as string[],
    };
  } catch {
    return null;
  }
}

// audit-r143 (2026-10-19):侧栏文件拖拽自定义排序 —— 与 move MIME 并存,
//   同源防御(JSON.parse + 形状白名单)。两 MIME 由 caller 按场景区分,
//   不在 payload 内互斥(各自走自己的 write*/has*/read* 三件套)。
export const RKMS_REORDER_MIME = 'application/x-rkms-reorder';

// audit-r143:reorder payload —— 当前只拖一个文件到两个 row 之间,
//   落点侧 row id 由 `targetId` 承载,`before` 标志位决定插入位置(行上 / 行下)。
//   升级到多选 batch reorder 时再扩 `ids` + `targets`,此处先打基础。
export interface InternalReorderPayload {
  /** 被拖动资源的 id(单条)。 */
  id: string;
  /** 落点侧 row 的资源 id。 */
  targetId: string;
  /** true = 插到 targetId 之前,false = 之后(由 y 与目标中线比较得出)。 */
  before: boolean;
  kind: ResourceKind;
}

export function writeReorderPayload(dt: DataTransfer, payload: InternalReorderPayload): void {
  try {
    dt.setData(RKMS_REORDER_MIME, JSON.stringify(payload));
  } catch (err: unknown) {
    void err;
  }
  dt.effectAllowed = 'move';
}

export function hasReorderPayload(dt: DataTransfer): boolean {
  return Array.from(dt.types).includes(RKMS_REORDER_MIME);
}

export function readReorderPayload(dt: DataTransfer): InternalReorderPayload | null {
  try {
    const raw = dt.getData(RKMS_REORDER_MIME);
    if (!raw) return null;
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object') return null;
    const p = v as Partial<InternalReorderPayload>;
    if (typeof p.id !== 'string' || p.id.length === 0) return null;
    if (typeof p.targetId !== 'string' || p.targetId.length === 0) return null;
    if (typeof p.before !== 'boolean') return null;
    if (p.kind !== 'note' && p.kind !== 'literature') return null;
    return { id: p.id, targetId: p.targetId, before: p.before, kind: p.kind };
  } catch {
    return null;
  }
}
