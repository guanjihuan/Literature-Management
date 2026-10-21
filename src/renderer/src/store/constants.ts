// store 层的叶子常量模块
//
// audit 2026-10-06(架构):这个文件存在的唯一理由是**断开一个循环依赖**。
//
// 改动前 `store/workspace.ts` 与 `store/settings.ts` 互相 import:
//   - workspace.ts → `import { useSettingsStore } from './settings'`(值导入)
//   - settings.ts  → `import { PENDING_LAYOUT_LS_KEY } from './workspace'`
// 起因是一个字符串常量住在 workspace.ts 里,而 settings.ts 的
// applyPendingLayoutFallback 也要读它。两边都是**运行时值**导入(不是
// type-only),于是构成 ESM 环 —— 靠 live binding 的时序侥幸不死,但导入顺序
// 一变就可能是 `undefined`。
//
// 而 `docs/architecture.md` 的分层不变式表白纸黑字写着「`src/` 内部无循环
// 依赖 · 0 环」,这条自述当时是**假的**:仓库里没有任何脚本或测试执行这项核对,
// 所以它一直绿不到任何人的眼睛里。
//
// 修法:把两处共用的常量抽到这个零 import 的叶子模块,环随之消失。
// 判定「它是不是常量」的标准很朴素 —— 它被两个 store 同时需要,而它们
// 互相 import;那就属于第三个东西,不属于任何一方。
//
// ⚠️ 新增 store 常量请放这里,别再放进某个 store 文件:放进 store 就等于
// 给其它 store 加了一条跨文件依赖边,而 store 之间本应只经 dispatcher/actions
// 通信(见 command/registry.ts 与 docs/architecture.md;原引用的
// docs/STORES.md 已随 docs 大下线删除,audit-r76 改指)。

/**
 * workspaceLayout 的 localStorage 兜底 key。
 *
 * flushPendingWorkspaceLayout(workspace.ts)写,applyPendingLayoutFallback
 * (settings.ts)读 —— 两侧 hydrate 时机的先后不确定,故必须共用同一个常量,
 * 避免字符串漂移导致「写进去读不出来」。
 *
 * `.v1` 后缀是格式版本号:结构不兼容变更时换新 key,不要就地改写,
 * 否则旧版本残留的 JSON 会被新代码按错误的形状解析。
 */
export const PENDING_LAYOUT_LS_KEY = 'workspace.pendingLayout.v1';
