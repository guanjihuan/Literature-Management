// tests/unit/renderer/components/ui/modal-contract.test.tsx
//
// 守 Modal 原语的**对话框语义契约**(src/renderer/src/components/ui/Modal.tsx
// 头注指向本文件,audit-r117 登记,本轮补齐 —— 原先标 🔒(守卫缺失))。
//
// Modal 是全站唯一「role=dialog」的模态壳(确认框 / 重命名 / 文献详情都用它),
// 它身上钉着几件**语义载体**属性,错了 SR 用户直接失能:
//   1. role="dialog" + aria-modal="true" —— SR 才知道这是对话框并把背景
//      判为惰性;
//   2. aria-labelledby 指向标题 h2 —— SR 念的是「对话框标题」而不是
//      整段正文;
//   3. description ⇒ aria-describedby + 一个含说明的节点 —— **最关键**:
//      「此操作不可撤销」「.md 扩展名会自动追加」这类后果说明,SR 用户
//      光听标题听不到,只写在视觉上等于没写;
//   4. dismissible=false ⇒ **不渲染**右上角 ✕ —— 「点不动的假按钮」
//      比「没有按钮」更像 bug(audit 2026-10-04 MED);
//   5. autoFocusSelector / initialFocusRef 必须**真的转发**给 Overlay
//      (r124:此前 Modal 壳根本没接收这两个 prop,Overlay 头注的承诺悬空,
//      导致 NotesView rename 弹窗的 autoFocus 被 Overlay 兜底 focus 偷走)。
//
// 变异思路:去掉 aria-describedby 接线 / 去掉 dismissible 分支 / 不转发
// initialFocusRef / description 传 ReactNode 时包错标签 —— 逐条会红。
import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { useRef } from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

import { Modal } from '../../../../../src/renderer/src/components/ui/Modal';

async function flushFocus() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 10));
  });
}

afterEach(() => {
  cleanup();
});

function renderModal(ui: React.ReactElement) {
  const { container, unmount } = render(ui);
  return { container, unmount };
}

describe('Modal 对话框语义契约(audit-r117 补齐)', () => {
  it('open=false ⇒ 什么都不渲染', () => {
    renderModal(
      <Modal open={false} onClose={() => {}} title="T">
        body
      </Modal>,
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('role=dialog + aria-modal=true + aria-labelledby 指向标题 h2', () => {
    renderModal(
      <Modal open onClose={() => {}} title="重命名笔记">
        body
      </Modal>,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy, 'aria-labelledby 不得为空').toBeTruthy();
    const title = document.getElementById(labelledBy!);
    expect(title?.textContent).toBe('重命名笔记');
    expect(title?.tagName).toBe('H2');
  });

  it('description 传 string ⇒ 自动包 <p> 并接上 aria-describedby', () => {
    renderModal(
      <Modal open onClose={() => {}} title="T" description="此操作不可撤销">
        body
      </Modal>,
    );
    const dialog = screen.getByRole('dialog');
    const descId = dialog.getAttribute('aria-describedby');
    expect(descId, '有 description 时必须挂 aria-describedby').toBeTruthy();
    const desc = document.getElementById(descId!);
    expect(desc?.textContent).toBe('此操作不可撤销');
    expect(desc?.tagName, 'string 形态必须包成 <p>').toBe('P');
  });

  it('description 传 ReactNode ⇒ 包 <div> 渲染(不强制 <p>)', () => {
    renderModal(
      <Modal
        open
        onClose={() => {}}
        title="T"
        description={<strong data-testid="rich">重点</strong>}
      >
        body
      </Modal>,
    );
    const dialog = screen.getByRole('dialog');
    const descId = dialog.getAttribute('aria-describedby');
    const desc = document.getElementById(descId!);
    expect(desc?.tagName).toBe('DIV');
    expect(desc?.querySelector('[data-testid="rich"]')).not.toBeNull();
  });

  it('不传 description ⇒ 不挂 aria-describedby(别让 SR 念空串)', () => {
    renderModal(
      <Modal open onClose={() => {}} title="T">
        body
      </Modal>,
    );
    expect(screen.getByRole('dialog').getAttribute('aria-describedby')).toBeNull();
  });

  it('dismissible 默认 true ⇒ 渲染右上角关闭按钮,点它调 onClose', () => {
    const onClose = vi.fn();
    renderModal(
      <Modal open onClose={onClose} title="T">
        body
      </Modal>,
    );
    const btn = screen.getByRole('button', { name: 'common.close' });
    fireEvent.click(btn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('dismissible=false ⇒ 不渲染关闭按钮(不装一个点了没反应的假控件)', () => {
    renderModal(
      <Modal open onClose={() => {}} title="T" dismissible={false}>
        body
      </Modal>,
    );
    expect(screen.queryByRole('button', { name: 'common.close' })).toBeNull();
  });

  it('footer 传了才渲染底部条', () => {
    renderModal(
      <Modal open onClose={() => {}} title="T" footer={<button>确定</button>}>
        body
      </Modal>,
    );
    expect(screen.getByRole('button', { name: '确定' })).toBeTruthy();

    cleanup();
    renderModal(
      <Modal open onClose={() => {}} title="T">
        body
      </Modal>,
    );
    expect(screen.queryByRole('button', { name: '确定' })).toBeNull();
  });

  it('initialFocusRef 被转发给 Overlay(焦点落在指定元素,不被面板兜底偷走)', async () => {
    function Case() {
      const ref = useRef<HTMLInputElement>(null);
      return (
        <Modal open onClose={() => {}} title="T" initialFocusRef={ref}>
          <input ref={ref} data-testid="target" />
        </Modal>
      );
    }
    render(<Case />);
    await flushFocus();
    expect(document.activeElement).toBe(screen.getByTestId('target'));
  });

  it('autoFocusSelector 被转发给 Overlay', async () => {
    render(
      <Modal open onClose={() => {}} title="T" autoFocusSelector="[data-auto]">
        <button data-auto data-testid="auto">
          auto
        </button>
      </Modal>,
    );
    await flushFocus();
    expect(document.activeElement).toBe(screen.getByTestId('auto'));
  });

  it('width prop 落到面板 className(默认 max-w-xl)', () => {
    const { unmount } = renderModal(
      <Modal open onClose={() => {}} title="T">
        body
      </Modal>,
    );
    expect(screen.getByRole('dialog').className).toContain('max-w-xl');
    unmount();

    const { unmount: u2 } = renderModal(
      <Modal open onClose={() => {}} title="T" width="max-w-3xl">
        body
      </Modal>,
    );
    expect(screen.getByRole('dialog').className).toContain('max-w-3xl');
    u2();
  });
});
