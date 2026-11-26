import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ICON_TARGETS } from '../src/icons.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const PNG_SIGNATURE = '89504e470d0a1a0a';

function pngSize(path: string): { signature: string; width: number; height: number } {
  const bytes = readFileSync(path);
  return {
    signature: bytes.subarray(0, 8).toString('hex'),
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

describe('icon sources', () => {
  const sources = [...new Set(ICON_TARGETS.map((target) => target.source))];

  it.each(sources)('%s is a 1024x1024 PNG', (source) => {
    expect(pngSize(`${root}/${source}`)).toEqual({
      signature: PNG_SIGNATURE,
      width: 1024,
      height: 1024,
    });
  });
});

describe('bundle icons', () => {
  it.each(ICON_TARGETS.map((target) => target.part))(
    '%s lists only icon files that exist',
    (part) => {
      const target = ICON_TARGETS.find((candidate) => candidate.part === part)!;
      const configPath = `${root}/${target.output}/../tauri.conf.json`;
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      const icons: string[] = config.bundle.icon;
      expect(icons.length).toBeGreaterThan(0);
      for (const icon of icons) {
        expect(() => readFileSync(`${root}/${target.output}/../${icon}`)).not.toThrow();
      }
    },
  );
});
