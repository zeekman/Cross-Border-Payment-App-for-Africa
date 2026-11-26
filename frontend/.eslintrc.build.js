// Correctness-only ESLint config enforced by `npm run build` and CI (FE-126).
// Style rules from .eslintrc.js stay advisory until that debt is paid down.
module.exports = {
  root: true,
  env: { browser: true, es2021: true, jest: true, node: true },
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module', ecmaFeatures: { jsx: true } },
  plugins: ['react', 'react-hooks'],
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
  },
};
