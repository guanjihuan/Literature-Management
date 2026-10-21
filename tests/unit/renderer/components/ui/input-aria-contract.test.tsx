// tests/unit/renderer/components/ui/input-aria-contract.test.tsx
//
// 守 audit r252:Input 的 aria-describedby 必须**同时**指向调用方给的说明
// 与组件自己挂的错误文案节点。
//
// 旧实现的坑:属性写在 `{...rest}` **之前** ——
//   `aria-describedby={hasError ? errId : rest['aria-describedby']}`
//   而展开在后面 ⇒ rest 里若也带 aria-describedby,展开会把它整个盖掉
//   ⇒ 错误文案 <p role="alert"> 还在 DOM 里,却不再被 input 引用
//   ⇒ 读屏用户念 input 时**听不到错误原因**(视觉正常、a11y 断链)。
//   今天是「潜在」缺陷(现有 6 个调用点没有同时传 error + aria-describedby),
//   但它是**契约级**的雷:下一个照着文档写的调用方就会踩到。
//
// 本测锁:
//   1. 同时传 error + aria-describedby ⇒ 两个 id 都在(不被覆盖);
//   2. 只传 error ⇒ 指到错误节点;
//   3. 只传 aria-describedby ⇒ 原样保留;
//   4. 都不传 ⇒ 不产出该属性。
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { Input } from '../../../../../src/renderer/src/components/ui/Input';

describe('Input 的 aria 契约(r252)', () => {
  it('同时传 error + aria-describedby ⇒ 两个 id 都被引用(错误节点不丢)', () => {
    render(
      <Input
        value="x"
        onChange={() => undefined}
        error="文件名已存在"
        aria-describedby="hint-1"
      />,
    );
    const input = screen.getByRole('textbox');
    const described = input.getAttribute('aria-describedby') ?? '';
    const ids = described.split(/\s+/).filter(Boolean);
    // 调用方给的说明
    expect(ids, '调用方给的 aria-describedby 不得被覆盖').toContain('hint-1');
    // 组件挂的错误节点:DOM 里那个 role=alert 的 <p> 的 id 必须在列表里
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe('文件名已存在');
    expect(ids, '错误文案节点必须被 input 引用(否则读屏听不到错误原因)').toContain(
      alert.getAttribute('id') ?? '',
    );
    expect(alert.getAttribute('id')).toBeTruthy();
  });

  it('只传 error ⇒ 指到错误节点', () => {
    render(<Input value="x" onChange={() => undefined} error="必填" />);
    const input = screen.getByRole('textbox');
    const alert = screen.getByRole('alert');
    expect(input.getAttribute('aria-describedby')).toBe(alert.getAttribute('id'));
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('只传 aria-describedby ⇒ 原样保留', () => {
    render(<Input value="x" onChange={() => undefined} aria-describedby="hint-2" />);
    expect(screen.getByRole('textbox').getAttribute('aria-describedby')).toBe('hint-2');
  });

  it('都不传 ⇒ 不产出该属性', () => {
    render(<Input value="x" onChange={() => undefined} />);
    expect(screen.getByRole('textbox').hasAttribute('aria-describedby')).toBe(false);
  });
});
