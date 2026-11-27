import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { locatePart, missingParts, REPO_ROOT } from '../src/harness/paths.js';

const present = path.join(REPO_ROOT, 'e2e', 'package.json');

describe('missingParts', () => {
  it('defaults each part to its build output', () => {
    expect(
      (['api', 'cli', 'web', 'migrate'] as const).map((part) => locatePart(part, {}).path),
    ).toEqual([
      'apps/api/dist/main.js',
      'apps/cli/dist/rumo',
      'apps/web/dist',
      'apps/migrate/dist/main.js',
    ]);
  });

  it('reports each unbuilt part with the path it looked at', () => {
    expect(
      missingParts(['api', 'cli', 'web', 'migrate'], {
        RUMO_API_BIN: 'unbuilt/api',
        RUMO_CLI_BIN: 'unbuilt/rumo',
        RUMO_WEB_ROOT: 'unbuilt/web',
        RUMO_MIGRATE_BIN: 'unbuilt/migrate',
      }),
    ).toEqual([
      { part: 'api', path: 'unbuilt/api' },
      { part: 'cli', path: 'unbuilt/rumo' },
      { part: 'web', path: 'unbuilt/web' },
      { part: 'migrate', path: 'unbuilt/migrate' },
    ]);
  });

  it.each([
    ['api', 'RUMO_API_BIN'],
    ['cli', 'RUMO_CLI_BIN'],
    ['web', 'RUMO_WEB_ROOT'],
    ['migrate', 'RUMO_MIGRATE_BIN'],
  ] as const)('finds %s through %s', (part, variable) => {
    expect(missingParts([part], { [variable]: present })).toEqual([]);
  });

  it('reports the override path when the override does not exist', () => {
    expect(missingParts(['api'], { RUMO_API_BIN: '/nowhere/api.js' })).toEqual([
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
