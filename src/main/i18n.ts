// 主进程最小化 i18n:menu/window title/dialog/error message 走 settings.language,
// 不引 main 侧 i18next(避免把 react-i18next 拉到主进程,+~80KB)。缺字段回退 zh-CN,
// 未知 key 返回 key 自身(开发期易发现),{name} 占位符 replaceAll 替换。
//
// r165 (2026-10-19):T 字典与 Lang 类型抽到 ./i18n-dict.ts(零上游 import 的叶子),
//   打破 i18n ↔ safe-write 通过 settings/store 的循环依赖(layering.test.ts
//   6. 无循环依赖持续红)。本文件保留:tr / t / safeLang 三个函数,以及
//   暴露 setI18nLangProvider 的注册表入口(safe-write.ts 启动早期调一次,之后
//   其内部 tr() 走用户当前语言)。

import { resolveT, type Lang } from './i18n-dict';
import { getSettings } from './settings/store';
import { setI18nLangProvider } from './utils/safe-write';

export type { Lang };

/** 查表;未知 key 返回 key 自身,缺字段回退 zh-CN,{name} 占位符 replaceAll 替换 */
export function t(key: string, lang: Lang, params?: Record<string, string | number>): string {
  return resolveT(key, lang, params);
}

/** tr(): 自动读 settings.language;settings 未初始化时回退 zh-CN,避免把
 * "Settings not initialized" 的 INTERNAL 错误盖在真正的业务错误上 */
export function tr(key: string, params?: Record<string, string | number>): string {
  return resolveT(key, safeLang(), params);
}

/** 安全取当前 UI 语言。settings 未初始化(bootstrap 顶层 / startup catch /
 * app.activate 早于 bootstrap)时回退 zh-CN —— 避免 getSettings() 的 INTERNAL
 * 抛错把真业务错盖掉 */
export function safeLang(): Lang {
  try {
    return getSettings().language ?? 'zh-CN';
  } catch {
    return 'zh-CN';
  }
}

/**
 * r165 分层硬不变式补救:把 safeLang() 注册到 safe-write 的 langProvider 槽。
 *
 *   - 必须在 settings 已能读取(bootstrap 之后)调一次;之后 safe-write.ts
 *     内部抛 AppError 走的 tr() 解析就用当前用户语言。
 *   - 不调时回退 zh-CN(模块加载序极端情况下,例如 settings 还在 init 时
 *     触发了磁盘写入)。
 *   - 由 main/index.ts 在 import 顶层做一次注入(无运行期分支)。
 *
 *   把这一步独立成 export 函数的目的:让 settings 加载 + i18n 注册这一对
 *   副作用从 import 边里被「观察得到」,而不是散落在模块加载的隐式契约里。
 *   测试可在 i18n 模块加载后调一次确认 safeLang() 已挂上。
 */
export function registerI18nForSafeWrite(): void {
  setI18nLangProvider(safeLang);
}
