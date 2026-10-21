// Content-Disposition 头构造(rkms:// protocol handler 用)。
//
// 为什么必须独立成纯函数(2026-10-20 报障实证):
//   Fetch 规范要求 header value 是 ByteString —— 每字符 ≤ U+00FF,
//   Headers.set 遇到越界字符当场 throw TypeError
//   「Cannot convert argument to a ByteString」。
//   文件名带 U+2019(’ 排版右单引号)/ U+2013(–)/ 中文 时,
//   旧实现 `inline; filename="${baseName}"` 直接炸,handler 外层 catch
//   返 500 ⇒ Reader 探测 fetch 拿 500 ⇒ 「打开失败」错误页。
//   (实证:node REPL 里 Headers().set('Content-Disposition', '... 1T’ ...')
//    ⇒ TypeError: value of 8217 which is greater than 255。)
//
// 修法(RFC 6266 + RFC 5987):
//   - filename="..." 兜底段:只放 ASCII 可打印字符,引号/反斜杠/控制符/
//     非 ASCII 一律折成 '_' —— 这段只是给老旧 client 的降级展示;
//   - filename*=UTF-8''<percent-encoded>:真实文件名的无损载体,
//     现代 client(Chromium)优先取它。
//
// 行为契约由 tests/unit/main/protocol-content-disposition.test.ts 锁定。

// RFC 5987 attr-char 以外的字符都要百分号编码。
// encodeURIComponent 不编码 ~!*()' —— 其中 ' ( ) * 不在 attr-char 集合,
// 必须补编;! 合法,保留。
function encodeRFC5987Value(str: string): string {
  return encodeURIComponent(str).replace(
    /['()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/** 构造 `inline` 型 Content-Disposition,对任意文件名字符 ByteString 安全。 */
export function contentDispositionInline(filename: string): string {
  // 兜底段清洗:quoted-string 里 `"` `\` 非法(截断/转义歧义),
  // 控制符与非 ASCII 超出 ByteString / 可打印范围,统一折 '_'
  // eslint-disable-next-line no-control-regex -- 刻意匹配控制符:它们正是要清洗的对象
  const fallback = filename.replace(/["\\\r\n\x00-\x1f\x7f-\u{10FFFF}]/gu, '_') || 'file';
  return `inline; filename="${fallback}"; filename*=UTF-8''${encodeRFC5987Value(filename)}`;
}
