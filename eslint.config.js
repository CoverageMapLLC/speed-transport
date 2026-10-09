import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: ['./tsconfig.json'],
      },
      globals: {
        AbortSignal: 'readonly',
        AbortController: 'readonly',
        ArrayBuffer: 'readonly',
        Buffer: 'readonly',
        DOMException: 'readonly',
        Event: 'readonly',
        EventTarget: 'readonly',
        MessageEvent: 'readonly',
        URL: 'readonly',
        WebSocket: 'readonly',
        clearInterval: 'readonly',
        clearTimeout: 'readonly',
        console: 'readonly',
        crypto: 'readonly',
        fetch: 'readonly',
        performance: 'readonly',
        process: 'readonly',
        setImmediate: 'readonly',
        setInterval: 'readonly',
        setTimeout: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      'no-undef': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Plain JavaScript scripts run directly by Node.js: benchmarks, Autobahn, packaging.
    files: ['**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: {
        Atomics: 'readonly',
        BigInt64Array: 'readonly',
        Buffer: 'readonly',
        SharedArrayBuffer: 'readonly',
        URL: 'readonly',
        WebSocket: 'readonly',
        console: 'readonly',
        performance: 'readonly',
        process: 'readonly',
        setInterval: 'readonly',
        setTimeout: 'readonly',
      },
    },
  },
  {
    ignores: ['dist/**', 'coverage/**', 'autobahn/reports/**', 'autobahn/config/**'],
  },
];
