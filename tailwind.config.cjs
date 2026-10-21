/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  // safelist:防止动态 class 被摇树
  // 用法:'bg-module-library/50' 这种 module 色 + 透明度组合在 i18n / 模块切换里动态拼接
  // 重构 (2026-09 V1.4):home / collections / favorites / recent / trash 模块下架,
  //   safelist 同步收窄到 2 个活模块(library / notes)。
  safelist: [
    { pattern: /(bg|text|border|ring)-(module)-(library|notes)/ },
    { pattern: /(bg|text|border|ring|shadow)-(danger|warning|success|accent)/ },
    // r247:新增的 danger-strong(实心危险按钮底)—— 同款显式登记。
    { pattern: /(bg|text|border|ring)-(danger-strong)/ },
    { pattern: /(bg|text|border|ring)-(success-strong|warning-strong)/ },
  ],
  // audit-r143 (2026-10-19) A6:darkMode 改 selector 模式。
  //   原值 'class' 要求 <html> 挂 .dark 类才激活 dark: 变体 —— 但本项目的主题
  //   机制是 lib/theme.ts 在 <html> 上加/去 .light 类(:root 默认即深色,
  //   :root.light 覆盖为浅色),从来不挂 .dark。结果:dark: 变体全 dead code。
  //   chrome.tsx:128 的 `dark:shadow-[...]` 在深色主题下也未生效(本应加深阴影)。
  //   改 selector 模式匹配 :root:not(.light) = "未切到 light" = 深色主题,
  //   暗主题下 dark: 变体立刻激活。浅色主题依然不匹配,行为正确。
  darkMode: ['selector', ':root:not(.light)'],
  theme: {
    extend: {
      fontFamily: {
        // perf:移除 Inter — 远程字体会阻塞 FCP,见 index.html 注释。
        // 系统 sans 栈覆盖 Win/Mac/iOS/Android/桌面 Linux,视觉差异极小。
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          'PingFang SC',
          'Microsoft YaHei',
          'Segoe UI',
          'Helvetica Neue',
          'sans-serif',
        ],
        mono: [
          'JetBrains Mono',
          'SF Mono',
          'Menlo',
          'Monaco',
          'Consolas',
          'monospace',
        ],
      },
      // 所有颜色都引用 globals.css 中定义的 RGB 通道 CSS 变量 (--*-rgb)
      // 配合 rgb(var(--xxx-rgb) / <alpha-value>) 语法,Tailwind 的
      // 透明度修饰符 (bg-danger/10) 可正常生效。
      // :root 为浅色默认值,.dark 选择器覆盖为暗色 — 切换时仅需在
      // <html> 上增删 .dark 类 (见 store/library.ts: applyTheme)。
      colors: {
        bg: {
          DEFAULT: 'rgb(var(--bg-rgb) / <alpha-value>)',
          surface: 'rgb(var(--bg-surface-rgb) / <alpha-value>)',
          raised: 'rgb(var(--bg-raised-rgb) / <alpha-value>)',
          hover: 'rgb(var(--bg-hover-rgb) / <alpha-value>)',
          // 新增 V1.5 (2026-09-02):active 态(segmented control / active chip)—
          //   比 hover 略强,标识"已按下 / 选中"的 chip / toggle
          active: 'rgb(var(--bg-active-rgb) / <alpha-value>)',
          canvas: 'rgb(var(--bg-canvas-rgb) / <alpha-value>)',
          // 新增:深色选中态(树文件/列表行)— VSCode 深蓝
          selected: 'rgb(var(--bg-selected-rgb) / <alpha-value>)',
        },
        border: {
          DEFAULT: 'rgb(var(--border-rgb) / <alpha-value>)',
          strong: 'rgb(var(--border-strong-rgb) / <alpha-value>)',
          focus: 'rgb(var(--border-focus-rgb) / <alpha-value>)',
          // 新增:比 DEFAULT 更弱,用在分割线、面板内细分隔
          subtle: 'rgb(var(--border-subtle-rgb) / <alpha-value>)',
        },
        fg: {
          DEFAULT: 'rgb(var(--fg-rgb) / <alpha-value>)',
          secondary: 'rgb(var(--fg-secondary-rgb) / <alpha-value>)',
          tertiary: 'rgb(var(--fg-tertiary-rgb) / <alpha-value>)',
          muted: 'rgb(var(--fg-muted-rgb) / <alpha-value>)',
        },
        accent: {
          DEFAULT: 'rgb(var(--accent-rgb) / <alpha-value>)',
          hover: 'rgb(var(--accent-hover-rgb) / <alpha-value>)',
          dim: 'rgb(var(--accent-dim-rgb) / <alpha-value>)',
        },
        success: 'rgb(var(--success-rgb) / <alpha-value>)',
        warning: 'rgb(var(--warning-rgb) / <alpha-value>)',
        // r247:状态色「实心底」专用档(见 globals.css 状态色两槽注释)——
        //   原色在 Dracula / Nord 这类鲜亮配色里压白字只有 1.1~2.0:1,
        //   实心 toast / 按钮必须走 strong 档(white ≥ 4.8:1)。
        'success-strong': 'rgb(var(--success-strong-rgb) / <alpha-value>)',
        'warning-strong': 'rgb(var(--warning-strong-rgb) / <alpha-value>)',
        danger: 'rgb(var(--danger-rgb) / <alpha-value>)',
        // r247:危险色「实心底」专用档 —— 供 .btn-danger / 危险 toast 用。
        //   --danger-rgb 是「色」(图标 / 文字 / 描边),而实心按钮是「底 + 白字」:
        //   Dracula #FF5555 / Gruvbox #FB4934 这类鲜红压白字只有 3.1~3.2:1
        //   (WCAG AA 正文要 4.5:1)⇒ 单独开一档深红给实心底用。
        'danger-strong': 'rgb(var(--danger-strong-rgb) / <alpha-value>)',
        // Modal/Drawer/Confirm 遮罩 — bg-overlay-scrim/65 走 token,
        // 浅色 bg-overlay-scrim/55 暗色 bg-overlay-scrim/65 之类可继续调透明度
        'overlay-scrim': 'rgb(var(--overlay-scrim-rgb) / <alpha-value>)',
        // 模块语义色 — 给每个工作台模块一个固定色彩身份
        // 用法:bg-module-library/10, text-module-library, ring-module-library/40
        // 重构 (2026-09 V1.4):home / collections / favorites / recent / trash 模块下架,
        //   对应的 --module-*-rgb CSS 变量已删除(globals.css 5 个 selector 同步清理),
        //   剩下 library / notes 两个活模块保留。
        module: {
          library:     'rgb(var(--module-library-rgb) / <alpha-value>)',
          notes:       'rgb(var(--module-notes-rgb) / <alpha-value>)',
        },
      },
      fontSize: {
        // 整体放大 1 档 (2026-07-29 优化):
        //   旧: 2xs 12 / xs 13 / sm 14 / base 15 / lg 17
        //   新: 2xs 13 / xs 14 / sm 15 / base 16 / lg 18
        // 桌面端 body 默认 16px,符合用户「字号不要偏小」偏好
        '2xs': ['0.8125rem', { lineHeight: '1.25rem' }],
        xs: ['0.875rem', { lineHeight: '1.375rem' }],
        sm: ['0.9375rem', { lineHeight: '1.5rem' }],
        base: ['1rem', { lineHeight: '1.625rem' }],
        lg: ['1.125rem', { lineHeight: '1.75rem' }],
      },
      // 阴影 — 深色模式更明显,需要加透明度补偿
      boxShadow: {
        xs: '0 1px 2px 0 rgb(0 0 0 / 0.06)',
        sm: '0 1px 2px 0 rgb(0 0 0 / 0.08), 0 1px 3px 0 rgb(0 0 0 / 0.10)',
        md: '0 4px 6px -1px rgb(0 0 0 / 0.12), 0 2px 4px -2px rgb(0 0 0 / 0.12)',
        lg: '0 10px 15px -3px rgb(0 0 0 / 0.20), 0 4px 6px -4px rgb(0 0 0 / 0.15)',
        modal: '0 24px 38px -8px rgb(0 0 0 / 0.40), 0 8px 16px -8px rgb(0 0 0 / 0.30)',
        // audit-r145f (2026-10-19) MED:空状态 hero icon 升起阴影。
        //   浅色 ambient halo(0.04 + 0.04 两层弱,1px + 4-12px),深色下需
        //   加重维持层次(0.20 + 0.12),因此拆 heroIcon / heroIcon-strong
        //   两档,使用处走 shadow-heroIcon dark:shadow-heroIcon-strong 切换。
        //   此前是 12-token arbitrary 值散在 chrome.tsx:128,锁进 token 后
        //   后续调色统一改 tailwind.config.cjs 一处。
        heroIcon: '0 1px 2px rgb(0 0 0 / 0.04), 0 4px 12px rgb(0 0 0 / 0.04)',
        'heroIcon-strong':
          '0 1px 2px rgb(0 0 0 / 0.20), 0 8px 24px rgb(0 0 0 / 0.12)',
      },
      borderRadius: {
        // 统一圆角档位,与 globals.css 顶部 "设计 token 参考" 块保持一致
        // 按钮 / 输入 / 芯片 → rounded (4px,VSCode 风)。来自 .btn / .input-base / Kbd
        // 列表行 / 卡片     → rounded-md (6px)
        // 面板 / 模态 / 抽屉 → rounded-md (6px,跨面板一致,避免"边角变胖")
        // hero / empty 大盒  → rounded-xl/2xl
        // 进度条 / 小圆点    → rounded-full
        // 实际尺寸:Tailwind 默认 rounded=4px / rounded-md=6px / rounded-lg=8px /
        //           rounded-xl=12px / rounded-2xl=16px,无需自定义
        '4xl': '2rem',
      },
      transitionDuration: {
        '120': '120ms',
        // audit-r146 (2026-10-19) HIGH:StartupOverlay 启动卡片用
        //   `animate-in slide-up-fade duration-180`,但此前没注册 → 类名
        //   no-op,Tailwind 默认 150ms 兜底(与 Modal 入场撞档)。
        //   globals.css:77 文档把它列为项目 token「180ms Toast 上滑进入
        //   稍慢一点(180 vs 150)」,漏实现。补上。
        '180': '180ms',
      },
      // 工作台 chrome 高度 token
      // 见 globals.css :root 中的 --titlebar-h / --statusbar-h / --tabsbar-h
      // 用法:<header className="h-titlebar">、<footer className="h-statusbar">
      // 任何修改走 CSS 变量,tailwind 这边读取生效。
      height: {
        titlebar: 'var(--titlebar-h)',
        statusbar: 'var(--statusbar-h)',
        tabs: 'var(--tabsbar-h)',
      },
      minHeight: {
        titlebar: 'var(--titlebar-h)',
        statusbar: 'var(--statusbar-h)',
        tabs: 'var(--tabsbar-h)',
      },
      // audit-r153 (2026-10-19) design HIGH #3:面板 max-h 单一来源
      //   Modal / SearchPanel 之前各写 max-h-[90vh] / max-h-[80vh] 漂移,
      //   收 token 留 20% 给 statusbar + 标题头;后续 Drawer 等新原语跟
      //   同一数值,改一处全站。
      maxHeight: {
        panel: '80vh',
      },
    },
  },
  plugins: [],
};
