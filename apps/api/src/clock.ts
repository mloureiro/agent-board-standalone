import { readFileSync } from 'node:fs';

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

const offsetMs = (file: string): number => {
  try {
    const seconds = Number.parseFloat(readFileSync(file, 'utf8').trim());
    return Number.isFinite(seconds) ? seconds * 1000 : 0;
  } catch {
    return 0;
  }
};

export const clockFromEnv = (env: Readonly<Record<string, string | undefined>>): Clock => {
  const file = env.AGENT_BOARD_CLOCK_OFFSET_FILE;
  if (env.AGENT_BOARD_E2E !== '1' || file === undefined || file === '') return systemClock;
  return { now: () => new Date(Date.now() + offsetMs(file)) };
};

export const fixedClock = (initial: Date): Clock & { set(next: Date): void } => {
  let current = initial;
  return {
    now: () => current,
    set: (next) => {
      current = next;
    },
  };
};
