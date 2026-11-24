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
  it('[repo-001] cli importing @agent-board/api fails lint', async () => {
    expect(await messages("import '@agent-board/api';", 'apps/cli/src/x.ts')).toEqual([
      'cli may not import api; allowed: contract, sealing',
    ]);
  });

  it('[repo-001] cli importing ../../api/src/index.js by relative path fails lint', async () => {
    expect(await messages("import '../../api/src/index.js';", 'apps/cli/src/x.ts')).toEqual([
      'cli may not import api; allowed: contract, sealing',
    ]);
  });

  it('[repo-001] api importing @agent-board/contract and @agent-board/sealing passes', async () => {
    const code = "import '@agent-board/contract';\nimport '@agent-board/sealing';\nimport 'zod';";
    expect(await messages(code, 'apps/api/src/x.ts')).toEqual([]);
  });

  it('[repo-001] contract importing @agent-board/sealing fails and the reverse', async () => {
    expect(await messages("import '@agent-board/sealing';", 'packages/contract/src/x.ts')).toEqual([
      'contract may not import sealing; allowed: nothing',
    ]);
    expect(await messages("import '@agent-board/contract';", 'packages/sealing/src/x.ts')).toEqual([
      'sealing may not import contract; allowed: nothing',
    ]);
  });

  it('[repo-001] server-app may import api; client-app and mobile may import web; client-app may not import api', async () => {
    expect(await messages("import '@agent-board/api';", 'apps/server-app/src/x.ts')).toEqual([]);
    expect(await messages("import '@agent-board/web';", 'apps/client-app/src/x.ts')).toEqual([]);
    expect(await messages("import '@agent-board/web';", 'apps/mobile/src/x.ts')).toEqual([]);
    expect(await messages("import '@agent-board/api';", 'apps/client-app/src/x.ts')).toEqual([
      'client-app may not import api; allowed: web',
    ]);
  });

  it('[repo-001] dynamic import and export-from are checked', async () => {
    const forbidden = ['cli may not import api; allowed: contract, sealing'];
    expect(await messages("await import('@agent-board/api');", 'apps/cli/src/x.ts')).toEqual(
      forbidden,
    );
    expect(await messages("export * from '@agent-board/api';", 'apps/cli/src/x.ts')).toEqual(
      forbidden,
    );
    expect(await messages("export { a } from '@agent-board/api';", 'apps/cli/src/x.ts')).toEqual(
      forbidden,
    );
    expect(await messages("require('@agent-board/api');", 'apps/cli/src/x.js')).toEqual(forbidden);
  });

  it("[repo-001] the rule's part table matches PARTS", async () => {
    const { PARTS: ruleParts } = await import('../eslint/parts.js');
    expect(ruleParts).toEqual(PARTS);
    expect(parts.meta.type).toBe('problem');
  });
});
