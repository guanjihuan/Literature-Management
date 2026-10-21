// 把 unknown err 翻译成可读字符串。
//
// audit C3R46 (2026-08-22):renderer 之前没有 errMsg helper,30+ 处直接用
// `err instanceof Error ? err.message : String(err)` 重复片段。还有 4 处更危险的
// 直接 `.message` 访问(`.catch(err => ...)` 里 err 是 unknown,throw string/null
// 时 .message 返回 undefined 让 toast 显示 "打开失败: undefined",或 throw null 时直接
// TypeError)。
//
// audit-r217:本 helper 此前镜像的是 main 版 r124 **修复前**的旧口径 ——
// `String(Object.create(null))` 在 V8 直接 TypeError,catch 块里的"翻译官"
// 自己抛错会把真错盖掉。现与 main 共用 @shared/display-string 的同一份
// toDisplayString(降级链 String → Object.prototype.toString.call → 常量),
// 永不 throw。renderer 不能 import main/,shared/ 是两侧唯一合法的公共层。
//
// audit-r229:errMsg 本体已下沉到 @shared/display-string —— 它此前与
//   main/utils/error.ts 的实现**逐字相同**(r217 只下沉了底座 toDisplayString,
//   外层包装留成孪生,典型「修一半」)。本文件保留 re-export,renderer 域
//   既有 import 路径('../../lib/error')一行不改。
//
// 用法(2026-08-22 audit C3R75 之后统一走 i18n key,不硬编码中文):
//   import { useTranslation } from 'react-i18next';
//   import { errMsg } from '../../lib/error';
//   const { t } = useTranslation();
//   promise.catch((err) =>
//     toast.show({ type: 'error', message: t('toast.openFailed', { msg: errMsg(err) }) }),
//   );
export { errMsg } from '@shared/display-string';
