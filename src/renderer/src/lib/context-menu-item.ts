// 右键菜单项类型(单一真相源)。
//
// r232 之前这两型定义在 components/ui/ContextMenu.tsx 里。收编侧栏菜单
//   同构块(hooks/use-sidebar-menus.ts)时,hooks/ 需要引用 ContextMenuItem ——
//   而 hooks/ 反向 import components/ 是**层级倒挂**(r206 迁 confirm store
//   的判据:一个纯类型/纯逻辑单元若被多处共用,就该下沉到 lib/,而不是让
//   下层去 import 上层)。ContextMenuItem 是纯类型(零运行时),下沉无行为
//   风险;components/ui/ContextMenu.tsx 继续 re-export,既有 import 写法
//   (`import { ContextMenu, type ContextMenuItem } from '../ui/ContextMenu'`)
//   一律不用改。
export type ContextMenuItemType = 'item' | 'separator';

export interface ContextMenuItem {
  id: string;
  type?: ContextMenuItemType; // 缺省 'item'
  label?: string;
  onSelect?: () => void;
  disabled?: boolean;
}
