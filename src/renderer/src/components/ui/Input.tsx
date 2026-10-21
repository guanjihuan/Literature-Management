// 通用输入框 - Linear 风格
import { forwardRef, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff } from 'lucide-react';
import { clsx } from '../../lib/clsx';
import type { InputHTMLAttributes } from 'react';

interface InputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'onChange' | 'value' | 'type'
> {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /**
   * 作用在**外层 wrapper**(定位/宽度用):w-full / flex-1 / w-32 之类。
   *
   * 注意(2026-09-04 修):这个 prop 一直只落在 wrapper 上,但多个调用方
   * 当成"给 input 用"来传(`pl-7 text-2xs`、`!bg-transparent !text-base`),
   * 结果全部静默失效 —— 搜索框的左内边距没让出来、图标压住了 placeholder,
   * 笔记标题也没有变粗变大。要改 input 本身请用 `inputClassName` / `variant`。
   */
  className?: string;
  /** 作用在 `<input>` 元素上,排在默认样式之后,可覆盖内边距 / 字号 / 高度。 */
  inputClassName?: string;
  /**
   * default — 标准输入框(bg-surface + 边框 + 内边距)
   * ghost   — 无背景无边框无内边距,与所在容器融为一体(命令面板搜索框、
   *           笔记标题这类"看起来是文本、点了才发现能编辑"的场景)。
   *           焦点可见性仍由 globals.css 的全局 `*:focus-visible` 兜底。
   */
  variant?: 'default' | 'ghost';
  type?: 'text' | 'password' | 'number' | 'search';
  /**
   * 仅对 type="password" 生效:显示一个眼睛按钮,点击切换可见性。
   * 默认 false(与原行为一致)。
   */
  reveal?: boolean;
  /**
   * 右侧动作按钮(不限于密码场景);与 reveal 互斥。
   */
  trailing?: React.ReactNode;
  /**
   * audit-r143 (2026-10-19) MED:错误态 —— 传非空字符串时,input 走红边(border-danger
   *   + ring-danger/30)、挂 aria-invalid=true、并在下方显示错误文本,通过
   *   aria-describedby 接线给 SR。多个调用方原本要在外层自己写 error <p> 块
   *   并手动接线,UI 视觉与 SR 语义总有一头漏 —— 收敛到 Input 原语后,
   *   「必填未填」「文件名已存在」之类校验都能直接喂进 prop。
   *   不传 / 空串 / undefined = 错误态关闭(回到中性样式)。
   */
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    value,
    onChange,
    placeholder,
    className,
    inputClassName,
    variant = 'default',
    type = 'text',
    reveal,
    trailing,
    error,
    ...rest
  },
  ref,
) {
  // audit 2026-08-28:reveal 按钮 aria-label / title 走 i18n key — 旧硬编码中文,
  // 英文用户读到中文 a11y 文本。
  const { t } = useTranslation();
  // reveal 时本地维护可见性;reactive 但不污染外部受控
  const [shown, setShown] = useState(false);
  const effectiveType = type === 'password' && reveal && shown ? 'text' : type;

  const showToggle = type === 'password' && reveal;
  // revealed() 只在 showToggle 为真时被引用,所以两条 key 在其它调用点不解析也不影响行为
  const revealLabel = shown ? t('input.revealHide') : t('input.revealShow');

  // ghost 不走 .input-base —— 与其用 utilities 一条条抵消 bg/border/padding
  // (还得赌 Tailwind 的 layer 顺序),不如干脆换一套基样式。
  const base =
    variant === 'ghost'
      ? 'w-full bg-transparent border-0 p-0 text-fg placeholder:text-fg-tertiary transition-colors duration-120'
      : 'input-base w-full px-3 py-1.5';

  // error 描述节点 id —— 给 input 的 aria-describedby 接线,SR 念完 input 后
  // 接着念错误内容,用户立即知道哪里错。
  const errId = useId();
  const hasError = typeof error === 'string' && error.length > 0;

  // audit-r252 (2026-10-21):aria-describedby 必须**合并**,不能二选一。
  //   旧写法:`aria-describedby={hasError ? errId : rest['aria-describedby']}`
  //   算在 `{...rest}` **之前** ⇒ rest 里若也带 aria-describedby,展开会把它
  //   整个盖掉 ⇒ 错误文案节点虽然还在 DOM 里(role=alert),却不再被 input
  //   引用 ⇒ 读屏用户念 input 时**听不到错误原因**(视觉正常、a11y 断链)。
  //   修法:把 aria-describedby 从 rest 里摘出来,和错误节点 id **拼在一起**
  //   (两个都指上),再交给 input。
  const {
    'aria-describedby': callerDescribedBy,
    ...inputRest
  } = rest;
  const describedBy =
    [callerDescribedBy, hasError ? errId : null].filter(Boolean).join(' ') || undefined;

  return (
    <div className={clsx('relative w-full', className)}>
      <input
        ref={ref}
        type={effectiveType}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-invalid={hasError || undefined}
        aria-describedby={describedBy}
        className={clsx(
          base,
          showToggle || trailing ? 'pr-9' : null,
          // audit-r143 MED:错误态视觉 —— danger 边 + 弱 ring,与全站 status
          //   色一致。ghost 变体不强加边框(保持「无背景无边框」语义)。
          hasError && variant !== 'ghost' && 'border-danger ring-1 ring-danger/30',
          inputClassName,
        )}
        {...inputRest}
      />
      {showToggle && (
        <button
          type="button"
          onClick={() => setShown((s) => !s)}
          aria-label={revealLabel}
          title={revealLabel}
          className="absolute inset-y-0 right-1.5 flex items-center px-1 text-fg-tertiary hover:text-fg-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent transition-colors duration-120"
        >
          {shown ? <EyeOff size={13} aria-hidden="true" /> : <Eye size={13} aria-hidden="true" />}
        </button>
      )}
      {!showToggle && trailing && (
        <div className="absolute inset-y-0 right-1.5 flex items-center">{trailing}</div>
      )}
      {/* 错误文本 —— role=alert 让 SR 立即播报(出现即宣读,不等下次 idle),
           文字小一号、danger 色,与全站 status 文字节奏一致(text-2xs 13px)。 */}
      {hasError && (
        <p id={errId} role="alert" className="mt-1 text-2xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
});
