// Correctness-only ESLint config enforced by `npm run build` and CI (FE-126).
// Style rules from .eslintrc.js stay advisory until that debt is paid down.
module.exports = {
  root: true,
  env: { browser: true, es2021: true, jest: true, node: true },
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
  plugins: ['react', 'react-hooks', 'i18next'],
  settings: { react: { version: 'detect' } },
  rules: {
    'no-restricted-syntax': [
      'error',
      {
        selector: "LogicalExpression[operator='||'] > CallExpression.left[callee.name='t']",
        message: "t() returns the key when missing, so || never falls back. Use t('key', 'Default').",
      },
    ],
    'no-undef': 'error',
    'no-unreachable': 'error',
    'no-dupe-keys': 'error',
    'react/jsx-no-undef': 'error',
    'react/jsx-uses-react': 'error',
    'react/jsx-uses-vars': 'error',
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',
    // FE-221: prevent hard-coded English strings in translated pages.
    // Flags JSX text nodes and literal arguments passed to toast.* helpers.
    'i18next/no-literal-string': [
      'error',
      {
        mode: 'jsx-text-only',
        'should-validate-template': true,
        jsx: {
          'allowed-attributes': [],
        },
        callees: {
          exclude: [],
        },
        words: {
          exclude: [],
        },
      },
    ],
  },
  overrides: [
    {
      // Enforce no-literal-string on toast.* arguments in pages and components.
      files: ['src/pages/**/*.{js,jsx}', 'src/components/**/*.{js,jsx}'],
      rules: {
        'i18next/no-literal-string': [
          'error',
          {
            mode: 'all',
            'should-validate-template': true,
            jsx: {
              'allowed-attributes': [],
            },
            callees: {
              exclude: [],
            },
            words: {
              exclude: [],
            },
          },
        ],
      },
    },
  ],
};