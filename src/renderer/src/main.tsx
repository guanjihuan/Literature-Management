import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
// perf(2026-08-22):i18n 改为异步按需加载 — main.tsx 立即触发 initI18n(),
// 与 App 渲染并行。init 完成前 useTranslation() 返回 key(notReadyT);
// startup overlay 覆盖期间完成 init,UI 不闪 raw key。
import { initI18n } from './i18n';
import './styles/globals.css';
// audit C3R89 (2026-08-22):连 main.tsx 全局 last-line-of-defence 也走 createLogger,
// 跟其它 renderer 模块统一前缀 + 接入后续 telemetry hook
import { createLogger } from './lib/logger-client';
// audit 2026-09-06:bootstrap 提前到 main.tsx —— 先拿 settings.language,
// 再 initI18n(initialLang),避免 i18n 硬编码 zh-CN 导致首屏中文闪屏。
// App.tsx 的 bootstrap useEffect 留作幂等兜底(防止 main.tsx 这一步失败时
// renderer 还是没 settings),同步进 settingsStore 让后续 render 拿到值。
// audit-r85:bootstrap 改走 bootstrapOnce 单飞 —— 旧注释宣称的 loaded
//   守卫从不生效(passive effect flush 早于 IPC 往返),每次冷启实际并发
//   两次 bootstrap IPC。单飞后 App 命中同一 promise,rejection 自动清缓存
//   保留「兜底再试」语义,详见 lib/bootstrap.ts 头注。
import { applyBootstrapOnce, bootstrapOnce } from './lib/bootstrap';
import { usePathsStore } from './store/paths';
// audit r29 (2026-09-21):cq H2 — unhandledrejection 走 errMsg fallback 字符串化。
import { errMsg } from './lib/error';

const log = createLogger('main');

/**
 * 启动序列(2026-09-14 改为立即 render + 后台并行 bootstrap/i18n):
 *   1. React 同步 render —— 用户在 ~10ms 看到 TitleBar + StatusBar + StartupOverlay
 *      覆盖层。StartupOverlay 盖住主区,主区文本即便 i18n 没 ready 也不会闪。
 *      chrome 文字在前 ~100-300ms 显示 raw i18n key,i18n ready 后 react-i18next
 *      触发 useTranslation 订阅者自动 re-render 替换为正确翻译(已确认
 *      `react: { useSuspense: false }` 在 i18n 未 ready 时返 key 而非抛 Promise)。
 *   2. bootstrap + initI18n 后台并行 —— bootstrap IPC(~50-200ms) 与 i18n 动态导入
 *      (~100-300ms,加载 i18next + react-i18next + en-US JSON)不再串行阻塞首屏。
 *   3. App.tsx 的 bootstrap effect 与这里共享 bootstrapOnce 单飞 promise
 *      (audit-r85 —— 旧版靠 loaded 布尔去重,但 effect flush 永远早于
 *      IPC 返回,守卫从不生效,实际每次冷启双 IPC)。audit-r87 起结果落地
 *      共用 applyBootstrapOnce 单点,后到的 continuation 零副作用。
 *
 * 取舍:接受 chrome raw key 闪屏 ~100-300ms,换来首屏立即可见。
 */
async function start() {
  // 后台并行 bootstrap + i18n。不 await —— render() 必须立刻发生。
  void (async () => {
    let initialLang: 'zh-CN' | 'en-US' = 'zh-CN';
    try {
      const r = await bootstrapOnce();
      // audit-r87:落地收口 applyBootstrapOnce 单点 —— 与 App.tsx 共享同一
      // 结果时先到者应用、后到者拿 'already-applied' 零副作用(旧两处各自
      // applyBootstrapSettings + setState,pendingLayout 异步清 key → 同帧
      // 双 updateSettings 写)。audit-r80 的 pendingLayout 消费语义不变。
      const outcome = applyBootstrapOnce(r);
      // outcome==='ipc-failed' ⇔ !r.ok(helper 契约);`&& !r.ok` 仅为窄化。
      if (outcome === 'ipc-failed' && !r.ok) {
        log.warn('bootstrap IPC failed during startup', r.message);
        // 标记"已经尝试过";App 的修复路按 outcome 认领 legacy pair,
        // 不读本标记(旧注释宣称 App 靠它跳过 fallback 是假的 —— 快照在
        // await 前捕获,恒 false,详见 App.tsx r87 注)。
        usePathsStore.setState({ loaded: true });
      }
      if (r.ok && r.data.settings?.language) {
        initialLang = r.data.settings.language;
      }
    } catch (err) {
      log.warn('bootstrap IPC threw during startup', err);
      usePathsStore.setState({ loaded: true });
    }
    // audit r30 (2026-09-22):HIGH — initI18n 包进独立 try/catch。之前它在
    //   try/catch 外,locale JSON parse / 动态 import 失败 → reject → 走
    //   window 'unhandledrejection'(下方 line 75-82)只 console.error,没 log context、
    //   没 bootstrap-stage 关联、也没 fallback UI。这里 catch 后 log + 显式兜底
    //   可以由 App.tsx 的 bootstrapStage 'i18n-failed' 分支渲染 localized
    //   error screen(用户感知得到,而不是被 DevTools scrollback 静默吞掉)。
    try {
      await initI18n(initialLang);
    } catch (err) {
      log.warn('initI18n rejected during startup', err);
      // 注意:App.tsx 的 bootstrapStage 还没有 'i18n-failed' 分支接入,这里
      //   只先确保 reject 不冒到 unhandledrejection。下游如果要进一步接
      //   bootstrapStage='i18n-failed' 渲染错误屏,在 App.tsx 加 stage 即可。
    }
  })();

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

// D2-019: renderer 全局 last-line-of-defence
// React ErrorBoundary 只接 render-phase 错误;事件回调 / IPC promise / 异步 microtask 都漏过
//
// audit-r145b (2026-10-19) MED:HMR 守卫 —— 顶层 addEventListener 在 Vite HMR
//   reload 时随 module 重求值,每次都注册一份新 listener,5 次 reload 后同一
//   unhandledrejection 触发 5 个 stale 闭包 → 日志噪音 + telemetry 重复上报。
//   修法:用 window.__rkmsRendererGlobalErrorBound 作 sentinel;模块级 let 在
//   HMR 时归零,无效,必须挂 window。守卫块只放 sentinel 写 + 2 个 listener
//   注册,无其它副作用(HMR else 分支不跑,会丢)。
if (!window.__rkmsRendererGlobalErrorBound) {
  window.__rkmsRendererGlobalErrorBound = true;
  window.addEventListener('error', (e) => {
    log.error(e.error?.message ?? e.message, e.error?.stack);
  });
  window.addEventListener('unhandledrejection', (e) => {
    // audit r29 (2026-09-21):cq H2 — 直接把 reason 喂 console.error,Chromium / Firefox
    //   的 console 会自动展开 Error.stack;不再手动拼接 message+stack(拼接后
    //   console 不再识别为 Error,stack 折叠成普通字符串)。errMsg(err) 作 fallback
    //   字符串,便于 dev 复制粘贴到 issue(没有完整 stack 字符串化仍可读)。
    const reason = e.reason;
    log.error('unhandledrejection:', reason instanceof Error ? reason : errMsg(reason));
  });
}

void start();
