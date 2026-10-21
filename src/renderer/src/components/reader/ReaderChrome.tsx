// audit-r143 (2026-10-19):Reader 文件名共享标题条 —— 5 个 reader variant
//   此前只在 root div 上挂 aria-label={filename}(SR 唯一渠道),有视用户
//   切到 reader 后看不到「我在读哪个文件」。这里做一个共享 chrome,放在
//   每个 variant 内容区顶部,与 sidebar / notes 顶部条视觉对齐。
//
//   SR 重复读风险:ReaderChrome 用 aria-hidden="true" 让 SR 跳到 variant
//   自带的 aria-label(等同于原来的语义),不重复念出文件名。
import { memo } from 'react';

interface ReaderChromeProps {
  filename: string;
}

export const ReaderChrome = memo(function ReaderChrome({ filename }: ReaderChromeProps) {
  // 极端 filename 长度:顶部条 truncate + tooltip 双保险;
  //   数据来自 fs 列目录,可能拿到 200+ 字符的奇怪文件名。
  return (
    <div
      aria-hidden="true"
      data-testid="reader-chrome"
      className="flex items-center gap-2 px-4 h-8 border-b border-border-subtle bg-bg-raised text-xs text-fg-secondary shrink-0"
    >
      <span className="truncate" title={filename}>
        {filename}
      </span>
    </div>
  );
});
