import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Tmp {
  readonly root: string;
  readonly home: string;
  readonly clockFile: string;
  path(...segments: string[]): string;
  remove(): void;
}

function tmpBase(): string {
  return existsSync('/tmp') ? realpathSync('/tmp') : os.tmpdir();
}

export function createTmp(label = 'board', env: NodeJS.ProcessEnv = process.env): Tmp {
  const root = mkdtempSync(path.join(tmpBase(), `rumo-e2e-${label}-`));
  const home = path.join(root, 'home');
  mkdirSync(home, { recursive: true });
  return {
    root,
    home,
    clockFile: path.join(root, 'clock'),
    path: (...segments) => path.join(root, ...segments),
    remove: () => {
      if (env.E2E_KEEP_TMP === '1') return;
      rmSync(root, { recursive: true, force: true });
    },
  };
}
