import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADDRESS_CASES } from '../src/address/cases.js';
import { HANDOVER_CASES } from '../src/handover/cases.js';
import { CLIENT_APP_BUNDLE_ID } from '../src/handover/handover.js';
import { buildOpenApi } from './openapi.js';

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
};

export const buildContract = async (outDir: string): Promise<void> => {
  await writeJson(join(outDir, 'cases', 'address.json'), ADDRESS_CASES);
  await writeJson(join(outDir, 'cases', 'handover.json'), HANDOVER_CASES);
  await writeJson(join(outDir, 'cases', 'bundle-id.json'), { bundleId: CLIENT_APP_BUNDLE_ID });
  await writeJson(join(outDir, 'openapi.json'), buildOpenApi());
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildContract(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist'));
}
