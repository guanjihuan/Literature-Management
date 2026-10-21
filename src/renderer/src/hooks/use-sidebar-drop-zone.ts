// use-sidebar-drop-zone:侧栏面板的落点区 DnD 全家桶 ——
//   ① OS 文件拖入导入链(dragActive 覆盖层状态 + dragCounterRef 计数 +
//      dragOver/Enter/Leave/Drop 四件套 + inert 同步 effect);
//   ② 内部拖拽(lib/folder-dnd 自定义 MIME)落到空白 = 落进当前文件夹
//      (container dragOver/Leave/Drop 三件套,ROOT_DROP_ID);
//   ③ 键盘 / SR 可达的 hidden file picker 入口(filePickerRef +
//      triggerFilePicker + onFilePickerChange)。
//
// audit-r226 (2026-10-20):NotesList / LiteratureList 同构块收编 ③。
//   收编前这些段在两文件里**逐字相同**(唯一分叉 = drop 落地后调用的
//   importFiles,域特定,注入)。行为逐条对账:
//   - handleDragOver:内部 drag ⇒ dropEffect='move'(容器 drop 会忽略,
//     只是视觉);否则 'copy'(OS 文件导入);
//   - handleDragEnter:仅 'Files' 类型才计数 + 弹 overlay —— 任何 drag 都
//     触发会让 overlay 在文本选择 / 内部 row reorder / 链接 drag 时闪烁;
//   - handleDragLeave:计数归零才关 overlay(enter/leave 在子元素间冒泡,
//     计数法是唯一不闪的写法);
//   - handleDrop:内部 drag 落空白 = **取消**(不导入、不弹「无文件」
//     toast;有效目标是文件夹行 / 面包屑 chip,它们 stopPropagation 自行
//     处理);否则计数清零 + 调注入的 importFiles;
//   - inert effect(a11y H4):dragActive 期间底层容器 setAttribute('inert'),
//     键盘 user 在 dragenter 期间 Tab 不再 focus 到底层 row(aria-hidden
//     只对 AT 起效);inert 是 boolean attribute,出现即 true;
//   - container 三件套:gated on folders.isInternalDrag —— 非内部拖拽
//     (OS 文件)直接放行让外层 import 链跑;**不要在 wrapper 统一
//     preventDefault 内部 drag**,那会吞掉 OS 文件拖入的 dragover,
//     import overlay 永不上场;
//   - onFilePickerChange:读完 files 立刻 `e.target.value = ''`(同文件
//     再选一次也要触发 change)。
//
// 与 r224/r225 同一模式:useLatestValue(opts) ⇒ 所有 handler 身份恒定。

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent as ReactDragEvent,
  type MutableRefObject,
  type RefObject,
} from 'react';
import { ROOT_DROP_ID, type DiskFolderSidebar } from './useDiskFolderSidebar';
import { useLatestValue } from './useLatestValue';

export interface UseSidebarDropZoneOptions {
  folders: DiskFolderSidebar;
  runFolderOp: (op: () => Promise<unknown>) => void;
  /** inert 同步的目标容器(inert effect 每次现读 .current)。 */
  listContainerRef: RefObject<HTMLElement | null>;
  /** drop / file picker 共用的导入实现(域特定:.md / .pdf 分类与 IPC)。 */
  importFiles: (files: FileList | File[]) => Promise<void>;
}

export function useSidebarDropZone(opts: UseSidebarDropZoneOptions): {
  dragActive: boolean;
  filePickerRef: MutableRefObject<HTMLInputElement | null>;
  handleDragOver: (e: ReactDragEvent) => void;
  handleDragEnter: (e: ReactDragEvent) => void;
  handleDragLeave: (e: ReactDragEvent) => void;
  handleDrop: (e: ReactDragEvent) => Promise<void>;
  handleContainerDragOver: (e: ReactDragEvent) => void;
  handleContainerDragLeave: (e: ReactDragEvent) => void;
  handleContainerDrop: (e: ReactDragEvent) => void;
  triggerFilePicker: () => void;
  onFilePickerChange: (e: ChangeEvent<HTMLInputElement>) => void;
} {
  const latest = useLatestValue(opts);
  // === 拖入覆盖层状态(dragCounterRef 计数 enter/leave,dragActive 仅 0↔1) ===
  const [dragActive, setDragActive] = useState(false);
  const dragCounterRef = useRef(0);
  const filePickerRef = useRef<HTMLInputElement>(null);

  const handleDragOver = useCallback(
    (e: ReactDragEvent) => {
      // 0007:内部拖拽(lib/folder-dnd 自定义 MIME)落在非 drop 目标的空白
      //   处:dropEffect 标成 move,但容器 drop 会忽略(见 handleDrop)。
      if (latest.current.folders.isInternalDrag(e)) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
    },
    [latest],
  );

  const handleDragEnter = useCallback(
    (e: ReactDragEvent) => {
      // audit 2026-09-14:仅文件拖入才计数 + 显示 overlay —— 任何 drag 都触发
      //   会让 overlay 在文本选择 / 内部 row reorder / 链接 drag 时闪烁。
      const types = e.dataTransfer.types;
      if (!types || !Array.from(types).includes('Files')) return;
      e.preventDefault();
      e.stopPropagation();
      dragCounterRef.current += 1;
      if (dragCounterRef.current === 1) setDragActive(true);
    },
    [],
  );

  const handleDragLeave = useCallback((e: ReactDragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) setDragActive(false);
  }, []);

  const handleDrop = useCallback(
    async (e: ReactDragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // 0007:内部拖拽落到空白 = 取消(不该走文件导入,更不该弹「无文件」
      //   toast)。有效目标是文件夹行 / 面包屑 chip,它们 stopPropagation
      //   自行处理。
      if (latest.current.folders.isInternalDrag(e)) return;
      dragCounterRef.current = 0;
      setDragActive(false);
      // audit 2026-09-14 r7:drop 与 picker 共用 importFiles helper。
      await latest.current.importFiles(e.dataTransfer.files);
    },
    [latest],
  );

  // audit r29 (2026-09-21):a11y H4 — 同步 inert 属性到 dragActive。
  //   dragActive=true → setAttribute('inert', '');false → removeAttribute。
  //   inert 是 boolean attribute,出现即 true,移除即 false(无 'false'
  //   字符串形态)。该 effect 让键盘 user 在 dragenter 期间 Tab 不再 focus
  //   到底层 row(aria-hidden 只对 AT 起效)。
  useEffect(() => {
    const el = latest.current.listContainerRef.current;
    if (!el) return;
    if (dragActive) {
      el.setAttribute('inert', '');
    } else {
      el.removeAttribute('inert');
    }
  }, [dragActive, latest]);

  // r134:wrapper 级 DnD 落点(空白区拖入 = 移入当前文件夹)—— 目标 folder
  //   relPath;仅当 hover 不在任何 drop 目标上时事件冒泡到 wrapper。
  //   全部 gated on isInternalDrag:非内部拖拽(OS 文件)直接放行,让外层
  //   import 链照常跑(它的 dropEffect=copy + dragCounter 计数 + 弹 overlay
  //   都是事件未被 preventDefault 才生效)。不要在 wrapper 内统一
  //   preventDefault 内部 drag —— 那样会吞掉 OS 文件拖入的 dragover 事件,
  //   import overlay 永不上场。
  const handleContainerDragOver = useCallback(
    (e: ReactDragEvent) => {
      if (!latest.current.folders.isInternalDrag(e)) return;
      latest.current.folders.handleTargetDragOver(e, ROOT_DROP_ID);
    },
    [latest],
  );
  const handleContainerDragLeave = useCallback(
    (e: ReactDragEvent) => {
      if (!latest.current.folders.isInternalDrag(e)) return;
      latest.current.folders.handleTargetDragLeave(e, ROOT_DROP_ID);
    },
    [latest],
  );
  const handleContainerDrop = useCallback(
    (e: ReactDragEvent) => {
      if (!latest.current.folders.isInternalDrag(e)) return;
      e.preventDefault();
      e.stopPropagation();
      latest.current.runFolderOp(() => latest.current.folders.handleTargetDrop(e, ROOT_DROP_ID));
    },
    [latest],
  );

  // audit 2026-09-14 r7:键盘可达的导入按钮 —— hidden file picker。
  const triggerFilePicker = useCallback(() => {
    filePickerRef.current?.click();
  }, []);
  const onFilePickerChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files) void latest.current.importFiles(files);
      e.target.value = '';
    },
    [latest],
  );

  return {
    dragActive,
    filePickerRef,
    handleDragOver,
    handleDragEnter,
    handleDragLeave,
    handleDrop,
    handleContainerDragOver,
    handleContainerDragLeave,
    handleContainerDrop,
    triggerFilePicker,
    onFilePickerChange,
  };
}
