import { spawnSync } from 'node:child_process';

import { PART_ROOT, RESOURCES_DIR } from './layout.ts';
import { resourcesProblems } from './resources.ts';

if (import.meta.main) {
  const problems = resourcesProblems(RESOURCES_DIR);
  if (problems.length > 0) {
    process.stderr.write(
      `${problems.map((problem) => `- ${problem}`).join('\n')}\nrun \`pnpm --filter @agent-board/server-app run assemble\` first\n`,
    );
    process.exit(1);
  }
  const built = spawnSync(
    'pnpm',
    [
      'exec',
      'tauri',
      'build',
      '--bundles',
      'app',
      '--config',
      JSON.stringify({ bundle: { resources: ['resources/**/*'] } }),
      '--',
      '--package',
      'agent-board-server',
    ],
    { cwd: PART_ROOT, stdio: 'inherit' },
  );
  process.exit(built.status ?? 1);
}
