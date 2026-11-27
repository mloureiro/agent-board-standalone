import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { parts } from '../eslint/parts.js';
import { PARTS } from '../src/parts.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const eslint = new ESLint({ cwd: root });

async function messages(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${root}${filePath}` });
  return result!.messages
    .filter((message) => message.ruleId === 'boundaries/parts')
    .map((message) => message.message);
}

describe('boundaries', () => {
  it('[repo-001] cli importing @rumo/api fails lint', async () => {
    expect(await messages("import '@rumo/api';", 'apps/cli/src/x.ts')).toEqual([
      'cli may not import api; allowed: contract, sealing',
    ]);
  });

  it('[repo-001] cli importing ../../api/src/index.js by relative path fails lint', async () => {
    expect(await messages("import '../../api/src/index.js';", 'apps/cli/src/x.ts')).toEqual([
      'cli may not import api; allowed: contract, sealing',
    ]);
  });

  it('[repo-001] api importing @rumo/contract and @rumo/sealing passes', async () => {
    const code = "import '@rumo/contract';\nimport '@rumo/sealing';\nimport 'zod';";
    expect(await messages(code, 'apps/api/src/x.ts')).toEqual([]);
  });

  it('[repo-001] contract importing @rumo/sealing fails and the reverse', async () => {
    expect(await messages("import '@rumo/sealing';", 'packages/contract/src/x.ts')).toEqual([
      'contract may not import sealing; allowed: nothing',
    ]);
    expect(await messages("import '@rumo/contract';", 'packages/sealing/src/x.ts')).toEqual([
      'sealing may not import contract; allowed: nothing',
    ]);
  });

  it('[repo-001] server-app may import api; client-app and mobile may import web; client-app may not import api', async () => {
    expect(await messages("import '@rumo/api';", 'apps/server-app/src/x.ts')).toEqual([]);
    expect(await messages("import '@rumo/web';", 'apps/client-app/src/x.ts')).toEqual([]);
    expect(await messages("import '@rumo/web';", 'apps/mobile/src/x.ts')).toEqual([]);
    expect(await messages("import '@rumo/api';", 'apps/client-app/src/x.ts')).toEqual([
      'client-app may not import api; allowed: web',
    ]);
  });

  it('[repo-001] dynamic import and export-from are checked', async () => {
    const forbidden = ['cli may not import api; allowed: contract, sealing'];
    expect(await messages("await import('@rumo/api');", 'apps/cli/src/x.ts')).toEqual(forbidden);
    expect(await messages("export * from '@rumo/api';", 'apps/cli/src/x.ts')).toEqual(forbidden);
    expect(await messages("export { a } from '@rumo/api';", 'apps/cli/src/x.ts')).toEqual(
      forbidden,
    );
    expect(await messages("require('@rumo/api');", 'apps/cli/src/x.js')).toEqual(forbidden);
  });

  it("[repo-001] the rule's part table matches PARTS", async () => {
    const { PARTS: ruleParts } = await import('../eslint/parts.js');
    expect(ruleParts).toEqual(PARTS);
    expect(parts.meta.type).toBe('problem');
  });
});
