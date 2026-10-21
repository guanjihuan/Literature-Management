/// <reference types="vite/client" />
// audit round 8 (2026-09-14):本文件让 import.meta.env.DEV 等 Vite 内建 env
//   字段在 TS 中可见(Vite 默认生成的 vite-env.d.ts 模板)。logger-client
//   用 DEV 区分日志等级,其它文件未来按需扩展 env 字段时 import.meta.env.*
//   不再被 TS 报红。
