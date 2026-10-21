// ConfirmDialog 宿主 — 单例,从 ConfirmDialog 升级为"命令式"用法
// 实现见 lib/confirm.ts(audit-r206 从 components/common/useConfirm.ts 搬到 lib/,
// 与 lib/toast.tsx 同层:store 在 lib、渲染宿主在 components)。
// (audit-r97:lib/prompt 死链已删,勿再加回对称注)
import { useConfirmStore } from '../../lib/confirm';
import { ConfirmDialog } from './ConfirmDialog';

export function ConfirmHost() {
  const active = useConfirmStore((s) => s.active);
  const close = useConfirmStore((s) => s.close);

  if (!active) return null;

  return (
    <ConfirmDialog
      open
      title={active.title}
      message={active.description}
      confirmLabel={active.confirmLabel}
      cancelLabel={active.cancelLabel}
      danger={active.danger}
      onConfirm={() => close(true)}
      onCancel={() => close(false)}
    />
  );
}
