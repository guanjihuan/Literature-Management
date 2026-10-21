// tests/unit/main/window-defaults.test.ts
//
// 守「窗口初始尺寸」契约(audit r176,2026-10-19):
//
//   1) 默认宽度 1280 → 1440(用户报「软件的默认界面宽度可以再稍微宽一些」)。
//      锁死 1440 是为了防回退 —— 这个值用户看不见代码,改回去不会有任何
//      报错,只能靠测试记住。
//   2) 尺寸关系的合法性:min ≤ default。min > default 的组合会让「缩到最小」
//      操作被 Chromium 静默顶回,用户体感是 bug 而不是设计。
//   3) MIN_WINDOW_WIDTH 必须 ≤ 1366 —— 1366×768 是还相当常见的小屏;
//      若 min 超过屏宽,这类用户根本没法把窗口收到自己想要的窄度。
//   4) src/main/window.ts 必须真的引用这些常量(而不是自己又写了一份
//      字面量)—— 否则「常量改了但窗口没用上」这种漂移会静默发生。
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WINDOW_WIDTH,
  DEFAULT_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
} from '../../../src/main/window-defaults';

const ROOT = process.cwd();

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

describe('窗口初始尺寸(window-defaults)', () => {
  it('默认宽度是 1440(比上一版 1280 宽)', () => {
    expect(DEFAULT_WINDOW_WIDTH).toBe(1440);
  });

  it('默认高度维持 800 —— 本轮只放宽宽度', () => {
    expect(DEFAULT_WINDOW_HEIGHT).toBe(800);
  });

  it('min 尺寸关系合法:min ≤ default', () => {
    expect(MIN_WINDOW_WIDTH).toBeLessThanOrEqual(DEFAULT_WINDOW_WIDTH);
    expect(MIN_WINDOW_HEIGHT).toBeLessThanOrEqual(DEFAULT_WINDOW_HEIGHT);
    expect(MIN_WINDOW_WIDTH).toBeGreaterThan(0);
    expect(MIN_WINDOW_HEIGHT).toBeGreaterThan(0);
  });

  it('最小宽度不超过 1366 —— 常见小屏用户也要能收窄窗口', () => {
    expect(MIN_WINDOW_WIDTH).toBeLessThanOrEqual(1366);
  });

  it('窗口创建处真的用的是这些常量(没有另写一份字面量)', () => {
    const src = read('src/main/window.ts');
    expect(src).toContain('width: DEFAULT_WINDOW_WIDTH');
    expect(src).toContain('height: DEFAULT_WINDOW_HEIGHT');
    expect(src).toContain('minWidth: MIN_WINDOW_WIDTH');
    expect(src).toContain('minHeight: MIN_WINDOW_HEIGHT');
    // 旧的字面量不该残留在窗口创建处
    expect(src).not.toMatch(/width:\s*1280\b/);
    expect(src).not.toMatch(/width:\s*1440\b/);
  });
});
