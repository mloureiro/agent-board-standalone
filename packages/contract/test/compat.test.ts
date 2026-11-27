import { describe, expect, it } from 'vitest';
import {
  FEATURES,
  compat,
  formatClientHeader,
  parseClientHeader,
  type ClientSide,
  type ServerSide,
} from '../src/index.js';

const client = (over: Partial<ClientSide> = {}): ClientSide => ({
  role: 'client',
  kind: 'cli',
  version: '1.4.0',
  contract: 1,
  ...over,
});

const server = (over: Partial<ServerSide> = {}): ServerSide => ({
  role: 'server',
  version: '1.2.0',
  contract: 1,
  minClient: { cli: 1, web: 1 },
  features: ['projects', 'forks'],
  ...over,
});

describe('compat', () => {
  const cases: {
    name: string;
    client: ClientSide;
    server: ServerSide;
    needed?: ('projects' | 'watches' | 'schedules')[];
    kind: string;
    missing?: string[];
    message?: RegExp;
  }[] = [
    { name: 'equal versions', client: client(), server: server(), kind: 'compatible' },
    {
      name: 'client below minClient',
      client: client(),
      server: server({ version: '2.0.0', contract: 2, minClient: { cli: 2, web: 1 } }),
      kind: 'client-too-old',
      message: /This CLI \(1\.4\.0, contract 1\).*\(2\.0\.0, which needs contract 2 or newer\)/,
    },
    {
      name: 'server below minServer',
      client: client({ kind: 'web', version: '2.1.0', contract: 2, minServer: 2 }),
      server: server({ version: '1.0.0' }),
      kind: 'client-too-new',
      message:
        /The server \(1\.0\.0, contract 1\) is too old for this browser client \(2\.1\.0, which needs contract 2/,
    },
    {
      name: 'needed feature missing',
      client: client(),
      server: server(),
      needed: ['projects', 'watches', 'schedules'],
      kind: 'missing-features',
      missing: ['watches', 'schedules'],
      message: /The server \(1\.2\.0\) lacks: watches, schedules\./,
    },
    {
      name: 'unknown server features',
      client: client(),
      server: server({ features: ['projects', 'from-the-future'] }),
      needed: ['projects'],
      kind: 'compatible',
    },
  ];

  it.each(cases)('[contract-002] $name', (row) => {
    for (const [local, remote] of [
      [row.client, row.server],
      [row.server, row.client],
    ] as const) {
      const result = compat(local, remote, row.needed);
      expect(result.kind).toBe(row.kind);
      expect(result.missing).toEqual(row.missing);
      if (row.message) expect(result.message).toMatch(row.message);
    }
  });

  it('[contract-002] a 1.0 server without context-usage stays compatible with a 1.1 client, and a 1.0 client with a 1.1 server', () => {
    const v10 = FEATURES.filter((feature) => feature !== 'context-usage');
    expect(FEATURES).toContain('context-usage');
    const older = server({ version: '1.0.0', features: v10 });
    const newer = server({ version: '1.1.0', features: [...FEATURES] });
    const noNeeds = compat(client({ version: '1.1.0' }), older);
    expect(noNeeds.kind).toBe('compatible');
    expect(noNeeds.missing).toBeUndefined();
    expect(compat(client({ version: '1.0.0' }), newer).kind).toBe('compatible');
    expect(compat(client({ version: '1.1.0' }), older, ['context-usage']).missing).toEqual([
      'context-usage',
    ]);
  });

  it('[contract-002] a 1.1 server without lean-task-list stays compatible with a 1.2 client, and a 1.1 client with a 1.2 server', () => {
    const v11 = FEATURES.filter((feature) => feature !== 'lean-task-list');
    expect(FEATURES).toContain('lean-task-list');
    const older = server({ version: '1.1.0', features: v11 });
    const newer = server({ version: '1.2.0', features: [...FEATURES] });
    expect(compat(client({ version: '1.2.0' }), older).kind).toBe('compatible');
    expect(compat(client({ version: '1.1.0' }), newer).kind).toBe('compatible');
    expect(compat(client({ version: '1.2.0' }), older, ['lean-task-list']).missing).toEqual([
      'lean-task-list',
    ]);
  });

  it('[contract-002] two clients or two servers throw', () => {
    expect(() => compat(client(), client())).toThrow(TypeError);
    expect(() => compat(server(), server())).toThrow(TypeError);
  });

  it('[contract-002] parseClientHeader reads cli/1.2.3 and refuses unknown kinds', () => {
    expect(parseClientHeader('cli/1.2.3')).toEqual({ kind: 'cli', version: '1.2.3' });
    expect(parseClientHeader('web/2.0.0-rc.1')).toEqual({ kind: 'web', version: '2.0.0-rc.1' });
    expect(parseClientHeader('mobile/1.0.0')).toBeNull();
    expect(parseClientHeader('cli/1.2')).toBeNull();
    expect(parseClientHeader('cli')).toBeNull();
    expect(formatClientHeader('cli', '1.0.0')).toBe('cli/1.0.0');
  });
});
