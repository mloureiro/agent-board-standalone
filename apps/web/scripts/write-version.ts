import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CONTRACT } from '@rumo/contract';

import { PART_VERSION } from '../src/version.js';

const target = fileURLToPath(new URL('../dist/version.json', import.meta.url));
writeFileSync(target, `${JSON.stringify({ version: PART_VERSION, contract: CONTRACT })}\n`);
