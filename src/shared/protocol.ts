// src/shared/protocol.ts
//
// 跨 main + renderer 共享的自定义协议常量。renderer 拼 URL 用
// (src/renderer/src/utils/file-url.ts),main 注册 privileged scheme +
// handler 用 (src/main/protocol.ts)。两边必须用同一个字符串字面量,
// 不然 iframe 发 rkms:// 请求、main 只 handle 别名就直接 404。
//
// 单一可信源原则:其它地方要提到这个 scheme 名一律从这里 import,
// 不要在本文件以外硬编码 'rkms' 字符串。

/** 主进程注册、renderer 拼 URL 用的自定义协议名 */
export const RKMS_SCHEME = 'rkms';
