// 跨平台分支谓词集中点
//
// audit round 10 (2026-09-15):H5 — `process.platform === 'win32' ||
//   process.platform === 'darwin'` case-insensitive FS 谓词三处独立写
//   (safe-write.ts / fs-cache.ts / window.ts)。一处改规则(比如未来
//   Electron 加 CI 文件系统平台)要 grep 三处,容易漏。
//
// 集中后,新增 callsite 只 import 一个名字;若未来 Android / iOS 等其他
//   case-insensitive 平台出现,只改这一个文件。
//
// 为什么是 win32 + darwin:
//   - NTFS / FAT32 (Windows) 默认 case-insensitive,即使是 case-preserving
//     也能设置 case-sensitive flag 但 99%+ 默认装机是 insensitive
//   - APFS (macOS 10.13+) 默认 case-insensitive(可设 flag,但 99%+
//     默认是 insensitive)
//   - ext4 / btrfs (Linux) 默认 case-sensitive
//   - Electron 支持的平台就是 darwin / win32 / linux,这里列两个 case-insensitive

/** 文件系统是否默认 case-insensitive(WIN + Mac,Linux 否) */
export const isCaseInsensitiveFs: boolean =
  process.platform === 'win32' || process.platform === 'darwin';

/**
 * 是否需要「fsync 父目录」来保证 rename 的持久性。
 *
 * audit 2026-10-04:只对 POSIX 为 true。POSIX 的 fsync 语义要求 **目录项**
 * 也落盘才算 rename 提交;`fh.sync()` 只保证 tmp 文件的数据块落盘,
 * 两者是两件事 —— 不 fsync 目录,断电后 rename 可能丢失(目标文件回退到
 * 旧版本,表现为「这次保存静默没了」)。
 *
 * Windows 上不存在这个问题:NTFS 的元数据日志让 rename 的持久性与
 * MoveFileEx 的返回同步,而且 Node 在 Windows 上无法对目录句柄做有意义的
 * fsync(打开目录句柄成功但 sync 无效)。故此处直接跳过,不是「尽力而为」的
 * 猜测,而是「该平台上没有这个契约」。
 */
export const needsDirFsyncForRename: boolean = process.platform !== 'win32';
