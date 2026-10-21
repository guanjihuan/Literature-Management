// tests/unit/renderer/hooks/use-folder-ops.test.ts
//
// 守 r227「文件夹操作 + 粘贴反馈包装」收编契约(收编 ④):
//   NotesList / LiteratureList 里逐字相同的 runFolderOp(r173)/
//   commitFolderEdit(r176)/ pasteTo(0007) 三段收进 hooks/use-folder-ops.ts;
//   唯一分叉 = log 消息前缀(logTag)与 paste 失败 toast 的 i18n key
//   (pasteFailedKey)—— 两域 locale 树不同。
//
// ── 锁两类东西(与 r224-r226 同模式)────────────────────────────────
//   1. 行为契约(收编前既有行为,对 HEAD 也必须绿):
//      op 失败 ⇒ log + 错误 toast,不吞异常;成功 ⇒ 静默;
//      commitFolderEdit 成功 true / 失败 false(输入框回可编辑态,不卡 busy);
//      pasteTo 失败用注入的 key 弹 toast;pasteToTarget 落点 = 当前落点文件夹;
//   2. 结构契约:组件源码不得再出现 'folder op failed' / 'folder edit failed'
//      —— 孪生块复活即红(修前红)。
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { readFileSync } from 'fs';
import { join } from 'path';

// i18n —— t 回显 key,便于断言「用的是哪个 key」。
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { msg?: string }) => (opts?.msg ? `${key}|${opts.msg}` : key),
  }),
}));

// toast —— 只记录调用,不引入 zustand store。
const toastCalls: { type: string; message: string }[] = [];
vi.mock('../../../../src/renderer/src/lib/toast', () => ({
  useToast: () => (opts: { type: string; message: string }) => {
    toastCalls.push(opts);
  },
}));

// logger —— 记录 error 消息(验证 logTag 注入)。
const logErrors: { msg: string; err: unknown }[] = [];
vi.mock('../../../../src/renderer/src/lib/logger-client', () => ({
  createLogger: () => ({
    error: (msg: string, err: unknown) => logErrors.push({ msg, err }),
    warn: () => {},
    info: () => {},
    debug: () => {},
  }),
}));

import { useFolderOps } from '../../../../src/renderer/src/hooks/use-folder-ops';
import type { DiskFolderSidebar } from '../../../../src/renderer/src/hooks/useDiskFolderSidebar';

function setup(over: { pasteFailedKey?: string; logTag?: string } = {}) {
  const commitEdit = vi.fn().mockResolvedValue(undefined);
  const folders = {
    commitEdit,
    targetRelPath: 'sub/dir',
  } as unknown as DiskFolderSidebar;
  const pasteClipboard = vi.fn().mockResolvedValue(undefined);
  const hook = renderHook(() =>
    useFolderOps({
      logTag: over.logTag ?? 'NotesList',
      pasteFailedKey: over.pasteFailedKey ?? 'toast.pasteNoteFailed',
      folders,
      pasteClipboard,
    }),
  );
  return { ...hook, commitEdit, pasteClipboard };
}

beforeEach(() => {
  toastCalls.length = 0;
  logErrors.length = 0;
});

describe('useFolderOps(r227 收编块的行为契约)', () => {
  it('runFolderOp:成功静默;失败 ⇒ log + 错误 toast(不吞异常)', async () => {
    const { result } = setup();
    result.current.runFolderOp(() => Promise.resolve('ok'));
    await Promise.resolve();
    expect(toastCalls).toHaveLength(0);
    expect(logErrors).toHaveLength(0);

    const boom = new Error('boom');
    result.current.runFolderOp(() => Promise.reject(boom));
    await new Promise((r) => setTimeout(r, 0));
    expect(logErrors[0].msg).toBe('NotesList folder op failed');
    expect(logErrors[0].err).toBe(boom);
    expect(toastCalls[0].type).toBe('error');
    expect(toastCalls[0].message).toContain('toast.folderMoveFailed');
  });

  it('runFolderOp:log 前缀随 logTag 注入(两域各用自己的组件名)', async () => {
    const { result } = setup({ logTag: 'LiteratureList' });
    result.current.runFolderOp(() => Promise.reject(new Error('x')));
    await new Promise((r) => setTimeout(r, 0));
    expect(logErrors[0].msg).toBe('LiteratureList folder op failed');
  });

  it('commitFolderEdit:成功 ⇒ true 且无 toast;失败 ⇒ false + 错误 toast', async () => {
    const { result, commitEdit } = setup();
    await expect(result.current.commitFolderEdit('newName')).resolves.toBe(true);
    expect(commitEdit).toHaveBeenCalledWith('newName');
    expect(toastCalls).toHaveLength(0);

    commitEdit.mockRejectedValueOnce(new Error('bad'));
    await expect(result.current.commitFolderEdit('x')).resolves.toBe(false);
    expect(toastCalls[0].type).toBe('error');
    expect(toastCalls[0].message).toContain('toast.folderMoveFailed');
    expect(logErrors[0].msg).toBe('NotesList folder edit failed');
  });

  it('pasteTo:失败用注入的 i18n key 弹 toast;成功静默', async () => {
    const { result, pasteClipboard } = setup({ pasteFailedKey: 'literature.pasteFailedToast' });
    pasteClipboard.mockRejectedValueOnce(new Error('nope'));
    await result.current.pasteTo('target');
    expect(toastCalls[0].message).toContain('literature.pasteFailedToast');
    expect(logErrors[0].msg).toBe('NotesList paste failed');

    toastCalls.length = 0;
    logErrors.length = 0;
    await result.current.pasteTo('target');
    expect(toastCalls).toHaveLength(0);
    expect(logErrors).toHaveLength(0);
  });

  it('pasteToTarget:落点 = 当前落点文件夹(folders.targetRelPath)', () => {
    const { result, pasteClipboard } = setup();
    result.current.pasteToTarget();
    expect(pasteClipboard).toHaveBeenCalledWith('sub/dir');
  });
});

describe('r227 结构契约:孪生块不得复活', () => {
  const ROOT = process.cwd();
  for (const rel of [
    'src/renderer/src/components/notes/NotesList.tsx',
    'src/renderer/src/components/literature/LiteratureList.tsx',
  ]) {
    it(`${rel} 走 useFolderOps,不再自带 op 反馈包装`, () => {
      const src = readFileSync(join(ROOT, rel), 'utf-8');
      expect(src, '文件夹操作/粘贴包装必须走 hooks/use-folder-ops').toContain('useFolderOps');
      expect(src, '孪生块复活:组件里又出现 runFolderOp 的实现').not.toContain('folder op failed');
      expect(src, '孪生块复活:组件里又出现 commitFolderEdit 的实现').not.toContain('folder edit failed');
    });
  }
});
