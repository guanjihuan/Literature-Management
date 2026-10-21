// tests/unit/renderer/components/ui/button-contract.test.tsx
//
// 守 Button 原语的**行为契约**(src/renderer/src/components/ui/Button.tsx 头注
// 指向本文件,audit-r118 登记 6 例 / 7 变异精确;本轮补齐,原先标 🔒(守卫缺失))。
//
// Button 是全站按钮唯一入口(确认框 / 工具栏 / 错误页 / 设置页),它身上钉着
// 几件**别处不会重复**的语义:
//   1. 默认 type="button" —— HTML <button> 的默认 type 是 "submit",在
//      <form> 里点一下会误提交。Button 必须显式兜住。
//   2. loading ⇒ 自动 disabled + aria-busy + 插入 spinner + **摘掉 onClick**
//      (r143:防异步动作期间重复点击;spinner 在前、文字不变避免宽度跳变)。
//   3. data-* 透传(r18)—— ConfirmDialog 的 autoFocusSelector 需要用
//      querySelector 命中真按钮,故必须透传,不能被 Button 的 prop 白名单吃掉。
//   4. size lg = h-11(r150 a11y:WCAG 2.5.5 AAA 触摸目标 ≥ 44×44)。
//
// 变异思路:每条断言都对着**一个具体会被改坏的点**,不是快照式对比。
import { describe, expect, it, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { Button } from '../../../../../src/renderer/src/components/ui/Button';

function renderButton(ui: React.ReactElement) {
  const { container, unmount } = render(ui);
  const btn = container.querySelector('button');
  if (!btn) throw new Error('Button 未渲染出 <button>');
  return { btn, container, unmount };
}

describe('Button 契约(audit-r118 补齐)', () => {
  it('默认 type="button"(HTML 默认是 submit,在 <form> 里会误提交)', () => {
    const { btn, unmount } = renderButton(<Button>ok</Button>);
    expect(btn.getAttribute('type')).toBe('button');
    unmount();
  });

  it('loading ⇒ disabled + aria-busy + spinner + 摘掉 onClick', () => {
    const onClick = vi.fn();
    const { btn, container, unmount } = renderButton(
      <Button loading onClick={onClick}>
        保存
      </Button>,
    );
    expect(btn.disabled, 'loading 期间必须禁用').toBe(true);
    expect(btn.getAttribute('aria-busy')).toBe('true');
    // 文字不变 + spinner 在前(宽度不跳变)
    expect(btn.textContent).toContain('保存');
    const svg = container.querySelector('svg');
    expect(svg, 'loading 时应有 Loader2 图标').not.toBeNull();
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
    expect(svg?.getAttribute('class')).toContain('animate-spin');
    // 视觉:不可点 cursor + 轻微透明
    expect(btn.className).toContain('cursor-not-allowed');
    // disabled 按钮的 click 由浏览器/React 双重挡住 ⇒ onClick 不得触发
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
    unmount();
  });

  it('loading 覆盖 disabled 的语义(两者都传也只 disabled 一次,不报错)', () => {
    const { btn, unmount } = renderButton(
      <Button loading disabled>
        x
      </Button>,
    );
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('aria-busy')).toBe('true');
    unmount();
  });

  it('非 loading 时 disabled ⇒ 点击不触发 onClick;非 disabled ⇒ 触发一次', () => {
    const onClick = vi.fn();
    const { btn, unmount } = renderButton(
      <Button disabled onClick={onClick}>
        x
      </Button>,
    );
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
    unmount();

    const onClick2 = vi.fn();
    const { btn: btn2, unmount: unmount2 } = renderButton(
      <Button onClick={onClick2}>x</Button>,
    );
    fireEvent.click(btn2);
    expect(onClick2).toHaveBeenCalledTimes(1);
    unmount2();
  });

  it('data-* 透传(r18:ConfirmDialog 的 autoFocusSelector 要靠它命中真按钮)', () => {
    const { btn, unmount } = renderButton(
      <Button data-testid="confirm-ok" data-confirm-role="primary">
        确认
      </Button>,
    );
    expect(btn.getAttribute('data-testid')).toBe('confirm-ok');
    expect(btn.getAttribute('data-confirm-role')).toBe('primary');
    unmount();
  });

  it('非 data-* 的多余 prop 不落到 DOM(rest 白名单外一律丢弃)', () => {
    const { btn, unmount } = renderButton(
      <Button {...({ nonsense: 'x' } as Record<string, unknown>)}>y</Button>,
    );
    expect(btn.getAttribute('nonsense')).toBeNull();
    unmount();
  });

  it('size 档位类名映射(xs/sm/md/lg,lg = h-11 的 44px 触摸目标)', () => {
    const cases: [ 'xs' | 'sm' | 'md' | 'lg', string ][] = [
      ['xs', 'h-6'],
      ['sm', 'h-[26px]'],
      ['md', 'h-[30px]'],
      ['lg', 'h-11'],
    ];
    for (const [size, expectCls] of cases) {
      const { btn, unmount } = renderButton(<Button size={size}>z</Button>);
      expect(btn.className, `size=${size} 应带 ${expectCls}`).toContain(expectCls);
      unmount();
    }
  });

  it('variant 档位类名映射(primary/secondary/ghost/danger)+ 默认 secondary', () => {
    const variants = ['primary', 'secondary', 'ghost', 'danger'] as const;
    for (const v of variants) {
      const { btn, unmount } = renderButton(<Button variant={v}>z</Button>);
      expect(btn.className, `variant=${v} 应带 btn-${v}`).toContain(`btn-${v}`);
      unmount();
    }
    const { btn, unmount } = renderButton(<Button>z</Button>);
    expect(btn.className, '默认 variant 必须是 secondary').toContain('btn-secondary');
    unmount();
  });

  it('aria-label / title 透传(缺省时属性不存在,不留空串)', () => {
    const { btn, unmount } = renderButton(
      <Button aria-label="关闭面板" title="tooltip">
        z
      </Button>,
    );
    expect(btn.getAttribute('aria-label')).toBe('关闭面板');
    expect(btn.getAttribute('title')).toBe('tooltip');
    unmount();

    const { btn: bare, unmount: unmount2 } = renderButton(<Button>z</Button>);
    expect(bare.getAttribute('aria-label')).toBeNull();
    expect(bare.getAttribute('title')).toBeNull();
    unmount2();
  });

  it('className 由调用方追加(不覆盖内置档位类)', () => {
    const { btn, unmount } = renderButton(<Button className="my-cls">z</Button>);
    expect(btn.className).toContain('my-cls');
    expect(btn.className).toContain('btn');
    unmount();
  });
});
