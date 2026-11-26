import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface IconTarget {
  part: string;
  source: string;
  output: string;
  keep: string[];
}

const DESKTOP_KEEP = [
  '32x32.png',
  '128x128.png',
  '128x128@2x.png',
  'icon.icns',
  'icon.ico',
  'icon.png',
];
const MOBILE_KEEP = [
  '32x32.png',
  '64x64.png',
  '128x128.png',
  '128x128@2x.png',
  'icon.png',
  'android',
];

export const ICON_TARGETS: readonly IconTarget[] = [
  {
    part: 'client-app',
    source: 'assets/icons/client-app.png',
    output: 'apps/client-app/src-tauri/icons',
    keep: DESKTOP_KEEP,
  },
  {
    part: 'server-app',
    source: 'assets/icons/server-app.png',
    output: 'apps/server-app/src-tauri/icons',
    keep: DESKTOP_KEEP,
  },
  {
    part: 'mobile',
    source: 'assets/icons/client-app.png',
    output: 'apps/mobile/src-tauri/icons',
    keep: MOBILE_KEEP,
  },
];

export function generateIcons(root: string, target: IconTarget): void {
  const scratch = mkdtempSync(join(tmpdir(), 'icons-'));
  try {
    execFileSync(
      'pnpm',
      [
        '--filter',
        `@agent-board/${target.part}`,
        'exec',
        'tauri',
        'icon',
        join(root, target.source),
        '--output',
        scratch,
      ],
      { cwd: root, stdio: 'inherit' },
    );
    const destination = join(root, target.output);
    mkdirSync(destination, { recursive: true });
    for (const entry of target.keep) {
      rmSync(join(destination, entry), { recursive: true, force: true });
      cpSync(join(scratch, entry), join(destination, entry), { recursive: true });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main(): void {
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  for (const target of ICON_TARGETS) generateIcons(root, target);
}

if (import.meta.main) main();
