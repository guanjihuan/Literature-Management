// 渲染层 i18n 初始化
//
// perf(2026-08-22):i18next 主体 (~80KB minified) + react-i18next + en-US locale JSON
// 改为动态 import — 首屏 chunk 不带 i18n 引擎,只在 main.tsx 启动时一次性并行加载。
// zh-CN locale 内联保留(它是 fallbackLng,首屏若用户切语言前还是显示中文;
// 把它做成 async 会导致首帧 key 闪烁)。zh-CN JSON 自身仅 ~5KB minified,影响小。
//
// 关键设计:
//   1) zh-CN JSON 同步 import;i18next + react-i18next + en-US JSON 异步按需加载
//   2) fallback = 'zh-CN' — 默认语言就是 zh-CN,缺翻译时无视觉跳变
//   3) 切换语言由 App.tsx 的 useEffect 触发 initI18n().changeLanguage(...)
//   4) react-i18next 的 useTranslation() 在 i18next 尚未就绪时返回 notReadyT
//      (返回 key 本身),init 完成后通过 subscribe 自动 re-render
//
// 主进程类型约束: src/shared/types.ts: AppSettings.language = 'zh-CN' | 'en-US'
// 新增语言: 在 locales/ 加 JSON + 在下方 resources 注册 + 在 settings.language 联合类型加分支
import zhCN from './locales/zh-CN.json';
import type { AppSettings } from '@shared/types';

type Resource = typeof zhCN;
type Lang = NonNullable<AppSettings['language']>;

// 仅声明 i18n 引擎对外的最小 API,避免主 chunk 出现 i18next 完整类型
interface I18nInstance {
  changeLanguage: (lng: string) => Promise<unknown>;
  language: string;
  /**
   * audit round 14 (2026-09-15):I18N-RTL — 从 locale JSON 的 `_meta.rtl` 取
   * 真实的 RTL 标记,作为 App.tsx 同步 `<html dir>` 的唯一来源。比硬编码
   * `lang.startsWith('ar' | 'he' | 'fa' | 'ur')` 更可靠 ——
   *   - locale 文件是 RTL 决策的 canonical 位置,新增语言无需再改 App.tsx
   *   - `yi` (Yiddish)/ `dv` (Dhivehi) 等 RTL 语言不会漏配
   *   - `_meta` 不参与 i18n 翻译,在 `translation` namespace 顶层,getResource
   *     拿原始对象即可
   */
  getRtl: (lng?: string) => boolean;
}

let instance: I18nInstance | null = null;
let initPromise: Promise<I18nInstance> | null = null;

/**
 * 异步初始化 i18n。
 * 首次调用会并行拉 i18next + react-i18next + en-US locale,后续调用复用同一 promise。
 * App.tsx 在启动期调一次(配合 startup overlay 覆盖,UI 不会闪 raw key)。
 *
 * @param initialLang  启动时使用的语言 —— 来自 settings.language。
 *                    不传则 fallback 'zh-CN'(旧 settings.json 无 language 字段 / 测试 setup 等场景)。
 *                    传了之后 i18next 直接以该语言初始化,首屏渲染就是正确语种,
 *                    不需要后续 changeLanguage 二次切换造成的中文闪屏。
 */
export function initI18n(initialLang?: Lang): Promise<I18nInstance> {
  if (instance) return Promise.resolve(instance);
  if (initPromise) return initPromise;
  const p = (async () => {
    // 并行拉 3 个模块;i18next 必须在 initReactI18next 之前加载,
    // 但二者是独立的动态 import,顺序由 JS engine 保证
    const [{ default: i18n }, { initReactI18next }, { default: enUS }] = await Promise.all([
      import('i18next'),
      import('react-i18next'),
      import('./locales/en-US.json'),
    ]);
    await i18n.use(initReactI18next).init({
      resources: {
        'zh-CN': { translation: zhCN },
        'en-US': { translation: enUS as Resource },
      },
      // audit 2026-09-06:用 settings.language 初始化 i18next,避免首屏 zh-CN 闪屏。
      // settings 没拿到时(老 settings.json 缺字段 / 测试)fallback 'zh-CN',
      // 与原行为完全一致。
      lng: initialLang ?? 'zh-CN',
      fallbackLng: 'zh-CN',
      // 关闭 console warn: zh-CN 是源语言,key 不存在时是开发者错误不是用户问题
      // 但保留 missingKey 报告便于开发期发现 (e.g. typo)
      // 改成 true 等价关掉,因为本项目 key 维护纪律是 commit 时校验
      saveMissing: false,
      interpolation: {
        escapeValue: false, // React 已经 escape
        // i18next 默认 {{var}},本项目沿用 mustache 风格的 {var} 短语法,更紧凑易读
        prefix: '{',
        suffix: '}',
      },
      // react-i18next 自己的 suspense = false(我们异步 import,但 useSuspense=false
      // 保证组件 mount 时拿到的是 notReadyT 而不是抛 Promise)
      react: { useSuspense: false },
    });
    // audit C3R55 (2026-08-22):简化 `as unknown as` → 单层 `as`。
    // I18nInstance 是 i18next instance 的**子集**(只声明 changeLanguage + language),
    // 结构上完全兼容。`as unknown as` 是 C3R28 标记的"跨边界 JSON/库/不相关"
    // idiom —— 此处 i18next instance 与 I18nInstance 同 module 内 subtype 关系,
    // 单层 cast 已足够。TypeScript 编译通过验证兼容性。
    // audit round 14 (2026-09-15):I18N-RTL — 先 cast 再注入 getRtl helper。
    //   i18next instance 与 I18nInstance 结构兼容,但 cast 前 i18n 实例
    //   还没有 getRtl 字段(下面才注入),所以先 cast,然后立即在返回前
    //   给 instance 加 getRtl。调用方拿到的是完整的 I18nInstance。
    instance = i18n as unknown as I18nInstance;
    instance.getRtl = (lng?: string): boolean => {
      const target = lng ?? i18n.language;
      const meta = i18n.getResource(target, 'translation', '_meta') as
        { rtl?: unknown } | undefined;
      return Boolean(meta?.rtl);
    };
    return instance;
  })();
  // audit-r76 (2026-10-17):失败允许重试 —— 旧实现把 rejected promise 永久
  //   缓存在 initPromise,任何后续 initI18n() 都拿到同一个 rejection:一次
  //   瞬时 chunk-load 失败(弱网 / 部署版本错位)= i18n 整会话死亡,UI 永远
  //   显示 raw key。失败时清缓存,下次调用重新走完整初始化;rejection 本身
  //   照常透传给本次调用方(不清除对调用者的错误信号)。shortcuts.ts
  //   registerCommands / ensureRegistered 同款复位模式。
  p.catch(() => {
    if (initPromise === p) initPromise = null;
  });
  initPromise = p;
  return initPromise;
}

// audit C3R22 (2026-08-22):删 getI18n() — 零调用方。实际用法是
// `initI18n().then(i => i.changeLanguage(...))` 从 promise 拿实例,
// 不需要单独的 getter。

// audit-r138:删 `export type { Resource }` re-export。Resource = typeof zhCN
//   在本文件私有使用(第 66 行 enUS as Resource),0 外部 caller。
//   上游 src/shared/types.ts:82 的同名 Resource = NoteResource | LiteratureResource
//   跨仓广用,会"喂活" dead-export-guard 的 re-export 名字解析,让本条
//   真正的死 re-export 跨 33 轮没被护栏抓到。需要 Resource 类型直接 import
//   自 shared/types,不要从 i18n/index 二次绕道。
