import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import {
  ACCOUNT_TABLES,
  FEATURES,
  MACHINE_STATES,
  routeByName,
  type AnyRoute,
} from '../src/index.js';

const sealed = `abe1.${'A'.repeat(38)}`;
const uuid = '591d2ec1-d4ab-4e26-8c3a-0e6f0c1d2b3a';
const other = '0b1d2ec1-d4ab-4e26-8c3a-0e6f0c1d2b3a';
const time = '2026-11-13T10:00:00.000Z';
const keyId = '0123456789abcdef';
const wrapped = `abw1.${'A'.repeat(80)}`;
const salt = 'A'.repeat(22);
const token = `abm_${'A'.repeat(43)}`;
const setup = {
  keyId,
  slots: [{ kind: 'passphrase', kdf: 'argon2id', m: 65_536, t: 3, p: 1, salt, wrapped }],
};

const creationOptions = {
  user: { id: 'dXNlcg', name: 'owner', displayName: 'owner' },
  challenge: 'Y2hhbGxlbmdl',
  rp: { name: 'Agent Board' },
  pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
};

const registration = {
  id: 'abc',
  rawId: 'abc',
  type: 'public-key',
  response: { clientDataJSON: 'e30', attestationObject: 'e30' },
};

interface Case {
  name: string;
  request: Record<string, unknown>;
  response: unknown;
}

const cases: Case[] = [
  { name: 'client.keys.get', request: {}, response: { setup: null } },
  { name: 'client.keys.setup', request: setup, response: {} },
  { name: 'client.keys.replace-slots', request: setup, response: {} },
  {
    name: 'client.passkeys.list',
    request: {},
    response: { passkeys: [{ id: 'abc', name: 'laptop', createdAt: time, lastUsedAt: null }] },
  },
  {
    name: 'client.passkeys.register-options',
    request: {},
    response: { options: creationOptions, flow: 'flow-1' },
  },
  {
    name: 'client.passkeys.register',
    request: { flow: 'flow-1', response: registration, name: 'laptop' },
    response: {},
  },
  { name: 'client.passkeys.rename', request: { id: 'abc', name: 'phone' }, response: {} },
  { name: 'client.passkeys.remove', request: { id: 'abc' }, response: {} },
  {
    name: 'client.machines.list',
    request: {},
    response: {
      machines: [
        {
          name: 'laptop',
          createdAt: time,
          lastSeenAt: null,
          revokedAt: null,
          clientVersion: '1.0.0',
          clientStatus: 'current',
          usage: sealed,
          usageUpdatedAt: time,
          grant: false,
        },
      ],
    },
  },
  {
    name: 'client.machines.catalogs',
    request: {},
    response: { catalogs: [{ name: 'laptop', catalog: null, catalogUpdatedAt: null }] },
  },
  { name: 'client.machines.advertised-cli', request: {}, response: { version: null } },
  { name: 'client.machines.issue', request: { name: 'laptop' }, response: { token } },
  { name: 'client.machines.revoke', request: { name: 'laptop' }, response: {} },
  {
    name: 'client.machines.set-grant',
    request: { name: 'laptop', grant: true },
    response: {},
  },
  {
    name: 'client.feeds.list',
    request: {},
    response: {
      machines: [
        {
          name: 'laptop',
          lastSeenAt: time,
          feeds: sealed,
          feedsUpdatedAt: time,
          feedRequests: ['pause:0123456789abcdef'],
        },
      ],
    },
  },
  {
    name: 'client.feeds.request',
    request: { machine: 'laptop', action: 'run', id: keyId },
    response: {},
  },
  {
    name: 'client.agents.shared',
    request: {},
    response: { document: { document: sealed, version: 2, pushedAt: time } },
  },
  {
    name: 'client.links.get',
    request: {},
    response: { document: { document: sealed, version: 1, updatedAt: time } },
  },
  {
    name: 'client.links.set',
    request: { document: sealed, version: 1, expectedVersion: 0 },
    response: {},
  },
  { name: 'client.title-rules.get', request: {}, response: { document: null } },
  {
    name: 'client.title-rules.set',
    request: { document: sealed, version: 4, expectedVersion: 3 },
    response: {},
  },
  {
    name: 'client.account.summary',
    request: {},
    response: {
      running: 0,
      tasks: 1,
      schedules: 0,
      machines: 1,
      titleRules: 0,
      notes: 2,
      taskPrs: 0,
      sharedAgents: 0,
      linkRules: 0,
      transcriptRuns: 0,
      transcriptEvents: 0,
      projects: 1,
      directories: 2,
    },
  },
  {
    name: 'client.account.export',
    request: { table: 'task', cursor: 'next-page' },
    response: { next: null, rows: [{ id: 'a', title: sealed }] },
  },
  {
    name: 'client.account.import',
    request: { keyId, table: 'project', rows: [{ id: uuid }] },
    response: { inserted: 1, existing: 0, invalid: 0, orphaned: 0 },
  },
  { name: 'client.account.delete', request: { username: 'owner' }, response: {} },
  {
    name: 'client.projects.list',
    request: {},
    response: {
      projects: [
        {
          id: uuid,
          name: null,
          icon: null,
          position: 0,
          isDefault: true,
          archivedAt: null,
          createdAt: time,
          updatedAt: time,
        },
      ],
    },
  },
  {
    name: 'client.projects.create',
    request: { id: uuid, name: sealed, icon: null },
    response: {},
  },
  { name: 'client.projects.update', request: { id: uuid, position: 2 }, response: {} },
  { name: 'client.projects.archive', request: { id: uuid }, response: {} },
  { name: 'client.projects.unarchive', request: { id: uuid }, response: {} },
  { name: 'client.projects.delete', request: { id: uuid }, response: {} },
  {
    name: 'client.directories.list',
    request: {},
    response: {
      directories: [{ id: uuid, path: sealed, repo: null, projectId: other }],
    },
  },
  {
    name: 'client.directories.move',
    request: { id: uuid, projectId: other },
    response: {},
  },
  { name: 'client.settings.get', request: {}, response: { document: null } },
  {
    name: 'client.settings.set',
    request: { document: sealed, version: 1, expectedVersion: 0 },
    response: {},
  },
  {
    name: 'client.attention',
    request: {},
    response: { tasks: [{ id: 'Ab3dEf9xYz12', projectId: uuid, since: time }] },
  },
  {
    name: 'client.devices.list',
    request: {},
    response: {
      devices: [{ keyId, label: 'phone', kind: 'paired', createdAt: time, lastUsedAt: null }],
    },
  },
  { name: 'client.devices.revoke', request: { keyId }, response: {} },
];

const route = (name: string): AnyRoute => routeByName(name as 'client.me') as unknown as AnyRoute;
const parse = (schema: z.ZodType, value: unknown) => schema.safeParse(value);

describe('client routes: keys, passkeys, machines, feeds, documents, account, projects, directories, settings, attention, devices', () => {
  for (const entry of cases) {
    it(`[contract-003] ${entry.name} accepts a minimal request, refuses an unknown key and parses its answer`, () => {
      const spec = route(entry.name);
      expect(parse(spec.request, entry.request).success).toBe(true);
      expect(parse(spec.request, { ...entry.request, extra: 1 }).success).toBe(false);
      expect(parse(spec.response, entry.response).success).toBe(true);
      expect(parse(spec.response, { ...(entry.response as object), extra: 1 }).success).toBe(false);
    });
  }

  it('[contract-003] machines/issue is marked issuesCredential', () => {
    expect(route('client.machines.issue').issuesCredential).toBe(true);
    const marked = cases.filter((entry) => route(entry.name).issuesCredential);
    expect(marked.map((entry) => entry.name).sort()).toEqual([
      'client.account.import',
      'client.machines.issue',
      'client.passkeys.register',
    ]);
    expect(parse(route('client.machines.issue').response, { token: 'abc_x' }).success).toBe(false);
  });

  it('[contract-003] machine names stored before the name rule stay listed and revocable', () => {
    const legacy = 'Old Laptop (2019)';
    const row = (
      cases.find((entry) => entry.name === 'client.machines.list')!.response as {
        machines: Record<string, unknown>[];
      }
    ).machines[0]!;
    expect(
      parse(route('client.machines.list').response, { machines: [{ ...row, name: legacy }] })
        .success,
    ).toBe(true);
    expect(parse(route('client.machines.revoke').request, { name: legacy }).success).toBe(true);
    expect(parse(route('client.machines.revoke').request, { name: '' }).success).toBe(false);
    expect(parse(route('client.machines.revoke').request, { name: 'a'.repeat(257) }).success).toBe(
      false,
    );
    expect(parse(route('client.machines.issue').request, { name: legacy }).success).toBe(false);
    expect(
      parse(route('client.machines.set-grant').request, { name: legacy, grant: true }).success,
    ).toBe(false);
  });

  it('[contract-003] machines/set-grant carries the machine-grant feature', () => {
    expect(route('client.machines.set-grant').feature).toBe('machine-grant');
    expect(route('client.machines.set-grant').method).toBe('POST');
    expect(parse(route('client.machines.set-grant').request, { name: 'laptop' }).success).toBe(
      false,
    );
  });

  it('[contract-003] project delete takes then: move-to-default or delete, and directory move takes withUsers', () => {
    const del = route('client.projects.delete');
    for (const then of ['move-to-default', 'delete']) {
      expect(parse(del.request, { id: uuid, then }).success, then).toBe(true);
    }
    expect(parse(del.request, { id: uuid, then: 'keep' }).success).toBe(false);
    for (const code of ['conflict', 'forbidden', 'not-found'] as const) {
      expect(del.errors).toContain(code);
    }
    const move = route('client.directories.move');
    expect(parse(move.request, { id: uuid, projectId: other, withUsers: true }).success).toBe(true);
    expect(parse(move.request, { id: uuid, projectId: other, withUsers: 'yes' }).success).toBe(
      false,
    );
    expect(move.errors).toContain('directory-in-use');
    expect(move.errors).toContain('conflict');
  });

  it('[contract-003] attention answers ids, project and time only', () => {
    const { response } = route('client.attention');
    const shape = (response as z.ZodObject).shape.tasks as z.ZodArray<z.ZodObject>;
    expect(Object.keys(shape.element.shape).sort()).toEqual(['id', 'projectId', 'since']);
    expect(
      parse(response, {
        tasks: [{ id: 'Ab3dEf9xYz12', projectId: uuid, since: time, title: sealed }],
      }).success,
    ).toBe(false);
  });

  it('[contract-003] keys/setup refuses slots that break the slot rules', () => {
    const { request } = route('client.keys.setup');
    const slot = setup.slots[0];
    const recovery = { kind: 'recovery', wrapped };
    expect(parse(request, { keyId, slots: [slot, recovery] }).success).toBe(true);
    expect(parse(request, { keyId, slots: [] }).success).toBe(false);
    expect(parse(request, { keyId, slots: [recovery] }).success).toBe(false);
    expect(parse(request, { keyId, slots: [slot, slot] }).success).toBe(false);
    expect(parse(request, { keyId: 'XYZ', slots: [slot] }).success).toBe(false);
    expect(route('client.keys.setup').request).toBe(route('client.keys.replace-slots').request);
    expect(route('client.keys.setup').errors).toEqual(['conflict']);
    expect(route('client.keys.replace-slots').errors).toEqual(['forbidden']);
  });

  it('[contract-003] account tables include the project, directory and legacy tables', () => {
    for (const table of ['project', 'directory', 'legacy_dirs', 'setting', 'device']) {
      expect(ACCOUNT_TABLES).toContain(table);
    }
    const { request } = route('client.account.export');
    for (const table of ACCOUNT_TABLES) {
      expect(parse(request, { table }).success, table).toBe(true);
    }
    expect(parse(request, { table: 'user' }).success).toBe(false);
    expect(parse(request, {}).success).toBe(false);
  });

  it('[contract-003] account import takes at most 1000 rows, a 16 MiB body and the board-export feature', () => {
    const entry = route('client.account.import');
    const rows = (count: number) => Array.from({ length: count }, () => ({}));
    expect(parse(entry.request, { keyId, table: 'task', rows: rows(1000) }).success).toBe(true);
    expect(parse(entry.request, { keyId, table: 'task', rows: rows(1001) }).success).toBe(false);
    expect(parse(entry.request, { table: 'task', rows: [] }).success).toBe(false);
    expect(entry.bodyLimit).toBe(16 * 1024 * 1024);
    expect(entry.feature).toBe('board-export');
    expect(route('client.account.export').feature).toBe('board-export');
  });

  it('[contract-003] account delete needs the signed-in name as confirmation', () => {
    const { request } = route('client.account.delete');
    expect(parse(request, {}).success).toBe(false);
    expect(parse(request, { username: '' }).success).toBe(false);
  });

  it('[contract-003] document saves need version to be expectedVersion plus one', () => {
    for (const name of ['client.links.set', 'client.title-rules.set', 'client.settings.set']) {
      const spec = route(name);
      expect(
        parse(spec.request, { document: sealed, version: 3, expectedVersion: 2 }).success,
      ).toBe(true);
      expect(
        parse(spec.request, { document: sealed, version: 3, expectedVersion: 3 }).success,
      ).toBe(false);
      expect(
        parse(spec.request, { document: 'plain', version: 1, expectedVersion: 0 }).success,
      ).toBe(false);
      expect(spec.errors).toEqual(['version-conflict']);
    }
  });

  it('[contract-003] documents are sealed under their own field limit', () => {
    const settings = route('client.settings.get').response;
    const huge = `abe1.${'A'.repeat(400_000)}`;
    expect(
      parse(settings, { document: { document: huge, version: 1, updatedAt: time } }).success,
    ).toBe(false);
    const links = route('client.links.get').response;
    expect(
      parse(links, { document: { document: huge, version: 1, updatedAt: time } }).success,
    ).toBe(true);
  });

  it('[contract-003] machine rows carry no directories and report the client state', () => {
    const { response } = route('client.machines.list');
    const row = (
      cases.find((entry) => entry.name === 'client.machines.list')!.response as {
        machines: Record<string, unknown>[];
      }
    ).machines[0]!;
    expect(parse(response, { machines: [{ ...row, dirs: sealed }] }).success).toBe(false);
    for (const clientStatus of MACHINE_STATES) {
      expect(parse(response, { machines: [{ ...row, clientStatus }] }).success).toBe(true);
    }
    expect(parse(response, { machines: [{ ...row, clientStatus: 'old' }] }).success).toBe(false);
  });

  it('[contract-003] feed requests take one of three actions and a 16-hex id', () => {
    const { request } = route('client.feeds.request');
    for (const action of ['pause', 'resume', 'run']) {
      expect(parse(request, { machine: 'laptop', action, id: keyId }).success, action).toBe(true);
    }
    expect(parse(request, { machine: 'laptop', action: 'stop', id: keyId }).success).toBe(false);
    expect(parse(request, { machine: 'laptop', action: 'run', id: 'x' }).success).toBe(false);
    expect(route('client.feeds.list').module).toBe('feeds');
    expect(route('client.feeds.request').feature).toBe('feeds');
  });

  it('[contract-003] project update needs one setting and project create takes sealed values', () => {
    const update = route('client.projects.update').request;
    expect(parse(update, { id: uuid }).success).toBe(false);
    expect(parse(update, { id: uuid, icon: null }).success).toBe(true);
    const create = route('client.projects.create').request;
    expect(parse(create, { id: uuid, name: 'plain', icon: null }).success).toBe(false);
    expect(parse(create, { id: uuid, name: sealed, icon: sealed, position: 3 }).success).toBe(true);
    expect(parse(create, { id: uuid, name: sealed, icon: null, position: -1 }).success).toBe(false);
  });

  it('[contract-003] passkey names are 1 to 200 characters', () => {
    const { request } = route('client.passkeys.rename');
    expect(parse(request, { id: 'abc', name: 'a'.repeat(200) }).success).toBe(true);
    expect(parse(request, { id: 'abc', name: 'a'.repeat(201) }).success).toBe(false);
    expect(parse(request, { id: 'abc', name: '' }).success).toBe(false);
  });

  it('[contract-003] every feature a route here names is a known feature', () => {
    for (const entry of cases) {
      const feature = route(entry.name).feature;
      if (feature) expect(FEATURES).toContain(feature);
    }
  });
});
