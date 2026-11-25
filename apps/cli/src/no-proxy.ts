const LOOPBACK = ['localhost', '127.0.0.1', '::1', '[::1]'];

export function loopbackNoProxy(current: string | undefined): string {
  const entries = (current ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  const missing = LOOPBACK.filter((entry) => !entries.includes(entry));
  return [...entries, ...missing].join(',');
}
