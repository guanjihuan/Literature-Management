// 自写回声(self-write echo)抑制 —— 主进程侧。
//
// perf r239(2026-10-21):notes 域的 autosave 每 1.5s 落一次盘
//   (WORKSPACE_LIMITS.NOTES_AUTOSAVE_DEBOUNCE_MS),落盘 → chokidar
//   'change' → scheduleReload(100ms 去抖)→ **全量重扫**(scanNotes 把每个
//   .md 都 open+read+gray-matter 解析一遍)。
//
//   实测(本机,8KB/篇):
//     500 篇 → 全量重扫 124ms;2000 篇 → 410ms。
//   而触发条件只是「用户停下来打字 1.5 秒」。主进程被占住 ⇒ 整个应用
//   卡顿(不只是列表)。
//
//   而这次重扫是**纯浪费**:svc.write() 自己已经做完三件事 ——
//     1. byId.set(updated)     —— 内存索引已是最新
//     2. syncResource(updated) —— resources 表 + FTS 已是最新
//     3. emit('changed')       —— renderer 已收到广播
//   watcher 的回声只是把同样的状态**重新从磁盘读一遍**。
//
// 判据 = **文件指纹**(mtime + size + ino),不是「时间窗口」。
//
//   为什么不用时间窗口(曾经的实现):窗口内发生的**外部**改动会被一起
//   吞掉 —— 用户在 app 里 autosave 之后 1 秒内又用 Obsidian / 同步盘改了
//   同一个文件,那次改动永远不可见(直到下一次外部改动或重启)。
//   指纹判据没有这个洞:回声事件到达时现 stat 一次,与「我们写完时记下的
//   指纹」比对 —— 相同 ⇒ 文件还是我们写的那份 ⇒ 纯回声,抑制;不同 ⇒
//   文件被别人动过 ⇒ 照常重扫。
//
//   已知盲区(与全项目其它双因子判据同源,见 notes 的 DB 同步 r220 /
//   utils/fs-cache 的 readNote 缓存):「内容变了但 mtime 与 size 都一样」
//   (备份还原 / cp -p / 同步盘按内容去重,且长度相同)判成「没变」。
//   要兜只能全文 hash,代价是每次事件都把文件读回来 —— 正是本模块要
//   消掉的成本。
//
// 契约:
//   - mark(absPath, fp):「本进程刚写过这个文件,写完时它的指纹是 fp」。
//   - isSelfEcho(absPath, fp):「现在这个文件的指纹是 fp,是不是我自己
//     写出来的回声?」—— 命中即抑制。
//   - 记录**不被消费**:同一份指纹要能反复命中(应用连续 autosave 时
//     指纹会被新的写入覆盖,不会互相干扰)。TTL 只用于不让 map 无限增长。
//
// 为什么放在 utils/ 而不是各 service 内联:notes 与 literature 两个域是
//   同一款机制的两次实例化(两边都有 watcher → 去抖 → 全量 reload 的骨架),
//   判据「是不是我自己写的」必须同源,否则两边漂移出一个「只有一边生效」
//   的窗口,排查时极难看出。
//
// 为什么不用 renderer 那套 SELF_WRITE_SUPPRESS_WINDOW_MS:那是**渲染进程**
//   的「别因为自己写的广播去重拉列表」,管的是 IPC 往返;这里是**主进程**
//   的「别因为自己写的回声去重扫磁盘」,管的是磁盘 IO。两处窗口各自
//   独立取值,不要互相「统一」。
import { normalizePathForCompare } from './path-compare';

/** 文件指纹 —— 判定「还是不是同一份文件内容」。 */
export interface FileFingerprint {
  /** 修改时间(ms,含亚毫秒小数)。 */
  mtimeMs: number;
  /** 字节数。 */
  size: number;
  /** inode 号(Windows = file index;拿不到时为 0,退化成 mtime+size)。 */
  ino: number;
}

export function fileFingerprint(st: {
  mtimeMs: number;
  size: number;
  ino: number;
}): FileFingerprint {
  return { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino };
}

/** 两个指纹是否指同一份内容。 */
export function sameFingerprint(a: FileFingerprint, b: FileFingerprint): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size && a.ino === b.ino;
}

export class SelfWriteEchoSuppressor {
  /** 归一化后的路径 → { 写完时的指纹, 打点时刻 } */
  private marks = new Map<string, { fp: FileFingerprint; at: number }>();

  /**
   * @param ttlMs 打点有效期。回声事件的延迟上界(平台事件延迟 + 机器繁忙)
   *   通常在几百 ms 内,取 30s 是留足余量又不让 map 长期攥着旧记录。
   */
  constructor(private readonly ttlMs: number) {}

  /** 打点:本进程刚写过这个文件,写完时它的指纹是 fp。 */
  mark(absPath: string, fp: FileFingerprint, now: number = Date.now()): void {
    this.prune(now);
    this.marks.set(normalizePathForCompare(absPath), { fp, at: now });
  }

  /**
   * 这个 watcher 事件是不是我自己写出来的回声?
   * 命中 ⇒ true(该抑制重扫);未命中 / 指纹不同 / 记录过期 ⇒ false。
   */
  isSelfEcho(absPath: string, fp: FileFingerprint, now: number = Date.now()): boolean {
    const key = normalizePathForCompare(absPath);
    const rec = this.marks.get(key);
    if (rec === undefined) return false;
    if (now - rec.at > this.ttlMs) {
      // 记录过期:平台丢事件 / 磁盘卡顿时回声迟到太久 ⇒ 宁可多重扫,
      // 不可漏扫(外部改动必须可见)。
      this.marks.delete(key);
      return false;
    }
    return sameFingerprint(rec.fp, fp);
  }

  /** 当前有多少条未过期的打点(诊断用)。 */
  get size(): number {
    return this.marks.size;
  }

  /** 清掉过期打点 —— map 天然很小(只有「刚写过」的文件在里面),
   *  但防「某个路径的事件永远不来 → 打点永远留着」的慢性泄漏。 */
  private prune(now: number): void {
    if (this.marks.size === 0) return;
    for (const [key, rec] of this.marks) {
      if (now - rec.at > this.ttlMs) this.marks.delete(key);
    }
  }
}
