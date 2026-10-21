import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { existsSync, realpathSync } from 'fs';
import { cp } from 'fs/promises';

// audit r44 (2026-10-15):src/main/db/migrations/*.sql 是 r44 WIP 落地后
//   `applyMigrations` 的输入。electron-vite 主进程构建只 emit TS 入口的 JS 产物,
//   静态 .sql 不在入口依赖图里,默认不会被拷贝到 out/main/。运行时 sqlite.ts
//   走 `applyMigrations(db, join(__dirname, 'migrations'))`(`__dirname` =
//   packaged 形态下 `resources/app/out/main/`),目录不存在 → `readdirSync` 抛
//   ENOENT → `initDB` 拒 → 致命对话框 → 应用无法启动。inline rollup 插件
//   在 closeBundle 阶段把 SQL 拷到 `out/main/migrations/`(r50 修正:原本
//   写 `out/main/db/migrations/` 多一段 `db/`,与 `__dirname/migrations/` 解析
//   路径不一致 → 启动 ENOENT),无需新增 vite-plugin-static-copy 依赖。

const sharedAlias = { '@shared': resolve(__dirname, 'src/shared') };

// start.cjs 在 Windows + CJK 项目路径下会 chdir 到 ASCII junction。
// rollup 内部对 input 走 realpathSync,把 junction 解析回真实 CJK 路径。
// vite 的 html 插件用 path.relative(config.root, normalizedId) 算 emit
// fileName,root 和 normalizedId 必须同盘才能算出相对路径 'index.html';
// 否则跨盘返回绝对路径,触发 "fileName must be neither absolute nor
// relative paths"。所以把 root 和 input 都钉到 realpath 后的 CJK 路径。
const projectRoot = realpathSync(process.cwd());

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin(),
      {
        // audit r44 + r50:把 src/main/db/migrations/*.sql 拷到 out/main/migrations/,
        //   让 `applyMigrations(db, join(__dirname, 'migrations'))` 在 packaged
        //   形态下能找到 SQL 入口(`__dirname` = `out/main/`,join 'migrations'
        //   = `out/main/migrations/`;r50 修正:原 dst 写 `out/main/db/migrations/`
        //   多一段 `db/`,与 __dirname 对齐失败 → 启动 ENOENT)。closeBundle 在
        //   emit 完成、产物已写盘后跑;cp({ recursive: true }) 是幂等的(目标目录
        //   不存在则创建,存在则覆盖同名文件 + 保留新增文件——和 bundler 产物
        //   语义对齐)。
        name: 'copy-migrations',
        closeBundle: async () => {
          const src = resolve(projectRoot, 'src/main/db/migrations');
          const dst = resolve(projectRoot, 'out/main/migrations');
          if (!existsSync(src)) return; // r44 WIP 未落地时 src 不存在,静默跳过
          await cp(src, dst, { recursive: true });
        },
      },
    ],
    resolve: { alias: sharedAlias },
    build: {
      sourcemap: false, // 主进程产物不外发,关 sourcemap 减小
      minify: true,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias },
    build: {
      sourcemap: false,
      minify: true,
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    // 见 projectRoot 注释:rollup 内部把 input realpath 回 CJK 路径,
    // root 必须同盘才能让 path.relative 算出 'index.html'。
    root: resolve(projectRoot, 'src/renderer'),
    // fix(2026-08-27):Vite 5.4 自带 esbuild 0.21.5,在 Node 24 + Windows CJK
    // 项目路径下会触发 TypeError: Cannot read properties of undefined
    // (reading 'imports') (发生在 optimizeDeps 的 depsInfo 合并阶段)。
    // 不升级 esbuild —— vite@5.4.21 的兼容矩阵锁在 ^0.21.3,顶包升级会破坏
    // vite 内部假设。三层兜底走 vite 配置:
    //   1) entries 锁死只扫 main.tsx + i18n,不让 vite 自动扫整个图触发 race
    //   2) include 强制列出真正被顶层引用的 bare deps,跳过自动发现
    //   3) esbuildOptions 显式钉住 vite 默认的 browser/esnext(见下方注释)
    // 副作用:首屏 esbuild 预构建略慢 200~500ms;后面 transform 不受影响。
    // 注:根治手段是清缓存(`npm run dev:clean`)—— 该 race 一旦写坏
    // node_modules/.vite/deps/_metadata.json,后续启动会持续复现。
    optimizeDeps: {
      entries: [
        resolve(projectRoot, 'src/renderer/src/main.tsx'),
        resolve(projectRoot, 'src/renderer/src/i18n/index.ts'),
      ].filter((p) => existsSync(p)) as string[],
      include: [
        'react',
        'react-dom',
        'react-dom/client',
        'react-i18next',
        'i18next',
        'zustand/shallow',
        // 动态 import 的重 dep 必须显式 include — Vite 5.4.21 的 dep
        // optimizer 在 on-the-fly discovery 阶段(markdown-it / codemirror /
        // highlight.js 这些 dynamic import 触发的预构建)会撞到
        // dep-BK3b2jBa.js:50835 的 race,输出 undefined.imports 抛错。
        // 启动期强制 pre-bundle 就绕开 discovery 路径。这是 5.4.x 已知
        // bug,Vite 6 才修。
        'markdown-it',
        'highlight.js/lib/core',
        '@codemirror/state',
        '@codemirror/view',
        '@codemirror/commands',
        '@codemirror/lang-markdown',
        // lucide-react — 整个 renderer 用得最广的图标库(40 个文件 import,
        // 每个图标单独 ESM)。任何 lazy-loaded 路由/视图加载都会触发它的
        // on-the-fly 优化,5.4.21 在它身上稳定撞 dep-BK3b2jBa.js:50835。
        // 预 bundle 解决。
        // audit 2026-09 (V1.9):原注释举例 "Dashboard / Sidebar / RecentView"
        //   —— 三个组件均已下线(Sidebar 被 master-detail + 顶栏取代,
        //   RecentView 随 recent module 一并删除,Dashboard 从未是单一
        //   组件)。改为泛化描述 "任何 lazy-loaded 路由/视图"。
        'lucide-react',
        // audit r40 (2026-10-15):react-virtuoso — 虚拟列表,用于 FavoritesList /
        //   NotesList 等列表组件,首次访问触发 dep discovery race,与
        //   lucide-react 同款机制(5.4.21 dep-BK3b2jBa.js:50835)。预 bundle
        //   避免首屏「new dependencies optimized」+ 整页 reload(+1-2s 卡顿)。
        'react-virtuoso',
      ],
      esbuildOptions: {
        target: 'esnext',
        // platform 与 target 都只是显式钉住 vite 的默认值(browser/esnext),
        // 防止未来改动或插件把 renderer 的预构建误推到 node 分支。
        // 注:renderer 跑在 Electron 30 的 Chromium 里,esnext 完全安全。
        platform: 'browser',
      },
    },
    resolve: {
      alias: {
        ...sharedAlias,
        '@': resolve(__dirname, 'src/renderer/src'),
      },
    },
    server: {
      // 修复:vite dev server 启动时 pre-transform HTML 引用的入口脚本
      // (index.html → /src/main.tsx),在 Windows + CJK 项目路径下抛
      // "Failed to load url /src/main.tsx ... Does the file exist?"。
      // 根因:vite 的 searchForWorkspaceRoot 走 fs.realpathSync 把
      // ASCII junction 解析回真实 CJK 路径,pre-transform 拿到 CJK
      // 绝对路径后,在 worker 里读文件失败。把 server.fs.allow 显式
      // 扩到 junction + 真实路径,让 vite 接受两种路径表达。
      fs: {
        strict: false,
        allow: [
          resolve(__dirname, 'src/renderer'),
          // start.cjs 在 chdir 到 junction 后会设置这个环境变量。
          // dev 时 vite 的 cwd 实际是 junction,所以允许这个路径即可。
          ...(process.env.RKMS_JUNCTION_PATH ? [process.env.RKMS_JUNCTION_PATH] : []),
        ],
      },
    },
    build: {
      // perf (2026-09-06):sourcemap 改 hidden —— 仍 emit .map 文件给线上
      //   stack trace 反解(主进程 / 渲染进程出错能定位源码),但产物
      //   JS 不再带 `//# sourceMappingURL=` 注释 → Sentry / 用户浏览器
      //   devtools 不会自动尝试拉远程 sourcemap(默认行为)。
      //   省:主 bundle 内嵌 sourcemap-data 体积 + 网络请求一个 .map。
      sourcemap: 'hidden',
      // 现代 Electron 内核(Chrome 120+)
      target: 'chrome120',
      // chunk 大小阈值, 超过 1500KB 才告警
      chunkSizeWarningLimit: 1500,
      rollupOptions: {
        // 用 projectRoot(realpath 后)算 input,跟 root 同盘才能让
        // html 插件的 path.relative(config.root, normalizedId) 算出
        // 相对路径 'index.html',否则跨盘返回绝对路径触发 rollup 报错。
        input: { index: resolve(projectRoot, 'src/renderer/index.html') },
        // 不设 vendor manualChunks — vite 的 dynamic import 已经做 code-splitting;
        // 强制 vendor 反让 index.html 解析路径出错。
      },
      // perf(2026-08-22):polyfill:false — 现代 Chrome 120+ 原生支持 ESM dynamic
      // import + import.meta,无需 vite 注入 ~3KB polyfill。settings 必须保留
      // 显式 modulePreload(真),否则 modulepreload 链接不会生成 → 关键 chunk
      // 串行下载,首屏 FCP 退化。
      modulePreload: { polyfill: false },
    },
    plugins: [react()],
  },
});
