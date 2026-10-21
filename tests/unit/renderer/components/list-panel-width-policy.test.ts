// tests/unit/renderer/components/list-panel-width-policy.test.ts
//
// 守左侧列表面板(文献/笔记 Tab)的宽度策略(r175 起,r241 改默认值):
//
//   1) 数值本身:min=200、default=300、max=720。
//      (r241:用户第二次说「左侧栏默认宽度可以稍微宽一些」⇒ default 280→300;
//       min / max 不动 —— 拖宽天花板保留,最小宽度不动)
//   2) **storageKey 升版** —— 每次改默认值都必须换 key。原因:hook 的
//      [width] effect 会把当前宽度(含首次挂载时的默认值)落盘到 localStorage
//      ⇒ 「默认值」第一次运行后就被固化。只改常量不改 key ⇒ 存量用户永远
//      看不到新默认(r175 / r238 / r241 各踩过一次)。
//   3) **定向迁移** —— 升版的同时把旧 key 里「用户真拖过」的宽度搬到新 key;
//      等于旧默认(280)的那个值视为自动落盘,不迁移 ⇒ 新默认生效。
//      这比 r175 的「纯升版,手动偏好一起重置」更友好。
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import {
  LIST_PANEL_MIN,
  LIST_PANEL_MAX,
  LIST_PANEL_DEFAULT,
  LIST_PANEL_WIDTH_KEY,
  LEGACY_LIST_PANEL_WIDTH_KEY,
  migrateLegacyListPanelWidth,
} from '../../../../src/renderer/src/components/layout/list-panel-width';
import { useResizablePanel } from '../../../../src/renderer/src/hooks/useResizablePanel';

function mountPanel(storageKey: string = LIST_PANEL_WIDTH_KEY) {
  return renderHook(() =>
    useResizablePanel({
      storageKey,
      defaultWidth: LIST_PANEL_DEFAULT,
      min: LIST_PANEL_MIN,
      max: LIST_PANEL_MAX,
      side: 'left',
    }),
  );
}

describe('左侧列表面板宽度策略(r241)', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('min / default / max 关系合法', () => {
    expect(LIST_PANEL_MIN).toBeGreaterThan(0);
    expect(LIST_PANEL_DEFAULT).toBeGreaterThanOrEqual(LIST_PANEL_MIN);
    expect(LIST_PANEL_MAX).toBeGreaterThan(LIST_PANEL_DEFAULT);
  });

  it('默认宽度 = 300(r241:280→300),min 200 / max 720 不动', () => {
    expect(LIST_PANEL_MIN).toBe(200);
    expect(LIST_PANEL_DEFAULT).toBe(300);
    expect(LIST_PANEL_MAX).toBe(720);
  });

  it('storageKey 已升版 —— v3 旧 key 不再被直接读取', () => {
    expect(LIST_PANEL_WIDTH_KEY).not.toBe(LEGACY_LIST_PANEL_WIDTH_KEY);
    expect(LIST_PANEL_WIDTH_KEY).toBe('workbench.listPanel.width.v4');
    expect(LEGACY_LIST_PANEL_WIDTH_KEY).toBe('workbench.listPanel.width.v3');
  });

  it('无偏好时用默认宽度', () => {
    const { result } = mountPanel();
    expect(result.current.width).toBe(LIST_PANEL_DEFAULT);
  });

  it('新 key 里越界的旧值被丢弃 → 回落默认', () => {
    localStorage.setItem(LIST_PANEL_WIDTH_KEY, '1500');
    const { result } = mountPanel();
    expect(result.current.width).toBe(LIST_PANEL_DEFAULT);
  });

  it('新 key 里的合法偏好被保留(手动拖过的宽度不丢)', () => {
    localStorage.setItem(LIST_PANEL_WIDTH_KEY, '400');
    const { result } = mountPanel();
    expect(result.current.width).toBe(400);
  });

  it('setWidth 夹紧到 [min, max] —— 最小宽度真的生效', () => {
    const { result } = mountPanel();
    act(() => result.current.setWidth(10));
    expect(result.current.width).toBe(LIST_PANEL_MIN);
    act(() => result.current.setWidth(99999));
    expect(result.current.width).toBe(LIST_PANEL_MAX);
  });
});

describe('v3 → v4 定向迁移(r241)', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it('v3 里「用户真拖过」的宽度被搬到 v4', () => {
    localStorage.setItem(LEGACY_LIST_PANEL_WIDTH_KEY, '400');
    migrateLegacyListPanelWidth();
    expect(localStorage.getItem(LIST_PANEL_WIDTH_KEY)).toBe('400');
  });

  it('v3 里等于旧默认 280 的值不迁移 ⇒ 新默认 300 生效', () => {
    localStorage.setItem(LEGACY_LIST_PANEL_WIDTH_KEY, '280');
    migrateLegacyListPanelWidth();
    expect(localStorage.getItem(LIST_PANEL_WIDTH_KEY)).toBeNull();
    const { result } = mountPanel();
    expect(result.current.width).toBe(LIST_PANEL_DEFAULT);
  });

  it('v4 已有值时不覆盖(幂等 —— 不推翻新 key 下已有的偏好)', () => {
    localStorage.setItem(LIST_PANEL_WIDTH_KEY, '360');
    localStorage.setItem(LEGACY_LIST_PANEL_WIDTH_KEY, '400');
    migrateLegacyListPanelWidth();
    expect(localStorage.getItem(LIST_PANEL_WIDTH_KEY)).toBe('360');
  });

  it('v3 里越界的脏值不迁移', () => {
    localStorage.setItem(LEGACY_LIST_PANEL_WIDTH_KEY, '1500');
    migrateLegacyListPanelWidth();
    expect(localStorage.getItem(LIST_PANEL_WIDTH_KEY)).toBeNull();
  });

  it('v3 缺失(全新安装)⇒ 不迁移,直接用新默认', () => {
    migrateLegacyListPanelWidth();
    expect(localStorage.getItem(LIST_PANEL_WIDTH_KEY)).toBeNull();
    const { result } = mountPanel();
    expect(result.current.width).toBe(LIST_PANEL_DEFAULT);
  });

  it('v2 及更早的 key 不再参与迁移(只认上一版 v3)', () => {
    // v2 是 r238 之前的 key —— r241 的迁移源是 v3。
    // 若实现误把 v2 也当来源,r238 时代「手动拖过 400」的老用户会在
    // 两次升版后被重新当成有效偏好(本该在 r238 就处理完)。
    localStorage.setItem('workbench.listPanel.width.v2', '400');
    migrateLegacyListPanelWidth();
    expect(localStorage.getItem(LIST_PANEL_WIDTH_KEY)).toBeNull();
  });
});
