import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { missingParts, REPO_ROOT } from '../src/harness/paths.js';

const present = path.join(REPO_ROOT, 'e2e', 'package.json');

describe('missingParts', () => {
  it('reports each unbuilt part with its default entry point', () => {
    expect(missingParts(['api', 'cli', 'web', 'migrate'], {})).toEqual([
      { part: 'api', path: 'apps/api/dist/main.js' },
      { part: 'cli', path: 'apps/cli/dist/board' },
      { part: 'web', path: 'apps/web/dist' },
      { part: 'migrate', path: 'apps/migrate/dist/main.js' },
    ]);
  });

  it.each([
    ['api', 'AGENT_BOARD_API_BIN'],
    ['cli', 'AGENT_BOARD_CLI_BIN'],
    ['web', 'AGENT_BOARD_WEB_ROOT'],
    ['migrate', 'AGENT_BOARD_MIGRATE_BIN'],
  ] as const)('finds %s through %s', (part, variable) => {
    expect(missingParts([part], { [variable]: present })).toEqual([]);
  });

  it('reports the override path when the override does not exist', () => {
    expect(missingParts(['api'], { AGENT_BOARD_API_BIN: '/nowhere/api.js' })).toEqual([
      { part: 'api', path: '/nowhere/api.js' },
    ]);
  });

  it('treats postgres as missing without E2E_POSTGRES_URL', () => {
    expect(missingParts(['postgres'], {})).toEqual([
      { part: 'postgres', path: 'E2E_POSTGRES_URL' },
    ]);
    expect(
      missingParts(['postgres'], { E2E_POSTGRES_URL: 'postgres://localhost/postgres' }),
    ).toEqual([]);
  });
});
