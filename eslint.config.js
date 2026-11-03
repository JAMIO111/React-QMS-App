import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import react from 'eslint-plugin-react'

export default [
  { ignores: ['dist', 'api/**', 'legacy/**'] },
  {
    files: ['vite.config.js', 'eslint.config.js'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    plugins: {
      react,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react/jsx-uses-vars': 'error',
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      // Icons: Lucide only, through src/components/icons.jsx (shared defaults).
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: 'lucide-react', message: 'Import icons from "@/components/icons" (add new ones there).' }],
          patterns: [{ group: ['react-icons', 'react-icons/*'], message: 'Lucide only: import icons from "@/components/icons".' }],
        },
      ],
    },
  },
  {
    files: ['src/components/icons.jsx'],
    rules: { 'no-restricted-imports': 'off', 'react-refresh/only-export-components': 'off' },
  },
]
