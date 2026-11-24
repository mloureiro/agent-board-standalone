import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import boundaries from './tools/repo/eslint/index.js';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'wiki/**', '.claude/worktrees/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,mts,js,mjs}'],
    plugins: { boundaries },
    rules: { 'boundaries/parts': 'error' },
  },
);
