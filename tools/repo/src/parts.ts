export interface PartRule {
  readonly name: string;
  readonly directory: string;
  readonly allowed: readonly string[];
}

const SHARED = ['contract', 'sealing'] as const;

export const PARTS: readonly PartRule[] = [
  { name: 'contract', directory: 'packages/contract', allowed: [] },
  { name: 'sealing', directory: 'packages/sealing', allowed: [] },
  { name: 'api', directory: 'apps/api', allowed: SHARED },
  { name: 'cli', directory: 'apps/cli', allowed: SHARED },
  { name: 'web', directory: 'apps/web', allowed: SHARED },
  { name: 'migrate', directory: 'apps/migrate', allowed: SHARED },
  { name: 'e2e', directory: 'e2e', allowed: SHARED },
  { name: 'server-app', directory: 'apps/server-app', allowed: ['api'] },
  { name: 'client-app', directory: 'apps/client-app', allowed: ['web'] },
  { name: 'mobile', directory: 'apps/mobile', allowed: ['web'] },
  { name: 'tools', directory: 'tools/repo', allowed: [] },
];
