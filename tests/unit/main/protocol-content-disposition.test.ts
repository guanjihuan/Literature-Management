// tests/unit/main/protocol-content-disposition.test.ts
//
// 守卫:rkms:// handler 的 Content-Disposition 必须对**任意文件名字符**安全。
//
// 为什么要有这个守卫(2026-10-20 报障实证):
//   文献「2023 - Huang et al. - ... 1T’ transition metal dichalcogenides.pdf」
//   在应用内打不开(Reader 落「打开失败」错误页),其它 PDF 正常。
//   文件名里的 ’ 是 U+2019(排版右单引号,> U+00FF)。Fetch 规范的 header
//   value 必须是 ByteString(每字符 ≤ U+00FF),旧实现把文件名裸拼进
//   `inline; filename="${baseName}"` ⇒ Headers.set 当场 throw
//   TypeError「Cannot convert argument to a ByteString」⇒ 冒到 handler
//   外层 catch 返 500 ⇒ Reader 探测 fetch 拿 500 ⇒ IO_ERROR 错误页。
//   同库的「2020 - Yu et al. - ... Landauer–Büttiker ...」(– = U+2013)
//   同一根因。任何非拉丁-1 文件名(中文论文.pdf 等)全灭。
//   node 实证:Headers().set('Content-Disposition', '... 1T’ ...')
//   ⇒ TypeError: character ... has a value of 8217 which is greater than 255。
//
// 修法(RFC 6266 / RFC 5987):
//   - filename="..." 兜底段只放 ASCII 可打印字符,越界一律折成 '_'
//   - 真实文件名走 filename*=UTF-8''<percent-encoded>,字符集无损
//
// 本测守三件事:
//   A. contentDispositionInline 对 U+2019 / 中文 / 引号 / 反斜杠文件名产出
//      合法值:纯 ASCII(ByteString 安全)、可被 Headers.set 接受(真实调用
//      Node 全局 Headers,与 handler 运行同款 ByteString 校验)、
//      filename* 可无损解回原文件名。
//   B. 产出格式符合 RFC 6266:action 是 inline,两段齐全。
//   C. source-text 锁:protocol.ts 不再裸拼 `filename="${` 模板(防回退)。

import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { contentDispositionInline } from '@main/utils/content-disposition';

// 与 handler 运行时同款校验:Node 全局 Headers 实现 ByteString 转换,
// 值里有 > U+00FF 字符会 throw(这正是原 bug 的触发器)。
function headersAccept(value: string): boolean {
  try {
    new Headers().set('Content-Disposition', value);
    return true;
  } catch {
    return false;
  }
}

function extFilenameOf(value: string): string | null {
  const m = /filename\*=UTF-8''([^;]+)/.exec(value);
  return m ? decodeURIComponent(m[1]) : null;
}

describe('contentDispositionInline', () => {
  it('U+2019 排版引号文件名:ByteString 安全且无损往返', () => {
    const name =
      '2023 - Huang et al. - Tight-binding model and quantum transport with disorder for 1T’ transition metal dichalcogenides.pdf';
    const v = contentDispositionInline(name);
    // ByteString 安全(原 bug 直接 throw)
    expect(headersAccept(v)).toBe(true);
    // 纯 ASCII
    expect([...v].every((c) => c.charCodeAt(0) <= 0x7f)).toBe(true);
    // filename* 无损解回
    expect(extFilenameOf(v)).toBe(name);
    // 兜底段不含原字符
    const fallback = /filename="([^"]*)"/.exec(v)?.[1] ?? '';
    expect(fallback).not.toContain('’');
  });

  it('U+2013 / U+00FC 混合文件名(Landauer–Büttiker):同样无损', () => {
    const name =
      '2020 - Yu et al. - Chebyshev polynomial method to Landauer–Büttiker formula of quantum transport in nanostructures.pdf';
    const v = contentDispositionInline(name);
    expect(headersAccept(v)).toBe(true);
    expect(extFilenameOf(v)).toBe(name);
  });

  it('中文文件名:全量走 filename*,兜底段不抛', () => {
    const name = '拓扑绝缘体综述.pdf';
    const v = contentDispositionInline(name);
    expect(headersAccept(v)).toBe(true);
    expect(extFilenameOf(v)).toBe(name);
  });

  it('引号 / 反斜杠 / 控制字符:兜底段被清洗,不产生非法 quoted-string', () => {
    const name = 'weird"quo\\te\r\nname.pdf';
    const v = contentDispositionInline(name);
    expect(headersAccept(v)).toBe(true);
    // 兜底段里不允许出现未转义引号(会截断 quoted-string)
    const fallback = /filename="([^"]*)"/.exec(v)?.[1] ?? '';
    expect(fallback).not.toMatch(/["\\\r\n]/);
    expect(extFilenameOf(v)).toBe(name);
  });

  it('普通 ASCII 文件名:两段都在,值原样', () => {
    const v = contentDispositionInline('plain paper.pdf');
    expect(v.startsWith('inline; ')).toBe(true);
    expect(v).toContain('filename="plain paper.pdf"');
    expect(extFilenameOf(v)).toBe('plain paper.pdf');
  });

  it('source-text 锁:protocol.ts 不再裸拼 filename="${ 模板', () => {
    const src = readFileSync(join(process.cwd(), 'src/main/protocol.ts'), 'utf-8');
    // 旧形态:`inline; filename="${baseName...}"` —— 裸拼 = ByteString throw 回退口
    expect(src).not.toContain('filename="${');
    expect(src).toContain('contentDispositionInline');
  });
});
