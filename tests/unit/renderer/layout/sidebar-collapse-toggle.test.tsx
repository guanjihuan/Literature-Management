// tests/unit/renderer/layout/sidebar-collapse-toggle.test.tsx
//
// 守 r242「折叠 / 展开左侧栏」按钮的行为契约。
//
// 需求:用户要「一个按钮隐藏或展开左侧栏」。本轮的实现落点:
//   - 按钮在**标题栏右侧**控件簇(r242 起先放左上角品牌区旁,r246 按用户
//     反馈「该按钮不应该在左上角吧,放右边怎么样」挪到右侧)—— 折叠后面板
//     整个不在 DOM 里,面板内的按钮会跟着消失,用户再也点不回来;标题栏
//     是唯一「折叠前后都在」的位置。
//   - 折叠态存在 workspace store(sidebarCollapsed),持久化到
//     settings.json 的 workspaceLayout(见 shared/sidebar-collapsed-persistence.test.ts)。
//   - 快捷键 ⌘B / Ctrl+B(命令 id 'view.toggleSidebar',与主进程 View 菜单
//     同一个 id)。
//   - 折叠的实现是「整个面板 return null」,**不是**「宽度设成 0」——
//     宽度 0 会留下一条分隔条 + 边框死白条。
//
// 本测锁(行为级,不测实现细节):
//   A. 标题栏按钮存在、aria-pressed 反映折叠态、点击即翻转 store。
//   B. 折叠 ⇒ 列表面板**整个不进 DOM**;展开 ⇒ 正常渲染。
//   C. 折叠态会落盘(settings.update 带 sidebarCollapsed)⇒ 重启后仍折叠。
//   D. 命令注册表有 view.toggleSidebar(mod+B),执行即翻转折叠态。
//   E. 坏数据(非 boolean)不会把左栏永久藏掉。
//   F. 按钮在标题栏**右侧**控件簇首位(位置回归防护:曾放左上角)。
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, waitFor, act } from '@testing-library/react';

// i18n:只关心交互与键名,不在乎文案
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

// settings store:workspace store 的 persistLayout 会调 update() 落盘 ——
// 换假实现,避免真 IPC(测试环境没有 window.api)。update 是 vi.fn,
// 下面的断言直接拿它当 spy 用。
vi.mock('../../../../src/renderer/src/store/settings', () => {
  const update = vi.fn(async () => undefined);
  const load = vi.fn(async () => undefined);
  const state = { settings: null, update, load };
  const useSettingsStore = ((selector?: (s: unknown) => unknown) =>
    selector ? selector(state) : state) as unknown as {
    (selector?: (s: unknown) => unknown): unknown;
    getState: () => unknown;
  };
  useSettingsStore.getState = () => state;
  return { useSettingsStore };
});

// 懒加载的列表组件:本测不关心列表内容,换掉避免 react-virtuoso / IPC 噪声
vi.mock('../../../../src/renderer/src/components/literature/LiteratureList', () => ({
  LiteratureList: () => <div data-testid="lit-list" />,
}));
vi.mock('../../../../src/renderer/src/components/notes/NotesList', () => ({
  NotesList: () => <div data-testid="notes-list" />,
}));

import { TitleBar } from '../../../../src/renderer/src/components/layout/TitleBar';
import { WorkbenchListPanel } from '../../../../src/renderer/src/components/layout/WorkbenchListPanel';
import { useWorkspaceStore } from '../../../../src/renderer/src/store/workspace';
import { useSettingsStore } from '../../../../src/renderer/src/store/settings';
import { buildCommands } from '../../../../src/renderer/src/command/registry';
import { buildCommandActions } from '../../../../src/renderer/src/command/actions';

const TOGGLE_LABEL = 'titleBar.toggleSidebar';

function updateMock() {
  return useSettingsStore.getState().update as unknown as ReturnType<typeof vi.fn>;
}

function resetStore() {
  useWorkspaceStore.setState({ sidebarCollapsed: false });
}

describe('左侧栏折叠 / 展开(r242)', () => {
  beforeEach(() => {
    resetStore();
    updateMock().mockClear();
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('A1. 标题栏有折叠按钮,标签稳定、aria-pressed 反映当前折叠态', () => {
    const { container } = render(<TitleBar />);
    const btn = container.querySelector(`button[aria-label="${TOGGLE_LABEL}"]`) as HTMLButtonElement;
    expect(btn, '标题栏必须有折叠 / 展开左栏的按钮').toBeTruthy();
    // 展开态 = 未按下
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  it('A2. 点按钮 ⇒ 折叠态翻转(store 是唯一真相源)', () => {
    const { container } = render(<TitleBar />);
    const btn = container.querySelector(`button[aria-label="${TOGGLE_LABEL}"]`) as HTMLButtonElement;

    fireEvent.click(btn);
    expect(useWorkspaceStore.getState().sidebarCollapsed).toBe(true);

    fireEvent.click(btn);
    expect(useWorkspaceStore.getState().sidebarCollapsed).toBe(false);
  });

  it('B1. 折叠 ⇒ 列表面板整个不进 DOM(不是宽度设 0)', () => {
    useWorkspaceStore.setState({ sidebarCollapsed: true });
    const { container } = render(<WorkbenchListPanel />);
    expect(container.querySelector('section'), '折叠后不应留下宽度 0 的空壳 section').toBeNull();
    expect(container.querySelector('[role="tablist"]')).toBeNull();
    expect(container.querySelector('[role="separator"]')).toBeNull();
  });

  it('B2. 展开 ⇒ 面板正常渲染(折叠不是单向死路)', async () => {
    useWorkspaceStore.setState({ sidebarCollapsed: false });
    // list 是 lazy 组件(React.lazy + Suspense)—— act 里等它 resolve,
    // 否则 React 报「suspended resource finished loading outside act」。
    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<WorkbenchListPanel />));
    });
    expect(container.querySelector('section')).toBeTruthy();
    expect(container.querySelector('[role="tablist"]')).toBeTruthy();
  });

  it('C. 折叠态会落盘(settings.update 带 sidebarCollapsed)⇒ 重启后仍折叠', async () => {
    const { container } = render(<TitleBar />);
    const btn = container.querySelector(`button[aria-label="${TOGGLE_LABEL}"]`) as HTMLButtonElement;

    fireEvent.click(btn);

    // persistLayout 是 200ms trailing debounce
    await waitFor(() => expect(updateMock()).toHaveBeenCalled(), { timeout: 2000 });
    const lastCall = updateMock().mock.calls.at(-1);
    expect(lastCall?.[0]).toMatchObject({
      workspaceLayout: expect.objectContaining({ sidebarCollapsed: true }),
    });
  });

  it('D. 命令注册表有 view.toggleSidebar(⌘B),执行即翻转折叠态', () => {
    const cmds = buildCommands(buildCommandActions());
    const cmd = cmds.find((c) => c.id === 'view.toggleSidebar');
    expect(cmd, '命令注册表缺少 view.toggleSidebar(主进程菜单会 invoke 不到)').toBeTruthy();
    expect(cmd?.shortcut).toBe('mod+B');

    cmd?.run();
    expect(useWorkspaceStore.getState().sidebarCollapsed).toBe(true);
    cmd?.run();
    expect(useWorkspaceStore.getState().sidebarCollapsed).toBe(false);
  });

  it('E. 坏数据(非 boolean)不会把左栏永久藏掉', () => {
    useWorkspaceStore.getState().hydrateLayout({
      sidebarCollapsed: 'yes' as unknown as boolean,
    });
    expect(useWorkspaceStore.getState().sidebarCollapsed).toBe(false);

    useWorkspaceStore.getState().hydrateLayout({ sidebarCollapsed: true });
    expect(useWorkspaceStore.getState().sidebarCollapsed).toBe(true);
  });

  it('F. 按钮在标题栏右侧控件簇首位(位置回归防护:曾放左上角品牌区旁)', () => {
    const { container } = render(<TitleBar />);
    const btn = container.querySelector(`button[aria-label="${TOGGLE_LABEL}"]`) as HTMLButtonElement;
    const banner = container.querySelector('[role="banner"]') as HTMLElement;
    const brand = container.querySelector('#app-title-h1')?.parentElement;

    expect(brand, '找不到品牌区(徽标 + 应用名)').toBeTruthy();
    expect(
      brand?.contains(btn),
      '折叠开关不该待在品牌区(左上角)—— 那里是「我是谁」,开关是「操作」',
    ).toBe(false);

    // 标题栏的子节点:品牌区 | 弹性拖拽区 | 右侧控件簇 ⇒ 按钮要在最后一簇
    const clusters = [...banner.children] as HTMLElement[];
    const rightCluster = clusters[clusters.length - 1];
    expect(rightCluster.contains(btn), '折叠开关应在标题栏最右侧的控件簇里').toBe(true);
    // 且是该簇首位(紧邻拖拽区)—— Win 的最小化/最大化/关闭要保持贴右成组
    expect(
      rightCluster.firstElementChild,
      '折叠开关应紧邻拖拽区,不与窗口三按钮混排',
    ).toBe(btn);
  });
});
