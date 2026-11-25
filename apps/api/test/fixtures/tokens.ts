export const tokenHashOf = (seed: string, index: number): string =>
  Buffer.from(`${seed}-${index}`).toString('hex').padEnd(64, '0').slice(0, 64);
