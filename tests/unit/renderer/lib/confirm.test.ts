// tests/unit/renderer/lib/confirm.test.ts
//
// 守卫(r206,2026-10-20):应用内 ConfirmDialog(lib/confirm.ts)的行为契约 +
// 「renderer 不许再用原生阻塞式对话框」的结构不变式。
//
// 起因(r206 recon):删除文件夹走的是**原生 window.confirm**,文案还硬编码
// 英文(`Delete folder "X" and all its contents?`)—— 中文用户在 zh-CN 界面
// 点「删除文件夹」弹出来的是英文原生对话框,而且 window.confirm 会**阻塞
// 渲染进程**、完全脱离应用主题(项目自己在 SettingsPage 里写过这条结论)。
// r206 把它换成应用内 ConfirmDialog(lib/confirm.ts)+ i18n 文案。
//
// 三条不变式:
//   ① confirm() 是 Promise 风格:open → active 有值;close(true/false)
//      分别 resolve(true/false);
//   ② 并发:第二个 confirm **入队**(不静默 resolve(false) —— 那会让首调用
//      方误以为用户点了「取消」而继续走「用户说不要」分支);close 后下一个
//      提到 active;
//   ③ 队列上限 1:第三个 confirm 走 toast 提示 + resolve(false)(用户不会
//      被永久卡在弹窗里)。
//
// ④ 结构不变式:renderer 源码里**零** window.confirm / window.alert /
//    window.prompt(注释里的历史说明字面量不算)。
//
// ⑤ 层级不变式:renderer 的 hooks/ 与 lib/ 不得 **import 值** components/*
//    (反向依赖 = 层级倒挂的前兆,r206 正是因此把 confirm store 从
//    components/common/ 搬到 lib/)。type-only import 例外(见 workspace.ts)。
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import { confirm, useConfirmStore } from '@renderer/lib/confirm';
import { useToast } from '@renderer/lib/toast';

const ROOT = process.cwd();
const RENDERER = join(ROOT, 'src/renderer/src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** 去掉行注释与块注释,避免「注释里提到 window.confirm」被误判 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('//'))
    .join('\n');
}

describe('lib/confirm(r206)', () => {
  beforeEach(() => {
    // 复位模块级 store(confirm 队列跨用例存活)
    useConfirmStore.setState({ active: null, resolve: null, queue: [] });
    useToast.setState({ toasts: [] });
  });

  it('confirm() 会把对话框置为 active', () => {
    void confirm({ title: 'T1' });
    expect(useConfirmStore.getState().active).toEqual({ title: 'T1' });
  });

  it('close(true) ⇒ promise resolve(true)', async () => {
    const p = confirm({ title: 'T1' });
    useConfirmStore.getState().close(true);
    await expect(p).resolves.toBe(true);
  });

  it('close(false) ⇒ promise resolve(false)', async () => {
    const p = confirm({ title: 'T1' });
    useConfirmStore.getState().close(false);
    await expect(p).resolves.toBe(false);
  });

  it('第二个 confirm 入队(不静默 resolve false)', async () => {
    const p1 = confirm({ title: 'A' });
    const p2 = confirm({ title: 'B' });

    expect(useConfirmStore.getState().active?.title).toBe('A');
    expect(useConfirmStore.getState().queue).toHaveLength(1);
    // 关键:第二个还没被裁决
    let settled = false;
    void p2.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    useConfirmStore.getState().close(true);
    await expect(p1).resolves.toBe(true);
    // close 后第二个被提到 active
    expect(useConfirmStore.getState().active?.title).toBe('B');
    useConfirmStore.getState().close(false);
    await expect(p2).resolves.toBe(false);
  });

  it('队列上限 1:第三个 confirm 走 toast + resolve(false)', async () => {
    const p1 = confirm({ title: 'A' });
    const p2 = confirm({ title: 'B' });
    const p3 = confirm({ title: 'C' });

    await expect(p3).resolves.toBe(false);
    // 队列没被撑爆
    expect(useConfirmStore.getState().queue).toHaveLength(1);
    // 用户得到了明确反馈(不是静默吞掉)
    expect(useToast.getState().toasts.length).toBeGreaterThan(0);
    expect(useToast.getState().toasts[0].type).toBe('info');

    useConfirmStore.getState().close(true);
    await expect(p1).resolves.toBe(true);
    useConfirmStore.getState().close(true);
    await expect(p2).resolves.toBe(true);
  });

  it('close 后 active/resolve 被清空(不留悬挂态)', () => {
    void confirm({ title: 'T1' });
    useConfirmStore.getState().close(true);
    const st = useConfirmStore.getState();
    expect(st.active).toBeNull();
    expect(st.resolve).toBeNull();
  });
});

describe('renderer 原生对话框禁令(r206)', () => {
  it('renderer 源码里零 window.confirm / window.alert / window.prompt', () => {
    const hits: string[] = [];
    for (const file of walk(RENDERER)) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const re of [/window\s*\.\s*confirm\b/g, /window\s*\.\s*alert\b/g, /window\s*\.\s*prompt\b/g]) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(code)) !== null) {
          hits.push(`${file.slice(ROOT.length + 1)} → ${m[0]}`);
        }
      }
    }
    expect(hits, `renderer 不许用原生阻塞式对话框:\n${hits.join('\n')}`).toEqual([]);
  });

  it('hooks/ 与 lib/ 不得 import components/* 的**值**(type-only 除外)', () => {
    const hits: string[] = [];
    for (const dir of ['hooks', 'lib']) {
      const base = join(RENDERER, dir);
      for (const file of walk(base)) {
        const code = stripComments(readFileSync(file, 'utf8'));
        // 值 import:import { x } from '../components/...' / import x from ...
        const re = /^import\s+(?!type\b)(?!\{[^}]*\btype\b)[^;]*?from\s+['"][^'"]*\/components\/[^'"]*['"]/gm;
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(code)) !== null) {
          hits.push(`${file.slice(ROOT.length + 1)} → ${m[0].trim()}`);
        }
      }
    }
    expect(
      hits,
      `renderer 的 hooks/ 与 lib/ 不得反向依赖 components/(层级倒挂):\n${hits.join('\n')}`,
    ).toEqual([]);
  });

  it('useDiskFolderSidebar 的删除确认走应用内 confirm + i18n key', () => {
    const src = readFileSync(join(RENDERER, 'hooks/useDiskFolderSidebar.ts'), 'utf8');
    expect(src).toMatch(/await confirm\(\{/);
    // 文案必须走 t(...) 而不是硬编码英文
    expect(src).toMatch(/t\('folders\.deleteConfirmTitle'\)/);
    expect(src).toMatch(/t\('folders\.deleteConfirmBody',\s*\{\s*name:/);
  });
});
