// commitlint.config.cjs
//
// 验证规则仅作用于 conventional 格式(feat: ... / fix(scope): ... / chore: ...)。
// 项目风格的 [prefix] subject 会先由 .husky/commit-msg 的 preprocess 脚本
// 转成 conventional 格式,这里不需要识别 [prefix]。
//
// type-enum 接受项目所有 prefix + 常规 conventional type:
//   workbench / cleanup / ui / docs / spec / plan / test / audit
//   feat / fix / refactor / perf / style / build / ci / chore / revert
// audit round 8 (2026-09-14):把 type-enum 提到 module.exports.types ——
//   scripts/commit-msg-preprocess.cjs 之前内联一份 FALLBACK_TYPES,与这里
//   的 type-enum 漂移风险(double source of truth)。现在 preprocess require
//   本文件拿 .types,仅在 require 失败时才走自身 FALLBACK_TYPES,白名单永远
//   单一真相。规则仍然在 rules.type-enum 里持有数组,commitlint 自己也读那处,
//   .types 只是导出别名,两边永远同步。
const TYPES = [
  'workbench', 'cleanup', 'ui', 'docs', 'spec', 'plan', 'test', 'audit',
  'feat', 'fix', 'refactor', 'perf', 'style', 'build', 'ci', 'chore', 'revert',
];

module.exports = {
  extends: ['@commitlint/config-conventional'],
  types: TYPES,
  rules: {
    'header-max-length': [2, 'always', 80],
    'type-enum': [2, 'always', TYPES],
    'type-case': [2, 'always', 'lower-case'],
    'type-empty': [2, 'never'],
    'subject-empty': [2, 'never'],
    'subject-full-stop': [2, 'never', '.'],
    'header-case': [0],  // 项目习惯混用大小写,不强制
  },
};