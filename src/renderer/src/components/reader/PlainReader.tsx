// 纯文本阅读器:只接已解码的 text 字符串。
// audit-r124 校正:原注「UTF-8 解码失败时退回 latin-1 已在调用方处理」不实 ——
//   该承诺自本文件诞生(acee5f3)即无对应实现(git log -S "latin" 全史仅命中
//   注释本身)。现调用方 = Reader.tsx 的 `new TextDecoder('utf-8', {fatal:false})`,
//   非 UTF-8 字节(GBK/latin-1 遗留 txt)静默出 U+FFFD 乱码。编码嗅探兜底属
//  功能增强(需 detect-encoding 依赖或 BOM/统计启发),记挂账不在注释轮动。
// audit 2026-09-08:从 export 改非 export —— 0 外部 caller,只本文件
//   PlainReader 引用。
// audit-r143 (2026-10-19) MED:加空内容 EmptyState —— 与 MarkdownReader /
//   CodeReader 同款提示(复用 reader.emptyDoc{Desc}),用户不再对「空白
//   pre」猜测是文件空还是 reader 坏。
import { useTranslation } from 'react-i18next';
import { FileText } from 'lucide-react';
import { EmptyState } from '../ui/chrome';

interface PlainReaderProps {
  text: string;
  filename: string;
}

export function PlainReader({ text, filename }: PlainReaderProps) {
  const { t } = useTranslation();
  return (
    <div className="flex-1 overflow-auto p-8" aria-label={filename}>
      {text.length === 0 ? (
        <EmptyState
          icon={<FileText size={24} aria-hidden="true" />}
          title={t('reader.emptyDoc')}
          description={t('reader.emptyDocDesc', { filename })}
          size="md"
        />
      ) : (
        <pre className="font-mono text-sm leading-6 text-fg whitespace-pre-wrap break-words">
          {text}
        </pre>
      )}
    </div>
  );
}
