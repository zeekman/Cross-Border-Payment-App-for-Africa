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
