// tests/unit/renderer/store/workspace-default-tab.test.ts
//
// 行为锁(audit-r236,2026-10-20):启动首屏左栏默认 tab = 'library'(文献)。
//
//   用户要求「软件启动的时候,左侧栏默认在文献 tab 中」。此前默认是 'notes'
//   (audit-r69 2026-10-16,当时 library 模块已下线、首屏会白屏)。前提在
//   audit-r71 恢复 LiteratureList + 2026-10-18 主区双列解耦后已失效,默认值
//   纯属产品选择,极易被无意改回 —— 用初始状态锁住。
//
// 形态:import 真 store(不 mock),只读模块初始化后的 active 字段。
// zustand 的初始值就是 create() 传入的对象,store 实例在本 test 文件独享,
// 不受其他文件 mock 影响。

import { readFileSync } from 'fs';
import { join } from 'path';

import { describe, expect, it } from 'vitest';

import { useWorkspaceStore } from '../../../../src/renderer/src/store/workspace';

describe('workspace 启动默认 tab(r236 行为锁)', () => {
  it('初始 active === "library"(首屏左栏落在文献 tab)', () => {
    expect(useWorkspaceStore.getState().active).toBe('library');
  });

  it("默认值在 WorkbenchListPanel 的 VALID_TAB_IDS 白名单里", () => {
    // 默认 active 必须落在列表面板白名单里,否则首屏 Tabs 高亮与 tabpanel id
    // 配不上对(tab-library / panel-library 悬空),且 handleTabChange 会拒绝
    // 切回默认 tab。白名单从组件源码字面量解析,防止 store 默认值与 UI
    // 白名单悄悄分叉(同构块分叉家族)。
    const panelSrc = readFileSync(
      join(process.cwd(), 'src/renderer/src/components/layout/WorkbenchListPanel.tsx'),
      'utf8',
    );
    const m = panelSrc.match(/const VALID_TAB_IDS = \[([^\]]*)\]/);
    expect(m, 'WorkbenchListPanel 里找不到 VALID_TAB_IDS 字面量(结构变了要同步本测试)').toBeTruthy();
    const ids = (m as RegExpMatchArray)[1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    expect(ids).toContain(useWorkspaceStore.getState().active);
  });
});
