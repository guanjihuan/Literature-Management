// 阅读器空态:无选中文件
import { FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { EmptyState } from '../ui/chrome';

export function ReaderEmpty() {
  const { t } = useTranslation();
  return (
    <EmptyState
      size="lg"
      accent="library"
      icon={<FileText size={26} aria-hidden="true" />}
      title={t('reader.emptyReader')}
      description={t('reader.emptyReaderDesc')}
    />
  );
}
