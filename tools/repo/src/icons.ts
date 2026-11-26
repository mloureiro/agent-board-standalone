import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface IconTarget {
  part: string;
  source: string;
  output: string;
  keep: string[];
  legacySource?: string;
  foregroundScale?: number;
  androidBackground?: string;
  extras?: IconExtra[];
}

export interface IconExtra {
  source: string;
  output: string;
  size: number;
}

export const ICON_SOURCES_DIR = 'assets/icons';
export const ANDROID_BACKGROUND = '#E9E9EC';
export const ADAPTIVE_SAFE_ZONE = 0.61;
export const SOURCE_SIZE = 1024;

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
    source: `${ICON_SOURCES_DIR}/client.svg`,
    output: 'apps/client-app/src-tauri/icons',
    keep: DESKTOP_KEEP,
  },
  {
    part: 'server-app',
    source: `${ICON_SOURCES_DIR}/server.svg`,
    output: 'apps/server-app/src-tauri/icons',
    keep: DESKTOP_KEEP,
    extras: [
      { source: `${ICON_SOURCES_DIR}/server-tray.svg`, output: 'tray.png', size: 22 },
      { source: `${ICON_SOURCES_DIR}/server-tray.svg`, output: 'tray@2x.png', size: 44 },
    ],
  },
  {
    part: 'mobile',
    source: `${ICON_SOURCES_DIR}/client.svg`,
    output: 'apps/mobile/src-tauri/icons',
    keep: MOBILE_KEEP,
    legacySource: `${ICON_SOURCES_DIR}/client-grey.svg`,
    foregroundScale: ADAPTIVE_SAFE_ZONE,
    androidBackground: ANDROID_BACKGROUND,
  },
];

export const WEB_ICONS: readonly IconExtra[] = [
  { source: `${ICON_SOURCES_DIR}/client.svg`, output: 'apps/web/public/icon-512.png', size: 512 },
  {
    source: `${ICON_SOURCES_DIR}/client-grey.svg`,
    output: 'apps/web/public/apple-touch-icon.png',
    size: 180,
  },
];

export const WEB_FAVICON = {
  source: `${ICON_SOURCES_DIR}/client.svg`,
  output: 'apps/web/public/favicon.svg',
};

function rasterize(svg: string, png: string, size: number): void {
  execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), svg, '-o', png]);
}

function padded(svg: string, png: string, scale: number): void {
  const inner = Math.round(SOURCE_SIZE * scale);
  rasterize(svg, png, inner);
  execFileSync('magick', [
    png,
    '-background',
    'none',
    '-gravity',
    'center',
    '-extent',
    `${SOURCE_SIZE}x${SOURCE_SIZE}`,
    png,
  ]);
}

function tauriIcon(root: string, part: string, source: string, output: string): void {
  execFileSync(
    'pnpm',
    ['--filter', `@agent-board/${part}`, 'exec', 'tauri', 'icon', source, '--output', output],
    { cwd: root, stdio: 'inherit' },
  );
}

export function generateIcons(root: string, target: IconTarget): void {
  const scratch = mkdtempSync(join(tmpdir(), 'icons-'));
  try {
    const main = join(scratch, 'main.png');
    const mainOut = join(scratch, 'main');
    if (target.foregroundScale) padded(join(root, target.source), main, target.foregroundScale);
    else rasterize(join(root, target.source), main, SOURCE_SIZE);
    tauriIcon(root, target.part, main, mainOut);

    const destination = join(root, target.output);
    mkdirSync(destination, { recursive: true });
    for (const entry of target.keep) {
      rmSync(join(destination, entry), { recursive: true, force: true });
      cpSync(join(mainOut, entry), join(destination, entry), { recursive: true });
    }

    if (target.legacySource) {
      const legacy = join(scratch, 'legacy.png');
      const legacyOut = join(scratch, 'legacy');
      rasterize(join(root, target.legacySource), legacy, SOURCE_SIZE);
      tauriIcon(root, target.part, legacy, legacyOut);
      for (const density of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
        for (const name of ['ic_launcher.png', 'ic_launcher_round.png']) {
          const path = `android/mipmap-${density}/${name}`;
          cpSync(join(legacyOut, path), join(destination, path));
        }
      }
      const full = join(root, target.source);
      rasterize(full, join(destination, 'icon.png'), 512);
    }

    if (target.androidBackground) {
      writeFileSync(
        join(destination, 'android/values/ic_launcher_background.xml'),
        `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n  <color name="ic_launcher_background">${target.androidBackground}</color>\n</resources>\n`,
      );
    }

    for (const extra of target.extras ?? []) {
      rasterize(join(root, extra.source), join(destination, extra.output), extra.size);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function generateWebIcons(root: string): void {
  mkdirSync(join(root, 'apps/web/public'), { recursive: true });
  cpSync(join(root, WEB_FAVICON.source), join(root, WEB_FAVICON.output));
  for (const icon of WEB_ICONS)
    rasterize(join(root, icon.source), join(root, icon.output), icon.size);
}

function main(): void {
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  for (const target of ICON_TARGETS) generateIcons(root, target);
  generateWebIcons(root);
}

if (import.meta.main) main();
