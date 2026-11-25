import path from 'node:path';

import { CLI_ROOT, bundle } from './bundle.ts';

await bundle(path.join(CLI_ROOT, 'dist', 'board'));
