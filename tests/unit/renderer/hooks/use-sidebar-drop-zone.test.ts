// tests/unit/renderer/hooks/use-sidebar-drop-zone.test.ts
//
// 守 r226「落点区 DnD 全家桶收编」契约(收编 ③):
//   NotesList / LiteratureList 里逐字相同的 ① OS 文件拖入导入链
//   (dragActive + dragCounterRef + dragOver/Enter/Leave/Drop + inert
//   effect)② 内部 drag 容器落点三件套(ROOT_DROP_ID)③ hidden file
//   picker 入口,收进 hooks/use-sidebar-drop-zone.ts;唯一分叉 importFiles
//   由 caller 注入。
//
// ── 锁两类东西(与 r224/r225 同模式)────────────────────────────────
//   1. 行为契约(收编前既有行为,对 HEAD 也必须绿):
//      enter 仅 'Files' 类型计数 / 计数法 0↔1 切换 overlay / leave 不负数;
//      dragOver 内部=move 否则 copy;drop 内部=取消(不导入)否则计数清零
//      + importFiles;容器三件套 gated on isInternalDrag(非内部不
//      preventDefault,OS 文件直通 import 链);inert 随 dragActive 增减;
//      picker change 后清空 value(同文件再选仍触发);
//   2. 结构契约:组件源码不得再出现 dragCounterRef / setAttribute('inert'
//      —— 孪生块复活即红(修前红)。
import { describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { ChangeEvent, DragEvent as ReactDragEvent } from 'react';
import { useSidebarDropZone } from '../../../../src/renderer/src/hooks/use-sidebar-drop-zone';
import { ROOT_DROP_ID, type DiskFolderSidebar } from '../../../../src/renderer/src/hooks/useDiskFolderSidebar';

function makeFolders(internal: boolean) {
  return {
    isInternalDrag: vi.fn(() => internal),
    handleTargetDragOver: vi.fn(),
    handleTargetDragLeave: vi.fn(),
    handleTargetDrop: vi.fn().mockResolvedValue(undefined),
  } as unknown as DiskFolderSidebar;
}

function makeDragEvent(opts: { files?: boolean } = {}) {
  const dt = {
    types: opts.files ? ['Files'] : ['text/plain'],
    files: [{ name: 'x.md' }] as unknown as FileList,
    dropEffect: 'none',
    effectAllowed: 'all',
  } as unknown as DataTransfer;
  return {
    dataTransfer: dt,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as ReactDragEvent;
}

function setup(internal = false) {
  const folders = makeFolders(internal);
  const runFolderOp = vi.fn((op: () => Promise<unknown>) => void op());
  const importFiles = vi.fn().mockResolvedValue(undefined);
  const container = document.createElement('div');
  const listContainerRef = { current: container as HTMLElement };
  const hook = renderHook(() =>
    useSidebarDropZone({ folders, runFolderOp, listContainerRef, importFiles }),
  );
  return { ...hook, folders, runFolderOp, importFiles, container };
}

describe('useSidebarDropZone(r226 收编块的行为契约)', () => {
  it('dragEnter 仅 Files 类型计数;计数 0↔1 切 overlay;leave 不为负', () => {
    const { result } = setup();
    // 非文件 drag(文本选择 / 内部 reorder)⇒ 不计数不弹层
    act(() => result.current.handleDragEnter(makeDragEvent({ files: false })));
    expect(result.current.dragActive).toBe(false);

    // 两次 enter(子元素冒泡)⇒ 仍只弹一次;一次 leave 不关
    act(() => result.current.handleDragEnter(makeDragEvent({ files: true })));
    expect(result.current.dragActive).toBe(true);
    act(() => result.current.handleDragEnter(makeDragEvent({ files: true })));
    act(() => result.current.handleDragLeave(makeDragEvent({ files: true })));
    expect(result.current.dragActive).toBe(true);
    // 第二次 leave 归零 ⇒ 关;再一次 leave 不为负(仍关、不抛)
    act(() => result.current.handleDragLeave(makeDragEvent({ files: true })));
    expect(result.current.dragActive).toBe(false);
    act(() => result.current.handleDragLeave(makeDragEvent({ files: true })));
    expect(result.current.dragActive).toBe(false);
  });

  it('dragOver:内部 drag=move(容器 drop 会忽略),OS 文件=copy', () => {
    const internal = setup(true);
    const e1 = makeDragEvent();
    act(() => internal.result.current.handleDragOver(e1));
    expect(e1.dataTransfer.dropEffect).toBe('move');

    const external = setup(false);
    const e2 = makeDragEvent();
    act(() => external.result.current.handleDragOver(e2));
    expect(e2.dataTransfer.dropEffect).toBe('copy');
  });

  it('drop:内部 drag 落空白 = 取消(不导入);OS 文件 ⇒ 计数清零 + importFiles', async () => {
    const internal = setup(true);
    await act(async () => {
      await internal.result.current.handleDrop(makeDragEvent({ files: true }));
    });
    expect(internal.importFiles).not.toHaveBeenCalled();

    const external = setup(false);
    act(() => external.result.current.handleDragEnter(makeDragEvent({ files: true })));
    expect(external.result.current.dragActive).toBe(true);
    await act(async () => {
      await external.result.current.handleDrop(makeDragEvent({ files: true }));
    });
    expect(external.result.current.dragActive).toBe(false);
    expect(external.importFiles).toHaveBeenCalledTimes(1);
  });

  it('容器三件套 gated on isInternalDrag:内部 ⇒ ROOT_DROP_ID 落点;非内部直通不拦截', () => {
    const internal = setup(true);
    const e1 = makeDragEvent();
    act(() => {
      internal.result.current.handleContainerDragOver(e1);
      internal.result.current.handleContainerDragLeave(e1);
      internal.result.current.handleContainerDrop(e1);
    });
    expect(internal.folders.handleTargetDragOver).toHaveBeenCalledWith(e1, ROOT_DROP_ID);
    expect(internal.folders.handleTargetDragLeave).toHaveBeenCalledWith(e1, ROOT_DROP_ID);
    expect(internal.folders.handleTargetDrop).toHaveBeenCalledWith(e1, ROOT_DROP_ID);
    expect(e1.preventDefault).toHaveBeenCalled();

    // 非内部 ⇒ 全部放行(不 preventDefault —— import overlay 链靠事件未被拦截才生效)
    const external = setup(false);
    const e2 = makeDragEvent({ files: true });
    act(() => {
      external.result.current.handleContainerDragOver(e2);
      external.result.current.handleContainerDrop(e2);
    });
    expect(external.folders.handleTargetDragOver).not.toHaveBeenCalled();
    expect(external.folders.handleTargetDrop).not.toHaveBeenCalled();
    expect(e2.preventDefault).not.toHaveBeenCalled();
  });

  it('inert 随 dragActive 增/删(a11y H4:dragenter 期间底层不可 Tab)', () => {
    const { result, container } = setup();
    expect(container.hasAttribute('inert')).toBe(false);
    act(() => result.current.handleDragEnter(makeDragEvent({ files: true })));
    expect(container.getAttribute('inert')).toBe('');
    act(() => result.current.handleDragLeave(makeDragEvent({ files: true })));
    expect(container.hasAttribute('inert')).toBe(false);
  });

  it('file picker:change ⇒ importFiles + 清空 value(同文件再选仍触发)', () => {
    const { result, importFiles } = setup();
    const input = document.createElement('input');
    const files = [{ name: 'a.md' }] as unknown as FileList;
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    act(() => {
      result.current.onFilePickerChange({
        target: input,
      } as unknown as ChangeEvent<HTMLInputElement>);
    });
    expect(importFiles).toHaveBeenCalledWith(files);
    expect(input.value).toBe('');
  });
});

describe('r226 结构契约:孪生块不得复活', () => {
  const ROOT = process.cwd();
  for (const rel of [
    'src/renderer/src/components/notes/NotesList.tsx',
    'src/renderer/src/components/literature/LiteratureList.tsx',
  ]) {
    it(`${rel} 走 useSidebarDropZone,不再自带落点区 DnD 机器`, () => {
      const src = readFileSync(join(ROOT, rel), 'utf-8');
      expect(src, '落点区 DnD 必须走 hooks/use-sidebar-drop-zone').toContain('useSidebarDropZone');
      expect(src, '孪生块复活:组件里又出现 dragCounterRef').not.toContain('dragCounterRef');
      expect(src, '孪生块复活:组件里又出现 inert 同步').not.toContain("setAttribute('inert'");
    });
  }
});
