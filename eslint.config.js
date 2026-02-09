import js from '@eslint/js'
import globals from 'globals'
import reactPlugin from 'eslint-plugin-react'
import reactHooksPlugin from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'
import prettierConfig from 'eslint-config-prettier'

export default [
  {
    ignores: ['dist/**', 'dist-electron/**', 'release/**', 'build/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {
      quotes: ['error', 'single', { avoidEscape: true }],
      semi: ['error', 'never'],

      // Keep lint usable for this codebase; TypeScript/Prettier cover most of the strictness.
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-useless-catch': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': 'warn',

      ...reactHooksPlugin.configs.recommended.rules,

      // New JSX transform doesn't require React in scope
      'react/react-in-jsx-scope': 'off',
    },
  },
  prettierConfig,
]
