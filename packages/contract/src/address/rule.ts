export type AddressProblem = 'invalid' | 'insecure' | 'credentials' | 'pinning-disabled';

export type AddressResult = { ok: true; url: string } | { ok: false; problem: AddressProblem };

export const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

export const PINNED_LAN_ENABLED = false;

const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const PRIVATE_IPV4_PATTERN =
  /^(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})$/;
const UNIQUE_LOCAL_IPV6_PATTERN = /^\[f[cd][0-9a-f]{2}:/;

const fail = (problem: AddressProblem): AddressResult => ({ ok: false, problem });

export const isLoopbackUrl = (url: URL): boolean => LOOPBACK_HOSTS.includes(url.hostname);

const parseWebUrl = (input: string): URL | undefined => {
  try {
    const url = new URL(input.trim());
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== ''
      ? url
      : undefined;
  } catch {
    return undefined;
  }
};

const isPrivateHost = (hostname: string): boolean =>
  PRIVATE_IPV4_PATTERN.test(hostname) ||
  UNIQUE_LOCAL_IPV6_PATTERN.test(hostname) ||
  hostname.endsWith('.local');

export const checkAddress = (
  input: string,
  options: { pinnedFingerprint?: string } | undefined,
  pinnedLanEnabled: boolean,
): AddressResult => {
  const fingerprint = options?.pinnedFingerprint;
  if (fingerprint !== undefined && !pinnedLanEnabled) return fail('pinning-disabled');

  const url = parseWebUrl(input);
  if (url === undefined) return fail('invalid');
  if (url.username !== '' || url.password !== '') return fail('credentials');

  if (fingerprint !== undefined) {
    return url.protocol === 'https:' &&
      isPrivateHost(url.hostname) &&
      FINGERPRINT_PATTERN.test(fingerprint)
      ? { ok: true, url: url.href }
      : fail('invalid');
  }

  if (url.protocol === 'http:' && !isLoopbackUrl(url)) return fail('insecure');

  return { ok: true, url: url.href };
};

export const checkServerAddress = (
  input: string,
  options?: { pinnedFingerprint?: string },
): AddressResult => checkAddress(input, options, PINNED_LAN_ENABLED);
