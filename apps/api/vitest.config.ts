import { defineConfig } from 'vitest/config';

const shared = { testTimeout: 30_000, hookTimeout: 120_000 };

// board_app is one cluster-wide role; these files rewrite its password, so no other file may connect meanwhile.
const ROLE_PASSWORD_FILES = ['test/integration/database-driver.test.ts'];

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          ...shared,
          name: 'shared-cluster',
          include: ['test/**/*.test.ts'],
          exclude: ROLE_PASSWORD_FILES,
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          ...shared,
          name: 'role-password',
          include: ROLE_PASSWORD_FILES,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
