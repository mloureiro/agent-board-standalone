import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import boundaries from './tools/repo/eslint/index.js';

const WEB_STORAGE_NAMES = ['localStorage', 'sessionStorage', 'indexedDB'];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-bridge/**',
      '**/node_modules/**',
      '**/src-tauri/target/**',
      '**/src-tauri/gen/**',
      '**/src-tauri/resources/**',
      'wiki/**',
      '.claude/worktrees/**',
      'apps/mobile/src-tauri/**/*.js',
      'apps/mobile/dist-web/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,mts,js,mjs}'],
    plugins: { boundaries },
    rules: { 'boundaries/parts': 'error' },
  },
  {
    files: ['apps/server-app/frontend/**/*.js'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    ignores: ['apps/web/src/storage/**'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...WEB_STORAGE_NAMES.map((name) => ({
          name,
          message: 'Browser storage is reached only through apps/web/src/storage.',
        })),
      ],
      'no-restricted-properties': [
        'error',
        ...['window', 'globalThis', 'self'].flatMap((object) =>
          WEB_STORAGE_NAMES.map((property) => ({
            object,
            property,
            message: 'Browser storage is reached only through apps/web/src/storage.',
          })),
        ),
      ],
    },
  },
);
