import { writeFileSync } from 'node:fs';

import type { Tmp } from './tmp.js';

export function setClockOffset(board: { readonly tmp: Tmp }, seconds: number): void {
  writeFileSync(board.tmp.clockFile, String(seconds));
}
