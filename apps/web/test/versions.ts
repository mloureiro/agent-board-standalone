import { parseServerVersion } from '../src/servers/index.js';

export const versionDocument = (overrides: Record<string, unknown> = {}): unknown => ({
  contract: 1,
  minClient: { cli: 1, web: 1 },
  features: [],
  server: { version: '1.0.0', commit: null },
  modules: { signIn: [], requestSignature: false, scheduling: true, feeds: true },
  session: 'not-required',
  ...overrides,
});

export const serverVersion = (overrides: Record<string, unknown> = {}) => {
  const parsed = parseServerVersion(versionDocument(overrides));
  if (parsed === null) throw new Error('the version document is invalid');
  return parsed;
};
