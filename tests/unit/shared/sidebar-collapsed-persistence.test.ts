// tests/unit/shared/sidebar-collapsed-persistence.test.ts
//
// 守 r242「折叠 / 展开左侧栏」的**持久化与接线**契约。
//
// 背景:左栏折叠态存在 settings.json 的 workspaceLayout.sidebarCollapsed。
// 这条链路上有三个「漏一环就静默失效」的坑,本测逐个钉住:
//
//   ① **ZodWorkspaceLayout 是 .strict()** —— schema 漏加 sidebarCollapsed,
//      renderer 写回的 workspaceLayout 被判「未声明字段」⇒ 整个
//      settings.update 被拒 ⇒ 折叠态永远存不下来(用户每次重启都要
//      再点一次折叠按钮,且可能看到「保存失败」类报错)。
//   ② **主进程 sanitizeWorkspaceLayout 有白名单** —— 只放行
//      statusBarHidden / fontFamily / themePreset;漏加 sidebarCollapsed
//      ⇒ 字段在主进程被剥掉 ⇒ 同 ① 的后果(且没有报错,更难查)。
//   ③ **主进程菜单 → renderer 命令 id** —— View 菜单的「折叠 / 展开
//      左侧栏」点下去是 IPC 推 id 给 dispatcher;id 拼错 ⇒ 菜单项点了
//      没反应(dispatcher 只 warn「unknown command」,用户看不到原因)。
//
// 本测锁:
//   A. ZodWorkspaceLayout 接受 sidebarCollapsed:boolean,拒绝非 boolean,
//      仍然 strict(未知字段照拒)。
//   B. 主进程 sanitize 保留 sidebarCollapsed、剥掉未知字段。
//   C. 主进程 View 菜单有该项(accelerator CmdOrCtrl+B)且发的是
//      'view.toggleSidebar'。
//   D. 菜单里出现的每个命令 id 都能在 renderer 命令注册表里找到
//      (防「菜单项点了没反应」这一类死链)。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ZodWorkspaceLayout } from '../../../src/shared/schemas/settings';
import { sanitizeLoadedSettings } from '../../../src/main/settings/validate';
import { buildCommands, type CommandActions } from '../../../src/renderer/src/command/registry';

const ROOT = process.cwd();
const MENU_FILE = join(ROOT, 'src/main/menu.ts');

describe('左栏折叠态的持久化与接线(r242)', () => {
  it('A1. ZodWorkspaceLayout 接受 sidebarCollapsed:boolean', () => {
    const r = ZodWorkspaceLayout.safeParse({ sidebarCollapsed: true });
    expect(r.success, 'schema 漏加 sidebarCollapsed ⇒ 折叠态存不下来').toBe(true);
    const r2 = ZodWorkspaceLayout.safeParse({});
    expect(r2.success, '未设置折叠态的新用户必须能过 schema').toBe(true);
  });

  it('A2. ZodWorkspaceLayout 拒绝非 boolean 的 sidebarCollapsed', () => {
    expect(ZodWorkspaceLayout.safeParse({ sidebarCollapsed: 'yes' }).success).toBe(false);
    expect(ZodWorkspaceLayout.safeParse({ sidebarCollapsed: 1 }).success).toBe(false);
  });

  it('A3. ZodWorkspaceLayout 仍然 strict(未知字段照拒)', () => {
    expect(ZodWorkspaceLayout.safeParse({ somethingElse: true }).success).toBe(false);
  });

  it('B. 主进程 sanitize 保留 sidebarCollapsed、剥掉未知字段', () => {
    const out = sanitizeLoadedSettings({
      workspaceLayout: { statusBarHidden: true, sidebarCollapsed: true, bogusField: 1 },
    });
    expect(out.workspaceLayout).toMatchObject({
      statusBarHidden: true,
      sidebarCollapsed: true,
    });
    expect(out.workspaceLayout).not.toHaveProperty('bogusField');
  });

  it('C. 主进程 View 菜单有「折叠 / 展开左侧栏」且发 view.toggleSidebar', () => {
    const src = readFileSync(MENU_FILE, 'utf8');
    expect(src, "View 菜单缺少 toggleSidebar 项").toContain("menu.view.toggleSidebar");
    expect(src, "toggleSidebar 菜单项没发 view.toggleSidebar 命令 id").toContain(
      "send('view.toggleSidebar')",
    );
    expect(src, 'toggleSidebar 菜单项的 accelerator 应为 CmdOrCtrl+B').toContain(
      "accelerator: 'CmdOrCtrl+B'",
    );
  });

  it('D. 菜单里出现的每个命令 id 都能在 renderer 命令注册表里找到', () => {
    const src = readFileSync(MENU_FILE, 'utf8');
    const sent = [...src.matchAll(/send\(\s*'([A-Za-z0-9_.]+)'\s*\)/g)].map((m) => m[1]);
    expect(sent.length, '菜单里一个 send() 都没扫到 —— 扫点失效,本测空过').toBeGreaterThan(3);

    const actions = {
      setActive: () => {},
      toggleStatusBar: () => {},
      toggleSidebar: () => {},
      setFontFamily: () => {},
      setThemePreset: () => {},
      toggleTheme: async () => {},
      openSettings: () => {},
      openSearch: () => {},
      saveActiveNote: () => {},
      newNote: () => {},
    } satisfies CommandActions;
    const ids = new Set(buildCommands(actions).map((c) => c.id));

    const orphan = sent.filter((id) => !ids.has(id));
    expect(
      orphan,
      `菜单项的命令 id 在 renderer 注册表里不存在 ⇒ 点了没反应:\n${orphan.join('\n')}`,
    ).toEqual([]);
  });
});
