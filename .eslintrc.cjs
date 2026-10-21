module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint', 'react', 'react-hooks'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
  ],
  settings: { react: { version: 'detect' } },
  env: { browser: true, node: true, es2022: true },
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  rules: {
    'react/react-in-jsx-scope': 'off',
    // IPC payload 类型从主进程桥接过来,故意用 any 接住,避免双重类型断言噪声
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-unused-vars': [
      'warn',
      {
        // 通用约定:`_` / `_xxx` 显式表达"故意未使用"
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      },
    ],
    // React 状态机驱动 useEffect 依赖,人为控制触发时机比 ESLint 自动推断更可靠
    'react-hooks/exhaustive-deps': 'warn',
  },
  ignorePatterns: ['out/', 'dist/', 'node_modules/'],
};
