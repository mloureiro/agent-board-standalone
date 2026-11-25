import type { MachineState } from '@agent-board/contract';
import { MIN_CLIENT } from '@agent-board/contract';

const numbers = (version: string): number[] =>
  (version.split(/[-+]/)[0] ?? '').split('.').map((part) => Number(part));

export const compareVersions = (left: string, right: string): number => {
  const a = numbers(left);
  const b = numbers(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
};

export interface ReportedClient {
  clientVersion: string | null;
  clientLevel: number | null;
}

export const clientStatus = (client: ReportedClient, advertised: string | null): MachineState => {
  if (client.clientVersion === null && client.clientLevel === null) return 'unknown';
  if (client.clientLevel !== null && client.clientLevel < MIN_CLIENT.cli) return 'incompatible';
  if (
    client.clientVersion !== null &&
    advertised !== null &&
    compareVersions(client.clientVersion, advertised) < 0
  )
    return 'outdated';
  return 'current';
};
