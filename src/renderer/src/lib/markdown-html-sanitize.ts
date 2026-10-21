// markdown-it 渲染后 HTML 净化 — 阻止 linkify/javascript: scheme XSS
//
// 背景(2026-08-22 audit):markdown-it 的 `linkify: true` 会把裸 URL(包括 `javascript:`
// scheme)自动转成 `<a href="javascript:...">`。markdown-it 自带 `html: false` 只挡裸
// `<script>` 标签,不挡 linkify 自动产出的链接 scheme。然后 `dangerouslySetInnerHTML`
// 把这个 a 标签塞进 DOM → 用户点击 → 在 renderer 进程执行 JS → 通过 `window.api` 间接
// 调用 IPC 暴露的所有方法(RCE on user data)。
//
// 修复:在 markdown-it 渲染输出后,对所有 `<a href="...">` 做 scheme 白名单过滤。
// 只允许 http(s) / mailto / 内部 #anchor / wiki 链接(data-wiki-id 标记)通过,
// 其它 scheme(javascript: / data:text/html / vbscript: / file:) 一律剥掉。
//
// 实现策略:正则匹配 `<a ... href="..." ...>` 与 `<a ... href='...' ...>`,
// 拿到 href 后用 URL 解析判断 protocol;危险 scheme 改成 `about:blank` 或直接剥离 href。
// 不引入 DOMPurify(避免 +20KB 主 chunk),纯字符串操作够用(应用只产出简单 a 标签)。

// 白名单用 scheme 形式(都带尾冒号)。注意:'about:' 而非 'about:blank' —
// 所有 about: URL 都是 browser-sandboxed,不会执行注入的 JS,统一放行更简单一致。
// 之前常量写 'about:blank' 是 bug:正则提取 scheme 得到 'about:'(URL 解析器把
// 'about:blank' 当成 opaque URL,protocol='about:',pathname='blank'),白名单
// .has('about:') 永远 false → 所有 about: 链接被误判为不安全。
const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'about:']);

/**
 * 检查 href 是否安全 — 允许 http/https/mailto/about/相对 URL/内部锚点/空 href。
 * 危险 scheme (javascript:, data:text/html, vbscript:, file:) 返回 false。
 */
export function isSafeHref(href: string): boolean {
  if (!href) return true;
  // audit-r79:WHATWG URL 预解析在 scheme 判定前**全局删除**所有 tab/LF/CR,
  // 所以 `java\tscript:alert(1)` 在浏览器里就是 javascript: 执行(node URL
  // 实证 protocol='javascript:')。旧实现只 trim 首尾 → 分裂 scheme 不匹配
  // 判定正则 → 被当相对路径放行。先删控制符再进一切判定。
  //
  // audit-r197:控制符清理从「只删 \t\n\r」扩到「删全部 C0 控制符 + 空格」。
  //   WHATWG URL 解析器会先剥掉**前导**的所有 C0 控制符(U+0000–U+0020),
  //   所以 '\x01javascript:alert(1)' 在浏览器里的 protocol 就是 'javascript:'
  //   (node URL 实证)⇒ 旧实现(只删 \t\n\r)判成安全 ⇒ 一旦有第二个 caller
  //   就是真的 XSS。本函数当前无 production caller,但它是给未来 caller
  //   用的安全闸 —— 闸门必须是关着的。
  // eslint-disable-next-line no-control-regex -- 就是要剥 C0 控制符(见上)
  const trimmed = href.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  // 任何看起来是 scheme 的 href(无论 x: 或 x://) 都进 URL 解析器核 scheme。
  // 相对路径 / 锚点(/、./、# 开头)不进 — 上面 return 那条只是相对路径的入口。
  // audit C2R17 (2026-08-22):原正则 `^([./#]|mailto:|[a-z]+:\/\/)` 漏了
  // 非 // 形式的 scheme (about:blank, tel:, geo: 等),导致 about: 链接
  // 永远走到下面那个 `return !/[a-z]+:/` 而被误判为不安全。改为通用
  // scheme 正则后,所有带 scheme 的 href 走统一 ALLOWED_SCHEMES 检查。
  if (/^([./#]|[a-z][a-z0-9+.-]*:)/i.test(trimmed)) {
    try {
      // URL 解析本身是验证手段(异常 → catch 处理);返回值未用,故不接
      new URL(trimmed, 'http://placeholder.invalid/');
      const m = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
      if (!m) return true; // 只有 [./#] 前缀,没 scheme → 相对路径/锚点 → 安全
      const scheme = m[1].toLowerCase() + ':';
      return ALLOWED_SCHEMES.has(scheme);
    } catch {
      // URL 解析失败(罕见)— 保守放行锚点/相对,拒绝其它
      return !/^[a-z][a-z0-9+.-]*:/i.test(trimmed);
    }
  }
  // 走到这里意味着 trimmed 不以 [./#] 也不以 scheme 开头 — 不可能
  // (上面正则已覆盖),但保留作 fallback。
  return !/^[a-z][a-z0-9+.-]*:/i.test(trimmed);
}

/**
 * 净化 markdown-it 渲染的 HTML:
 *   1. 剥掉 on* 事件处理属性(onclick/onerror/onload/onmouseover 等)——
 *      markdown-it 不会主动产出,但未来插件(mermaid / chart / 自定义渲染)
 *      一旦产出 <svg onload=...> / <img onerror=...> 就会被静默通过。
 *   2. 把 `<a href>` 中的危险 scheme 替换为 `about:blank`。
 *   3. 剥掉 style 属性 —— `style="background:url(javascript:...)"` 是经典 IE 旧
 *      漏洞,现代浏览器虽然在 Chromium 内核上不再执行,但仍有「CSS 注入 / data:
 *      exfiltration / 用户信息泄露」场景(content-visibility / @import 远程加载
 *      等),与 on* 一并剥除,简单一致。
 *
 * 处理双引号 / 单引号 / 无引号三种 attr 写法,以及 `<a>` 上多个 attr 的乱序。
 *
 * audit 2026-08-25:加 event handler 剥除 —— 原 sanitize 只审 `<a href>` scheme,
 * 是 file 注释里说的"load-bearing invariant"——若未来 markdown-it 插件引入
 * `<svg onload=...>` / <img onerror=javascript:...>,会无声通过 dangerouslySetInnerHTML。
 * on* 剥除是 defense-in-depth,与 isSafeHref 配合形成第二层防线。
 *
 * audit r35 (2026-10-08):SEC1+SEC2 —— 加 style 属性剥除。背景同上;markdown-it
 *   默认不产 style,但同 on* 的论证:未来插件 / 自定义渲染一旦产出含
 *   `style="background:url(javascript:...)"` 的标签会无声通过。style 在笔记
 *   渲染里**没有合法用途**(markdown-it → DOM 的纯文本产出不需要 inline CSS),
 *   一律剥除即可,不需要白名单。
 */
/**
 * 标签内属性匹配 —— 名称 + 可选的 `=值`(双引号 / 单引号 / 无引号三种写法)。
 *
 * 名称字符类排除空白 / 引号 / `<` / `>` / `/` / `=`:名字里出现这些就不是
 * 合法属性名,也不会把「值」误当成下一个属性。
 */
const TAG_ATTR_RE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'`=<>]+))?/g;

/** 标签匹配 —— 捕获标签名与属性串(属性值里的引号成对,先于 `>` 消费)。 */
const TAG_RE = /<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>])*)>/g;

/**
 * 剥掉标签内的 on* 事件属性与 style 属性。
 *
 * r197:只处理**属性串内部**,不碰文本节点 —— 见 sanitizeMarkdownHtml 的头注。
 */
function stripUnsafeAttrs(attrs: string): string {
  let out = '';
  let last = 0;
  TAG_ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_ATTR_RE.exec(attrs)) !== null) {
    const name = m[1];
    const unsafe = /^on[a-z]+$/i.test(name) || /^style$/i.test(name);
    if (!unsafe) continue;
    // 边界检查:属性名前必须是空白 / 引号 / 属性串开头。
    // (HTML5 允许 `<a href="x"onclick="y">` 闭引号后直接接下一个属性)
    const before = m.index > 0 ? (attrs[m.index - 1] ?? ' ') : ' ';
    if (before !== ' ' && before !== '\t' && before !== '\n' && before !== '\r') {
      if (before !== '"' && before !== "'") continue;
    }
    // 连带吃掉属性**前面**的空白(属性之间靠空白分隔,吃掉才不会留双空格);
    // 只吃空白,不吃引号 —— 闭引号属于**上一个**属性,动了就破坏 HTML。
    let start = m.index;
    while (start > 0 && /\s/.test(attrs[start - 1] ?? '')) start--;
    out += attrs.slice(last, start);
    last = m.index + m[0].length;
  }
  out += attrs.slice(last);
  return out;
}

export function sanitizeMarkdownHtml(html: string): string {
  if (!html) return html;
  // ── r197:从「整串正则」改成「逐标签处理」────────────────────────────
  //
  // 旧实现(2026-08-22 ~ r79)对**整串 HTML** 跑两条正则:
  //   /(?<=\s|>|["'])on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi
  //   /(?<=\s|>|["'])style\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi
  //
  // 它们**不区分标签内外**。而 markdown-it 配 `html: false` ⇒ 用户正文里
  // 的 '<' 会被转义成 '&lt;' ⇒ 正文里的 "onclick=alert(1)" 落在**文本节点**
  // 里,却因为紧跟在 `>`(如 `<code>onclick=alert(1)</code>`)或空白之后
  // 命中了 lookbehind ⇒ **被当成事件属性删掉**。
  //
  //   用户可见症状:笔记里的代码片段 / 事件名被**凭空清空**;
  //   CodeReader 更糟 —— hljs 自己的 `<span class="hljs-attr">` 与用户代码里
  //   的 "style = {" 撞上,style 正则把 hljs 的标签吃掉 ⇒ 高亮结构被破坏。
  //
  // 修法:只在**标签内部**剥属性(逐标签走),文本节点原样保留。
  // 标签内的 on* / style 剥除(defense-in-depth)与 <a href> scheme 白名单
  // 全部保留 —— 收窄的只是「作用范围」,不是「强度」。
  const out = html.replace(
    TAG_RE,
    (full: string, tagName: string, rawAttrs: string): string => {
      const attrs = stripUnsafeAttrs(rawAttrs);
      if (tagName.toLowerCase() !== 'a') return `<${tagName}${attrs}>`;
      // 2) `<a href>` scheme 白名单 — 危险 scheme(javascript: / data:text/html 等)替换为 about:blank
      const hrefMatch = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
      if (!hrefMatch) return `<${tagName}${attrs}>`;
      const href = (hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? '').trim();
      if (isSafeHref(href)) return `<${tagName}${attrs}>`;
      const safeAttrs = attrs.replace(
        /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i,
        'href="about:blank"',
      );
      return `<${tagName}${safeAttrs}>`;
    },
  );
  return out;
}
