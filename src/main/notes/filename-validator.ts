// createNote / renameNote 共用同一份校验(防 silent drift):抛 ValidationError +
// field 让 IPC map 表单字段;不放 shared 是因为 ValidationError 是 main-only。

import { ValidationError } from '../utils/error';
import { tr } from '../i18n';

// audit-r160:接受 .md / .markdown 两后缀 —— r155-L1 扩 scanNotes / import.ts
//   端接受 .markdown 后,用户从 Obsidian / Joplin / Bear 导入或手动丢入 .markdown
//   文件,chokidar 'add' 走 scanNotes 能收,但 New Note / Rename 走本 validator
//   旧 regex 只认 .md → 主动改名到 .markdown 被 INVALID_CHARS 拒。一致性破洞用
//   `(?:d|arkdown)` 非捕获组 + case-insensitive 与 scanNotes / import.ts 对齐。
//
// audit-r170:接受圆括号 —— 「复制 → 粘贴」的默认副本名是「X (copy).md」/
//   「X (copy 2).md」(Windows 资源管理器同款约定),旧 regex 不收 '(' ')' →
//   createNote 直接抛 ValidationError('validation.noteFilenameInvalidChars')
//   → **每一次 notes 复制粘贴都失败**(用户报「粘贴功能存在问题」的主因)。
//
// ── r195:字符集改成「与文献域同一把尺子」─────────────────────────────────
//
// 旧实现是一条**白名单 regex**:
//   /^[A-Za-z0-9_\-(一-龥][A-Za-z0-9_\- 一-龥()/]*\.m(?:d|arkdown)$/i
// 即:只收字母 / 数字 / 下划线 / 连字符 / 空格 / 圆括号 / 中文。**其余一律拒**。
//
// 后果(用户可复现,且与「列表 == 文件夹」的诉求直接冲突):
//   1. 侧栏**列得出**这些文件 —— collectNotePaths 只按后缀收(.md/.markdown),
//      不做字符过滤 ⇒ 「A&B.md」「C++ 学习.md」「v1.2 草稿.md」「100%完成.md」
//      「结果=最终.md」「O'Brien 访谈.md」全都**照常显示在列表里**;
//   2. 但**同样的文件名**,应用自己却拒绝管理:
//      - 拖入导入 → importNoteFromFile → createNote → 本 validator
//        → ValidationError ⇒ **文件根本进不来**(用户从 Obsidian /
//        网盘同步来的笔记大量命中);
//      - 改名到这种名字 → 同样被拒。
//   ⇒ **「看得见、管不了」** —— 与 r186 在文件夹层修掉的 I2 不变量
//      (「列得出来的,一定能进得去」)是同一个洞的字符集版本。
//   3. 两侧不对齐:文献域的改名校验(`literature/rename-file.ts`
//      `planLiteratureRename`)只拒 Win32 真正不能用的 `< > : " | ? *`
//      + 控制字符,「C++ 笔记.pdf」改名**通过**;同名 .md **被拒**。
//      用户诉求「两个列表的操作要对齐」⇒ 同一个字符,一边行一边不行。
//
// 修法:白名单 → **黑名单**。只拒「在 Windows / macOS / Linux 上真的建不出来」
// 的字符与形态,其余(点、& + = % ! @ $ # , ; ' ~ [] {} 等)一律放行 ——
// 它们不进路径语法(不与 '/' '\' 冲突),不削弱 resolveInsideRootPath 的
// 越界防护(越界靠路径解析 + 根目录校验 + 本文件下面的段规则,不靠字符集)。
//
//   段规则(逐段,与 shared/rel-path.ts 的核心段规则 + 文献域改名规则对齐):
//     - 段非空('a//b.md' 拒)
//     - 段不恰为 '.' / '..'(路径穿越;r186 收窄后的口径)
//     - 段不以 '.' 开头(隐藏项 —— collectNotePaths 也跳过 dot 项,
//       应用不管理隐藏文件 ⇒ 列不出也管不了,两侧一致)
//     - 段不含 '\' 与 Win32 保留字符 <>:"|?* 与控制字符
//     - 段不以 '.' 或空格结尾(Win32 会**静默截断**,存下去的名字与用户
//       输入的不一样 ⇒ 用户下次找不到自己的文件)
//     - 段的「词干」(第一个 '.' 之前)不是 Windows 保留设备名
//       (con / prn / aux / nul / com1-9 / lpt1-9,含 'con.txt' 这种形态)
//
// 另加一条**域内**规则:改名(newFilename)**不得含 '/'** —— r175 起
// 「重命名只改文件名,保留所在目录」,而旧 regex 收 '/' ⇒ 用户在改名框里
// 写 'sub/x.md' 会把笔记**搬进子目录**(违反 r175 的不变式);文献域同样
// 拒 '/'。create 路径(filename)仍然允许 '/' —— 新建到子目录靠它。

// https://learn.microsoft.com/windows/win32/fileio/naming-a-file
//
// audit 2026-10-21:Win32 命名规则收成**一份** —— shared/win32-name.ts。
//   本文件原先自己抄了一份(WIN32_FORBIDDEN_CHARS / CONTROL_CHARS /
//   RESERVED_DEVICE_NAME),文献域(renamed-file.ts)抄了第二份,而
//   **文件夹名**那一处压根没抄 ⇒ 抄漏处正是死夹的来源(P1-1)。
//   现在三处都引用 shared/win32-name.ts,规则改一处即三处同步。
import {
  hasControlChars,
  hasWin32ForbiddenChars,
  isReservedDeviceName,
} from '@shared/win32-name';

// 视觉长度(grapheme 计数),防 MAX_PATH 260 越界
export const NOTE_FILENAME_MAX_LENGTH = 120;

/**
 * Trim → 补 .md → 校验字符集 / 段规则 / 长度 / 保留名。
 * @throws ValidationError(EMPTY / INVALID_CHARS / RESERVED_NAME / TOO_LONG)
 */
export function normalizeAndValidateNoteFilename(
  input: string,
  field: 'filename' | 'newFilename',
): string {
  const trimmed = (input ?? '').trim();
  if (!trimmed) {
    throw new ValidationError(
      field === 'newFilename'
        ? tr('validation.noteFilenameEmpty')
        : tr('validation.noteFilenameEmptyOriginal'),
      field,
    );
  }
  let fn = trimmed;
  // audit-r160:补后缀逻辑同步接受 .markdown —— 与后缀白名单一致。
  //   旧实现只 endsWith('.md'),用户输入 'foo.markdown' 走 validator 后再补
  //   '.md' → 'foo.markdown.md' → INVALID_CHARS。改成 endsWith 两个后缀。
  if (!/\.m(?:d|arkdown)$/i.test(fn)) fn += '.md';
  // r195:段规则取代白名单 regex —— 先按 '/' 切段(改名路径 field='newFilename'
  //   一律拒 '/' 见下)。
  const rawSegments = fn.split('/');
  if (field === 'newFilename' && rawSegments.length > 1) {
    // r195:改名只改文件名,不改位置(r175 不变式;文献域同款)。
    throw new ValidationError(tr('validation.noteFilenamePathSeparator', { name: fn }), field);
  }
  for (const seg of rawSegments) {
    if (seg === '') {
      throw new ValidationError(tr('validation.noteFilenameInvalidChars', { name: fn }), field);
    }
    // 隐藏项:collectNotePaths 跳过 dot 项 ⇒ 应用不列也不管,两侧一致。
    if (seg.startsWith('.')) {
      throw new ValidationError(tr('validation.noteFilenameInvalidChars', { name: fn }), field);
    }
    // 路径穿越:段恰为 '..'(r186 收窄后的口径 —— 'a..b' 是合法名字)。
    if (seg === '..') {
      throw new ValidationError(tr('validation.noteFilenameInvalidChars', { name: fn }), field);
    }
    if (hasWin32ForbiddenChars(seg) || seg.includes('\\') || hasControlChars(seg)) {
      throw new ValidationError(tr('validation.noteFilenameInvalidChars', { name: fn }), field);
    }
    // Win32 静默截断:结尾的点 / 空格会被 OS 悄悄去掉 ⇒ 存下来的名字与
    // 用户输入的不一样(用户下次找不到自己的文件)。文献域同名规则同款。
    if (/[. ]$/.test(seg)) {
      throw new ValidationError(tr('validation.noteFilenameInvalidChars', { name: fn }), field);
    }
    // Windows 保留设备名:按**词干**判(第一个 '.' 之前)—— 'con.txt.md'
    //   的词干是 'con' ⇒ 拒(与文献域 planLiteratureRename 同款)。
    if (isReservedDeviceName(seg)) {
      throw new ValidationError(tr('validation.noteFilenameReserved', { seg }), field);
    }
  }
  const visualLen = [...fn].length;
  if (visualLen > NOTE_FILENAME_MAX_LENGTH) {
    throw new ValidationError(
      tr('validation.noteFilenameTooLong', { len: visualLen, max: NOTE_FILENAME_MAX_LENGTH }),
      field,
    );
  }
  return fn;
}
