// 笔记「副本」文件名生成器 —— 给「复制 → 粘贴」流程用。
//
// 行为契约:
//   - 入参 `taken` = 目标目录内**已占用**的 filename 集合(带后缀)
//   - 入参 `sourceRelPath` = 源笔记的 relPath(可能带目录前缀)
//   - 返回值永远带 .md 后缀,且**不含源目录前缀**
//   - 命名规则(对齐 Windows 资源管理器复制):
//       foo.md        → foo (copy).md
//       foo (copy).md 已占用 → foo (copy 2).md
//       foo (copy 2).md 已占用 → foo (copy 3).md ...
//
// audit-r170:旧实现(store/notes.ts paste copy 分支)有两处硬伤,本文件是
//   它们的收口:
//   1. base 取 `stripExt(src.relPath)` —— stripExt 保留目录前缀,子目录里的
//      笔记(base='sub/foo')会生成 'sub/foo (copy).md',createNote 在**源目录**
//      下又建一层嵌套,副本根本没落到目标夹。
//   2. 副本名带圆括号 —— filename-validator 旧 regex 不收 '(' ')' → 每次
//      复制粘贴都抛 ValidationError(详见 filename-validator.ts r170 注释)。
//      本文件产出的名字必须过 validator,改动那里之前本函数不可用。
//
// 为什么放 renderer/utils:纯字符串 + 无 fs,renderer 侧(store)单点使用;
//   与同目录 note-default-name.ts(默认新建名生成器)同款定位。
import { stripExt } from '@shared/path-utils';

/** 取 relPath 的最后一段(兼容 POSIX / Windows 分隔符)。 */
function basename(relPath: string): string {
  const parts = relPath.split(/[\\/]/);
  return parts[parts.length - 1] ?? relPath;
}

/**
 * 找一个不会与目标目录内既有文件冲突的「副本」filename。
 *
 * @param taken          目标目录内已占用的 filename 集合(带后缀,如 'foo (copy).md')
 * @param sourceRelPath  源笔记 relPath(目录前缀会被剥掉)
 * @returns              带 `.md` 后缀的新 filename(不含目录前缀)
 */
export function nextNoteCopyFilename(
  taken: ReadonlySet<string>,
  sourceRelPath: string,
): string {
  // basename + stripExt:副本名只跟源**文件名**有关,与源在哪个目录无关。
  const base = stripExt(basename(sourceRelPath));
  const first = `${base} (copy).md`;
  if (!taken.has(first)) return first;
  for (let i = 2; i < Number.MAX_SAFE_INTEGER; i += 1) {
    const candidate = `${base} (copy ${i}).md`;
    if (!taken.has(candidate)) return candidate;
  }
  // 不可达:MAX_SAFE_INTEGER 个同名副本概率 0;TS 兜底返回。
  return first;
}
