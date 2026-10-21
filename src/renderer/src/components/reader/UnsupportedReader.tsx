// 兜底:不支持的格式提供"在系统应用打开"入口
import { useTranslation } from 'react-i18next';
import { ReaderError } from './ReaderError';

// audit 2026-09-08:从 export 改非 export —— 0 外部 caller,只本文件
//   UnsupportedReader 引用。
interface UnsupportedReaderProps {
  filename: string;
  onOpenExternal?: () => void;
}

export function UnsupportedReader({ filename, onOpenExternal }: UnsupportedReaderProps) {
  const { t } = useTranslation();
  return (
    <ReaderError
      title={t('reader.unsupported')}
      description={t('reader.unsupportedDesc', { filename })}
      onOpenExternal={onOpenExternal}
    />
  );
}
