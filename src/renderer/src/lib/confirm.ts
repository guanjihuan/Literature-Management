// 命令式 ConfirmDialog 桥接 — Promise 风格
//
// 用法:
//   const ok = await confirm({ title: '关闭未保存笔记?', danger: true });
//   if (!ok) return;
//
// 与 prompt() 同模式,zustand 单例 -> ConfirmHost 单例渲染。
//
// audit-r206 (2026-10-20):从 components/common/useConfirm.ts **搬到 lib/**。
//   搬的理由:本文件里没有一行 JSX —— 它是「zustand store + 命令式入口」,
//   跟 lib/toast.tsx(toast store + 宿主在 components/toast)同类,放在
//   components/ 下是**层级倒挂**的前兆:hooks/useDiskFolderSidebar.ts 要用它
//   就得从 hooks 反向 import components/*(renderer 内部少见的反向依赖;
//   同类问题 r35 在 store→components 上修过一次)。搬到 lib/ 后依赖方向
//   变成 components→lib→(无上层),单向。
//   React 渲染宿主仍在 components/common/ConfirmHost.tsx(它才有 JSX)。
import { create } from 'zustand';
// audit-r76 (2026-10-17):i18next 直调替代 useTranslation —— store action 在
//   React 组件上下文之外执行,hook 调用必抛(见下方 open() 注释)。
import i18next from 'i18next';
import { createLogger } from './logger-client';
import { useToast } from './toast';

const log = createLogger('useConfirm');

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface PendingConfirm {
  opts: ConfirmOptions;
  resolve: (v: boolean) => void;
}

interface ConfirmState {
  active: ConfirmOptions | null;
  resolve: ((v: boolean) => void) | null;
  /** 等待中队列 —— 第一个 confirm 还在屏上时后续调用排队,逐个弹 */
  queue: PendingConfirm[];
  open: (opts: ConfirmOptions) => Promise<boolean>;
  close: (value: boolean) => void;
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  active: null,
  resolve: null,
  queue: [],
  open: (opts) =>
    new Promise<boolean>((resolve) => {
      const cur = get();
      if (cur.active) {
        // audit 2026-09-07:排队而非 resolve(false) —— 旧实现把第一个调用
        //   resolve(false) 假装用户取消,首调用方继续走 "用户说不要" 分支,
        //   但用户根本没看到第一个对话框。改为入队,用户按顺序确认每个。
        //   上限 1:防止 hotkey 连发 / 异常循环把队列撑爆(用户被卡在弹窗里)。
        if (cur.queue.length >= 1) {
          // audit 2026-09-10:toast 告知 —— 旧实现仅 log.warn,用户做了请求却被
          //   静默 resolve(false),delete 等危险操作的"第二次点击"被无反馈吞掉。
          //   toast 给个明确提示:有 dialog 在队列里,本次未执行。
          //   走 i18n key 'toast.confirmQueueFull'。
          // audit-r76 (2026-10-17):useTranslation 是 React hook,在 zustand
          //   store action 里调用必抛 Invalid hook call(此处不在任何组件的
          //   render 上下文)—— 旧实现的 try/catch 因此**永远**走 catch,
          //   toast 恒显示裸 key 字符串 'toast.confirmQueueFull'(round 12
          //   注释里「不会抛」的论断是错的,本 fix 即为实证反驳)。改为
          //   i18next.t() 直调:不依赖 React 上下文,i18n 未初始化时
          //   i18next.t 自身返回 key,兜底行为与旧 catch 分支一致。
          //   shortcuts.ts:118 已有同款 i18next.t 直调先例。
          log.warn('Confirm queue full (2 pending), auto-cancelling this prompt', opts.title);
          const message = i18next.t('toast.confirmQueueFull');
          useToast.getState().show({ type: 'info', message });
          resolve(false);
          return;
        }
        log.info('Confirm queued; first dialog still open', { queuedTitle: opts.title });
        set({ queue: [...cur.queue, { opts, resolve }] });
        return;
      }
      set({ active: opts, resolve });
    }),
  close: (value) => {
    const { resolve, queue } = get();
    // 当前 dialog 收尾;若有队列项,把下一项提到 active
    if (queue.length > 0) {
      const [next, ...rest] = queue;
      set({ active: next.opts, resolve: next.resolve, queue: rest });
    } else {
      set({ active: null, resolve: null });
    }
    resolve?.(value);
  },
}));

/** 命令式入口 */
export function confirm(opts: ConfirmOptions): Promise<boolean> {
  return useConfirmStore.getState().open(opts);
}
