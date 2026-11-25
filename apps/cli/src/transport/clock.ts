import { readFileSync } from 'node:fs';

export function clockOffsetMs(env: Readonly<Record<string, string | undefined>>): number {
  if (env.AGENT_BOARD_E2E !== '1') return 0;
  const file = env.AGENT_BOARD_CLOCK_OFFSET_FILE;
  if (file === undefined || file === '') return 0;
  try {
    const seconds = Number.parseFloat(readFileSync(file, 'utf8').trim());
    return Number.isFinite(seconds) ? seconds * 1000 : 0;
  } catch {
    return 0;
  }
}

export function now(env: Readonly<Record<string, string | undefined>>): number {
  return Date.now() + clockOffsetMs(env);
}
