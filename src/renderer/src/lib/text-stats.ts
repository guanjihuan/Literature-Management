// 文本统计 — 字数 / 字符数 / 行数
//
// 用于 StatusBar 中区显示当前笔记的字数与字符数(实时,debounce 由调用方负责)。
// 设计原则:
//   - 纯函数,无 IO / 无副作用
//   - 中文 / 英文混排友好:CJK 字符按 1 字算,英文按空格/标点分词
//   - 单测覆盖关键 case,见 tests/unit/renderer/lib/text-stats.test.ts

/** 统计字符数(含空白)— 等同于 body.length 但语义明确 */
export function charCount(text: string): number {
  return text.length;
}

/**
 * 统计字数 — CJK 字符算 1 字,英文/数字连续序列算 1 词。
 *
 * 举例:
 *   '你好世界' → 4
 *   'hello world' → 2
 *   '你好 hello' → 3 (2 个汉字 + 1 个词)
 *   '' → 0
 */
export function wordCount(text: string): number {
  if (!text) return 0;
  let n = 0;
  let inWord = false;
  for (const ch of text) {
    // CJK 范围覆盖基本汉字 + 日韩;每个字符独立计数
    if (isCjk(ch)) {
      n += 1;
      inWord = false;
      continue;
    }
    // 空白字符结束当前 word
    if (/\s/.test(ch)) {
      inWord = false;
      continue;
    }
    // audit-r82 (2026-10-17):标点/符号不起 word 也不断 word。旧实现任何
    //   非空白非 CJK 字符都起 word —— '你好,世界' 数出 5(全角逗号 +1)、
    //   '...' 数出 1,中文写作几乎每个逗号/句号都虚增,StatusBar 字数
    //   系统性虚高(node REPL 实证)。只有字母/数字(\p{L}\p{N})才起
    //   word;标点走 continue 不改 inWord —— 撇号/连字符不断词的既有
    //   契约("don't" / "mixed-language" 各 1 词)因此保持。
    if (!/[\p{L}\p{N}]/u.test(ch)) continue;
    if (!inWord) {
      n += 1;
      inWord = true;
    }
  }
  return n;
}

/** 统计行数(以 \n 分割;末尾无换行也算 1 行)— 给 Markdown 视图提供参考 */
export function lineCount(text: string): number {
  if (!text) return 0;
  return text.split('\n').length;
}

/** 简单 CJK 范围检测 — 覆盖基本汉字 + 平假名 + 片假名 + 韩文 */
function isCjk(ch: string): boolean {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return false;
  // CJK Unified Ideographs
  if (cp >= 0x4e00 && cp <= 0x9fff) return true;
  // CJK Unified Ideographs Extension A
  if (cp >= 0x3400 && cp <= 0x4dbf) return true;
  // audit-r82:CJK Extension B-G(增补平面 U+20000-U+2EBEF)—— for...of
  //   按码点迭代,codePointAt(0) 拿到完整码点;旧代码缺失这段,𠀀𠀁
  //   这类生僻字落入「英文 word」分支被并成 1 词。
  if (cp >= 0x20000 && cp <= 0x2ebef) return true;
  // audit-r82:CJK Compatibility Ideographs(旧字形 U+F900-U+FAFF)
  if (cp >= 0xf900 && cp <= 0xfaff) return true;
  // Hiragana
  if (cp >= 0x3040 && cp <= 0x309f) return true;
  // Katakana
  if (cp >= 0x30a0 && cp <= 0x30ff) return true;
  // Hangul Syllables
  if (cp >= 0xac00 && cp <= 0xd7af) return true;
  return false;
}

// (audit-r124:shortenPath 整体删除 —— StatusBar r56 左区下线后 src 零
//  caller(grep 实证),且自身头注即失真(写「保留最后 3 级」实为 keep=4)。
//  零消费者死码删除先例 r76 ContextMenu submenu;将来确需路径短化从 git
//  历史恢复比维护更便宜。)
