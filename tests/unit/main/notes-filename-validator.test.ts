// tests/unit/main/notes-filename-validator.test.ts
//
// 守 note 文件名校验契约 —— audit-r170 把圆括号放行(副本默认名
// 「X (copy).md」/「X (copy 2).md」是 Windows 资源管理器同款约定),
// 旧 regex 不收 '(' ')' → 每一次「复制 → 粘贴」都抛 ValidationError。
// 本文件锁住:
//   - 圆括号(中段 / 段首)合法
//   - 路径穿越形态('..'、绝对路径)仍被拒
//   - 保留设备名 / 超长名仍被拒
//   - .md / .markdown 两后缀都收
import { describe, expect, it } from 'vitest';
import {
  normalizeAndValidateNoteFilename,
  NOTE_FILENAME_MAX_LENGTH,
} from '../../../src/main/notes/filename-validator';
import { ValidationError } from '../../../src/main/utils/error';

describe('notes filename-validator', () => {
  it('r170:圆括号副本名合法(中段)', () => {
    expect(normalizeAndValidateNoteFilename('foo (copy).md', 'filename')).toBe('foo (copy).md');
    expect(normalizeAndValidateNoteFilename('foo (copy 2).md', 'filename')).toBe('foo (copy 2).md');
    expect(normalizeAndValidateNoteFilename('会议纪要 (副本).md', 'filename')).toBe(
      '会议纪要 (副本).md',
    );
  });

  it('r170:圆括号在段首也合法(OS 拖入「(1) 会议纪要.md」)', () => {
    expect(normalizeAndValidateNoteFilename('(1) 会议纪要.md', 'filename')).toBe(
      '(1) 会议纪要.md',
    );
  });

  it('r170:嵌套路径(带目录前缀)仍合法 —— 副本直接建在目标目录靠它', () => {
    expect(normalizeAndValidateNoteFilename('sub/foo (copy).md', 'filename')).toBe(
      'sub/foo (copy).md',
    );
  });

  it('路径穿越形态仍被拒', () => {
    expect(() => normalizeAndValidateNoteFilename('../evil.md', 'filename')).toThrow(ValidationError);
    expect(() => normalizeAndValidateNoteFilename('a/../../evil.md', 'filename')).toThrow(
      ValidationError,
    );
  });

  it('保留设备名仍被拒(每段都查)', () => {
    expect(() => normalizeAndValidateNoteFilename('con.md', 'filename')).toThrow(ValidationError);
    expect(() => normalizeAndValidateNoteFilename('sub/con.md', 'filename')).toThrow(
      ValidationError,
    );
  });

  it('超长名仍被拒', () => {
    const long = `${'a'.repeat(NOTE_FILENAME_MAX_LENGTH + 1)}.md`;
    expect(() => normalizeAndValidateNoteFilename(long, 'filename')).toThrow(ValidationError);
  });

  it('.md / .markdown 两后缀都收,缺后缀自动补 .md', () => {
    expect(normalizeAndValidateNoteFilename('foo', 'filename')).toBe('foo.md');
    expect(normalizeAndValidateNoteFilename('foo.markdown', 'filename')).toBe('foo.markdown');
  });
});
