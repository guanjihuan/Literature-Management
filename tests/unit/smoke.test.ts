// tests/unit/smoke.test.ts
//
// Smoke:验证 vitest setup + module resolution 走通 —— 拉几个常用工具 import,
//   保证 build 链路路径别名 / tsconfig 投影都对得上。真正的业务契约由各
//   专题 .test.ts 文件守,这里只查 import 能解析 + 基础形状不漂。
import { describe, expect, it } from 'vitest';
import { errMsg, AppError, ValidationError } from '../../src/main/utils/error';
import { normalizeAndValidateNoteFilename } from '../../src/main/notes/filename-validator';
import { readMovePayload, writeMovePayload, hasMovePayload } from '../../src/renderer/src/lib/folder-dnd';

describe('smoke', () => {
  it('error util 导出正常', () => {
    expect(typeof errMsg).toBe('function');
    expect(new AppError('NOT_FOUND', 'x').code).toBe('NOT_FOUND');
  });

  it('filename-validator 抛空字符串 ValidationError,合法名补 .md', () => {
    expect(() => normalizeAndValidateNoteFilename('', 'filename')).toThrow(ValidationError);
    expect(normalizeAndValidateNoteFilename('hello', 'filename')).toBe('hello.md');
  });

  it('folder-dnd 序列化 + 反序列化 round-trip', () => {
    const types: string[] = [];
    const store = new Map<string, string>();
    const dt = {
      get types() {
        return types;
      },
      get effectAllowed() {
        return 'move' as const;
      },
      set effectAllowed(_v: 'move' | 'copy' | 'none' | 'link') {
        /* ignore */
      },
      setData(mime: string, val: string) {
        if (!store.has(mime)) types.push(mime);
        store.set(mime, val);
      },
      getData(mime: string) {
        return store.get(mime) ?? '';
      },
    } as unknown as DataTransfer;
    writeMovePayload(dt, { type: 'items', kind: 'note', ids: ['a', 'b'], relPaths: [] });
    expect(hasMovePayload(dt)).toBe(true);
    const payload = readMovePayload(dt);
    expect(payload).not.toBeNull();
    expect(payload?.kind).toBe('note');
    expect(payload?.ids).toEqual(['a', 'b']);
  });
});
