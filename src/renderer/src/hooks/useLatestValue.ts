// useLatestValue:返回的 ref.current 始终是最新一次 render 的 value。
//
// 用法(典型场景):
//   - useEffect / setTimeout / async callback 等**延迟**执行的代码需要读"现在"
//     的最新 prop / state,而不是闭包捕获的值。
//   - 例:MarkdownEditor 异步加载 codemirror 期间,父组件 prop value 已变 →
//     async resolve 后必须读最新值,不能用 useEffect 闭包里的 value。
//
// 与 useEffect 依赖 ref 不变的常见反模式:
//   useEffect(() => {
//     setTimeout(() => doWork(value), 1000);  // ← closure 捕获的 value 可能 stale
//   }, []);
// 正确写法:
//   const latest = useLatestValue(value);
//   useEffect(() => {
//     setTimeout(() => doWork(latest.current), 1000);  // ← 读 ref,永远是最新
//   }, []);
//
// 这是一个 5 行 hook,React community 的标准模式(useEffectEvent / useEvent 是
// RFC 阶段的等价物)。抽出来便于测试,避免在每个 useEffect 里都手写 ref + 赋值。

import { useRef, type MutableRefObject } from 'react';

// 返回 MutableRefObject 而非裸 `{ current: T }` —— 调用方拿到的 .current
// 行为完全一致,类型上则明确表达「这是个可变盒子」。
//
// audit r34 (2026-10-08) **更正一条被实测推翻的说法**:本文件原先写着
// 「返回 MutableRefObject → exhaustive-deps 不会报 missing dep」。**不成立**。
// exhaustive-deps 判断「稳定 ref」靠的是变量是否直接来自 `useRef()` 调用,
// 而**不是**它的类型标注 —— 从自定义 hook(`useLatestValue()`)返回的值它
// 一律当成不稳定值。实测:useListboxRove.ts 三个 `*Ref` 全部被报 missing dep,
// 尽管它们底下就是 useRef、identity 恒定。
//
// 所以调用方必须把 *Ref 显式列进 useEffect 的依赖数组。**运行时零影响**
// (identity 恒定 → effect 不会重挂),纯粹是让依赖关系与 lint 可见的事实对齐;
// 反过来,若将来把实现换成每次新建对象的普通变量,lint 会立刻报出来而不是静默 stale。
export function useLatestValue<T>(value: T): MutableRefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
