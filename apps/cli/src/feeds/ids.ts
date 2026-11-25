import { createHash } from 'node:crypto';

export function feedIdOf(name: string): string {
  return createHash('sha256').update(`feed:${name}`).digest('hex').slice(0, 16);
}
