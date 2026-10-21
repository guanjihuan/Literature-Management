// tests/unit/renderer/lib/text-stats.test.ts
//
// 守卫(r206,2026-10-20):StatusBar 中区的字数 / 字符数 / 行数统计。
//
// 为什么值得锁:这三个数字是**用户唯一能看到的"我写了多少"反馈**,
// 算错不会报错、只会静默给一个错的数。历史上已经出过一次系统性偏差
// (r82):旧 wordCount 把「任何非空白非 CJK 字符」都起一个词,于是
// '你好,世界' 数出 5(全角逗号 +1)—— 中文写作几乎每个逗号/句号都虚增。
//
// 覆盖边界(诚实声明):charCount 用的是 String.length,**是 UTF-16 码元数**,
// 不是 Unicode 字位数 —— 表情符号(代理对)算 2。这是**当前实现的既定
// 语义**,本守卫把它钉住;若将来改成 [...text].length,这条会红,届时
// 记得同步改注释与 CHANGELOG。
import { describe, expect, it } from 'vitest';
import { charCount, lineCount, wordCount } from '@renderer/lib/text-stats';

describe('text-stats(r206)', () => {
  describe('charCount', () => {
    it('空串 → 0', () => {
      expect(charCount('')).toBe(0);
    });

    it('按 UTF-16 码元计长(代理对算 2)', () => {
      expect(charCount('abc')).toBe(3);
      expect(charCount('你好')).toBe(2);
      expect(charCount('😀')).toBe(2);
    });

    it('含空白也算进字符数', () => {
      expect(charCount('a b\nc')).toBe(5);
    });
  });

  describe('wordCount', () => {
    it('空串 → 0', () => {
      expect(wordCount('')).toBe(0);
    });

    it('CJK 每个字算 1', () => {
      expect(wordCount('你好世界')).toBe(4);
    });

    it('英文按空格分词', () => {
      expect(wordCount('hello world')).toBe(2);
    });

    it('中英混排:CJK 逐字 + 英文按词', () => {
      // 注:源码 doc 注释原写「'你好 hello' → 2(1 字 + 1 词)」—— 错的,
      // 「你好」是**两个**汉字 ⇒ 2 + 1 = 3。r206 更正注释,本例钉住实际行为。
      expect(wordCount('你好 hello')).toBe(3);
    });

    it('标点/符号不起词、也不断词(r82 修的核心)', () => {
      // 旧实现:全角逗号 +1 ⇒ '你好,世界' 数出 5
      expect(wordCount('你好,世界')).toBe(4);
      expect(wordCount('...')).toBe(0);
      expect(wordCount('!!! ???')).toBe(0);
    });

    it('撇号/连字符不断词(既有契约)', () => {
      expect(wordCount("don't")).toBe(1);
      expect(wordCount('mixed-language')).toBe(1);
    });

    it('字母与数字连写算 1 词', () => {
      expect(wordCount('a1')).toBe(1);
      expect(wordCount('2024')).toBe(1);
    });

    it('CJK 扩展 B-G 增补平面按字计(不是并成 1 词)', () => {
      // 𠀀 𠀁 —— 旧实现缺这段,会被并成 1 词
      expect(wordCount('𠀀𠀁')).toBe(2);
    });

    it('CJK 兼容表意文字(旧字形 U+F900-U+FAFF)按字计', () => {
      expect(wordCount('豈')).toBe(1);
    });

    it('假名 / 谚文按字计', () => {
      expect(wordCount('ひらがな')).toBe(4);
      expect(wordCount('カタカナ')).toBe(4);
      expect(wordCount('한글')).toBe(2);
    });

    it('空白字符结束当前词', () => {
      expect(wordCount('a\tb')).toBe(2);
      expect(wordCount('a\nb')).toBe(2);
      expect(wordCount('a  b')).toBe(2);
    });
  });

  describe('lineCount', () => {
    it('空串 → 0', () => {
      expect(lineCount('')).toBe(0);
    });

    it('单行无换行 → 1', () => {
      expect(lineCount('a')).toBe(1);
    });

    it('按 \\n 分割', () => {
      expect(lineCount('a\nb')).toBe(2);
      expect(lineCount('a\nb\nc')).toBe(3);
    });

    it('末尾有换行时,末尾空行也算 1 行(split 语义)', () => {
      expect(lineCount('a\n')).toBe(2);
    });
  });
});
