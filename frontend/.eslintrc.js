module.exports = {
  env: {
    browser: true,
    es2021: true,
    jest: true,
  },
  extends: [
    'airbnb',
    'plugin:react/recommended',
    'plugin:react-hooks/recommended',
    'plugin:jsx-a11y/recommended',
    'prettier'
  ],
  parserOptions: {
    ecmaFeatures: {
      jsx: true,
    },
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  plugins: ['react', 'react-hooks', 'jsx-a11y'],
  rules: {
    'no-restricted-syntax': [
      'error',
      {
        selector: "LogicalExpression[operator='||'] > CallExpression.left[callee.name='t']",
        message: "t() returns the key when missing, so || never falls back. Use t('key', 'Default').",
      },
    ],
    'react/jsx-filename-extension': [1, { extensions: ['.jsx', '.js'] }],
    'react/react-in-jsx-scope': 'off',
    'react/prop-types': 'off',
    'no-console': 'warn',
    'import/prefer-default-export': 'off',
    'no-use-before-define': 'off',
    // Use ConfirmModal (via useConfirm) instead of native dialogs.
    'no-restricted-globals': ['error', 'confirm', 'alert'],
    'no-restricted-properties': [
      'error',
      { object: 'window', property: 'confirm', message: 'Use useConfirm() instead.' },
      { object: 'window', property: 'alert', message: 'Use toast instead.' },
    ],
  },
  overrides: [
    {
      // Background polling must pause in hidden tabs (FE-198): use useVisibleInterval().
      // The override replaces the base options, so confirm/alert are repeated here.
      files: ['src/pages/**/*.{js,jsx}', 'src/hooks/**/*.{js,jsx}'],
      rules: {
        'no-restricted-globals': [
          'error',
          'confirm',
          'alert',
          { name: 'setInterval', message: 'Use useVisibleInterval() from hooks/useVisibleInterval so polling pauses in hidden tabs.' },
        ],
        'no-restricted-properties': [
          'error',
          { object: 'window', property: 'confirm', message: 'Use useConfirm() instead.' },
          { object: 'window', property: 'alert', message: 'Use toast instead.' },
          { object: 'window', property: 'setInterval', message: 'Use useVisibleInterval() from hooks/useVisibleInterval.' },
        ],
      },
    },
    {
      files: ['**/*.test.js', '**/*.test.jsx', '**/__tests__/**'],
      rules: { 'no-restricted-properties': 'off', 'no-restricted-globals': 'off' },
    },
  ],
  settings: {
    react: {
      version: 'detect',
    },
  },
};
