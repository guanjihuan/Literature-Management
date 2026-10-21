// tests/unit/renderer/components/reader-decode-memo.test.tsx
//
// 守 r247「Reader 每次重渲都重解一遍整个文件」的修复契约 ——
//   文本类文件的 UTF-8 解码必须**只在内容真的变了**时做一次。
//
// 背景(用户诉求「使用流畅,不要有卡顿」):
//   旧实现在**每次 render** 都执行 `TEXT_DECODER.decode(state.data)` ——
//   这是 O(字节数) 的 UTF-8 解码 + 一份新字符串分配。state.data 本身是
//   稳定引用,内容没变却在每次重渲时重解一遍:
//     1MB 的 txt/md = 每次 render 造一个 1M 字符的字符串。
//   Reader 会在窗口 resize / 重试 nonce / 主题切换 / 父级任何 state 变化
//   时重渲 ⇒「拖着窗口边缘抖一下」就能把主线程塞满解码。
//
// 修法:useMemo([ext, state.data])—— ext / data 都没变 ⇒ 不重解。
//
// 本测锁:① 首屏解码一次;② 父级用**新对象**重渲(内容没变)不再解码;
//   ③ 换文件(内容真变了)必须再解一次(短路不能把新文件吃掉)。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

const readFileForReader = vi.fn();
vi.mock('../../../../src/renderer/src/lib/api', () => ({
  api: { readFileForReader: (...args: unknown[]) => readFileForReader(...args) },
  unwrap: (r: unknown) => r,
  IpcError: class IpcError extends Error {},
  asIpcError: () => null,
  hasApi: () => true,
}));

import { Reader } from '../../../../src/renderer/src/components/reader/Reader';

const FILE = {
  id: 'f1',
  extension: '.txt',
  absPath: '/tmp/rkms-perf/a.txt',
  filename: 'a.txt',
};

function bytesOf(text: string): Uint8Array {
  // jsdom 陷阱(实测):`new TextEncoder().encode()` 返回的是**另一个 realm** 的
  //   Uint8Array —— `b instanceof Uint8Array === false` ⇒ Reader 的
  //   `rawData instanceof Uint8Array` 守卫会走「文件格式损坏」分支。
  //   这里用本 realm 的构造器直接造字节(手写 UTF-8 编码,不走 TextEncoder)。
  const enc = encodeURIComponent(text).replace(
    /%([0-9A-F]{2})/g,
    (_m, h: string) => String.fromCharCode(parseInt(h, 16)),
  );
  const out = new Uint8Array(enc.length);
  for (let i = 0; i < enc.length; i += 1) out[i] = enc.charCodeAt(i);
  return out;
}

describe('perf r247:Reader 文本解码必须 memo 化', () => {
  beforeEach(() => {
    readFileForReader.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('首屏解码一次;父级用新对象重渲(内容未变)不再解码', async () => {
    const decodeSpy = vi.spyOn(TextDecoder.prototype, 'decode');
    readFileForReader.mockResolvedValue({ ok: true, data: { data: bytesOf('hello 世界') } });

    const { container, rerender } = render(<Reader file={{ ...FILE }} />);

    // 正文渲染出来 ⇒ 解码确实发生了
    await waitFor(() => expect(container.textContent).toContain('hello 世界'));
    expect(decodeSpy, '首屏只应解码一次').toHaveBeenCalledTimes(1);

    // 父级重渲,但 file 是**新对象**(内容一模一样)—— 模拟 resize / 主题切换等
    const before = decodeSpy.mock.calls.length;
    rerender(<Reader file={{ ...FILE }} />);
    expect(decodeSpy.mock.calls.length, '内容没变就不该再解一遍').toBe(before);
    expect(decodeSpy).toHaveBeenCalledTimes(1);
  });

  it('换文件(内容真变了)⇒ 必须再解一次', async () => {
    const decodeSpy = vi.spyOn(TextDecoder.prototype, 'decode');
    readFileForReader.mockResolvedValueOnce({ ok: true, data: { data: bytesOf('第一份') } });
    const { container, rerender } = render(<Reader file={{ ...FILE }} />);
    await waitFor(() => expect(container.textContent).toContain('第一份'));
    expect(decodeSpy).toHaveBeenCalledTimes(1);

    readFileForReader.mockResolvedValueOnce({ ok: true, data: { data: bytesOf('第二份') } });
    rerender(
      <Reader file={{ ...FILE, id: 'f2', absPath: '/tmp/rkms-perf/b.txt', filename: 'b.txt' }} />,
    );
    await waitFor(() => expect(container.textContent).toContain('第二份'));
    expect(decodeSpy, '新文件必须重新解码').toHaveBeenCalledTimes(2);
  });
});
