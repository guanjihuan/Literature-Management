// tests/setup.ts
//
// vitest 全局 setup(vitest.config.ts setupFiles 引用)。故意精简:
//   jsdom test gaps(见 memory jsdom-test-gaps)按需 per-case stub,不在全局,
//   避免污染 node 环境测试。所有跨测试副作用都收敛到这个文件,别处不写 top-level
//   import-only-for-side-effect 代码。
export {};
