import {
  deleteClientAccountRoute,
  exportClientAccountRoute,
  getClientKeysRoute,
  getClientLinksRoute,
  getClientSettingsRoute,
  getClientTitleRulesRoute,
  importClientAccountRoute,
  issueClientMachineRoute,
  listClientFeedsRoute,
  listClientMachinesRoute,
  listClientPasskeysRoute,
  listClientSchedulesRoute,
  listClientTasksRoute,
  registerClientPasskeyRoute,
  registerOptionsClientPasskeyRoute,
  removeClientPasskeyRoute,
  removeClientScheduleRoute,
  requestClientFeedRoute,
  revokeClientMachineRoute,
  setClientLinksRoute,
  setClientSettingsRoute,
  setClientTitleRulesRoute,
  setGrantClientMachineRoute,
  setPausedClientScheduleRoute,
  sharedClientAgentsRoute,
  summaryClientAccountRoute,
  updateClientScheduleRoute,
  type WireSchedule,
} from '@agent-board/contract';
import { bindings, createKeySetup, open, seal, type KeySetup } from '@agent-board/sealing';

import { OWNER_KEYS, hours, isoAt } from './board-world.js';
import { json } from './fake-board.js';
import { TEST_KDF } from './key-board.js';
import { PROJECT_HOME, TaskWorld } from './task-world.js';

export interface SeedSchedule {
  readonly id: string;
  readonly title: string;
  readonly prompt?: string;
  readonly everyMs?: number;
  readonly projectId?: string;
  readonly paused?: boolean;
}

export type DocumentName = 'settings' | 'links' | 'titles';

interface StoredDocument {
  text: string;
  version: number;
}

export const PASSPHRASE = 'correct horse battery staple';
export const TOKEN = `abm_${'a'.repeat(43)}`;
export const REISSUED_TOKEN = `abm_${'b'.repeat(43)}`;

export interface WorldPasskey {
  id: string;
  name: string;
}

const DOCUMENT_ROUTES = {
  settings: {
    get: getClientSettingsRoute,
    set: setClientSettingsRoute,
    binding: bindings.settings,
  },
  links: { get: getClientLinksRoute, set: setClientLinksRoute, binding: bindings.links },
  titles: {
    get: getClientTitleRulesRoute,
    set: setClientTitleRulesRoute,
    binding: bindings.titles,
  },
} as const;

const feedId = (index: number): string => index.toString(16).padStart(16, '0');
export const FEED_ID = feedId(1);

export class PagesWorld extends TaskWorld {
  schedules: WireSchedule[] = [];
  readonly writes: { path: string; body: Record<string, unknown> }[] = [];
  readonly documents: Record<DocumentName, StoredDocument | null> = {
    settings: null,
    links: null,
    titles: null,
  };
  sharedAgents: StoredDocument | null = null;
  readonly documentWrites: { name: DocumentName; text: string; expectedVersion: number }[] = [];
  conflictOnce: DocumentName | null = null;
  grants = new Set<string>();
  usageTexts = new Map<string, string>();
  readonly issued: string[] = [];
  readonly revoked: string[] = [];
  feedMachines: { name: string; text: string; requests: string[] }[] = [];
  readonly feedRequests: Record<string, unknown>[] = [];
  passkeys: WorldPasskey[] = [];
  readonly exportRows: Record<string, Record<string, unknown>[]> = {};
  readonly exportPages = new Map<string, string[]>();
  readonly taskLists: string[] = [];
  readonly imports: { table: string; rows: unknown[]; keyId: string }[] = [];
  deleted: string | null = null;
  keySetup: KeySetup | null = null;
  readonly owner = 'owner';

  async seedKeySetup(): Promise<KeySetup> {
    const created = await createKeySetup(this.owner, PASSPHRASE, TEST_KDF);
    this.keySetup = created.setup;
    return created.setup;
  }

  async seedSchedule(input: SeedSchedule): Promise<WireSchedule> {
    const keys = await OWNER_KEYS;
    const schedule: WireSchedule = {
      id: input.id,
      title: await seal(keys, bindings.title({ schedule: input.id }), input.title),
      input: await seal(
        keys,
        bindings.input({ origin: { schedule: input.id }, creator: 'user' }),
        input.prompt ?? `prompt of ${input.title}`,
      ),
      priority: 'normal',
      model: null,
      effort: null,
      requestedLane: null,
      autoDone: false,
      machine: null,
      projectId: input.projectId ?? PROJECT_HOME,
      directoryId: null,
      legacyDirectory: null,
      everyMs: input.everyMs ?? 3_600_000,
      cron: null,
      timezone: null,
      after: null,
      maxConcurrent: null,
      anchorAt: isoAt(-hours(5)),
      nextRunAt: isoAt(hours(1)),
      remaining: null,
      until: null,
      paused: input.paused ?? false,
      ended: false,
      occurrenceTaskId: null,
      createdAt: isoAt(-hours(5)),
    };
    this.schedules.push(schedule);
    return schedule;
  }

  async setDocument(name: DocumentName, text: string, version = 1): Promise<void> {
    this.documents[name] = { text, version };
  }

  private async sealedDocument(name: DocumentName): Promise<unknown> {
    const stored = this.documents[name];
    if (stored === null) return null;
    const keys = await OWNER_KEYS;
    return {
      document: await seal(keys, DOCUMENT_ROUTES[name].binding(stored.version), stored.text),
      version: stored.version,
      updatedAt: isoAt(-hours(1)),
    };
  }

  private async saveDocument(name: DocumentName, body: Record<string, unknown>): Promise<Response> {
    const stored = this.documents[name];
    const current = stored?.version ?? 0;
    const expected = Number(body.expectedVersion);
    if (this.conflictOnce === name || expected !== current) {
      this.conflictOnce = null;
      return json(409, { error: { code: 'version-conflict', message: 'The document changed.' } });
    }
    const version = Number(body.version);
    const keys = await OWNER_KEYS;
    const text = await open(keys, DOCUMENT_ROUTES[name].binding(version), String(body.document));
    this.documents[name] = { text, version };
    this.documentWrites.push({ name, text, expectedVersion: expected });
    return json(200, {});
  }

  settingsValue(): Record<string, unknown> {
    const stored = this.documents.settings;
    return stored === null ? {} : (JSON.parse(stored.text) as Record<string, unknown>);
  }

  private async machineList(): Promise<Response> {
    const keys = await OWNER_KEYS;
    return json(200, {
      machines: await Promise.all(
        this.machines.map(async (machine) => {
          const usage = this.usageTexts.get(machine.name);
          return {
            name: machine.name,
            createdAt: isoAt(-hours(48)),
            lastSeenAt: null,
            revokedAt: machine.revokedAt ?? null,
            clientVersion: null,
            clientStatus: machine.clientStatus,
            usage:
              usage === undefined
                ? null
                : await seal(keys, bindings.machineDocument('machine.usage', machine.name), usage),
            usageUpdatedAt: null,
            grant: this.grants.has(machine.name),
          };
        }),
      ),
    });
  }

  private async feedList(): Promise<Response> {
    const keys = await OWNER_KEYS;
    return json(200, {
      machines: await Promise.all(
        this.feedMachines.map(async (machine) => ({
          name: machine.name,
          lastSeenAt: null,
          feeds: await seal(
            keys,
            bindings.machineDocument('machine.feeds', machine.name),
            machine.text,
          ),
          feedsUpdatedAt: isoAt(-hours(1)),
          feedRequests: machine.requests,
        })),
      ),
    });
  }

  protected override async answer(
    method: string,
    path: string,
    body: Record<string, unknown> | null,
  ): Promise<Response> {
    const query = new URL(this.current.pathWithQuery, 'http://localhost').searchParams;
    if (method === 'GET') {
      switch (path) {
        case listClientSchedulesRoute.path: {
          const project = query.get('project');
          return json(200, {
            schedules: this.schedules.filter((s) => project === null || s.projectId === project),
          });
        }
        case listClientTasksRoute.path: {
          this.taskLists.push(this.current.pathWithQuery);
          const closed = query.get('closed') === 'true';
          return json(200, { tasks: this.tasks.filter((task) => task.closed === closed) });
        }
        case listClientMachinesRoute.path:
          return this.machineList();
        case listClientFeedsRoute.path:
          return this.feedList();
        case getClientSettingsRoute.path:
          return json(200, { document: await this.sealedDocument('settings') });
        case getClientLinksRoute.path:
          return json(200, { document: await this.sealedDocument('links') });
        case getClientTitleRulesRoute.path:
          return json(200, { document: await this.sealedDocument('titles') });
        case sharedClientAgentsRoute.path: {
          if (this.sharedAgents === null) return json(200, { document: null });
          const keys = await OWNER_KEYS;
          return json(200, {
            document: {
              document: await seal(
                keys,
                bindings.sharedAgents(this.sharedAgents.version),
                this.sharedAgents.text,
              ),
              version: this.sharedAgents.version,
              pushedAt: isoAt(-hours(1)),
            },
          });
        }
        case listClientPasskeysRoute.path:
          return json(200, {
            passkeys: this.passkeys.map((passkey) => ({
              ...passkey,
              createdAt: isoAt(-hours(24)),
              lastUsedAt: null,
            })),
          });
        case getClientKeysRoute.path:
          return json(200, { setup: this.keySetup });
        case summaryClientAccountRoute.path:
          return json(200, {
            running: 1,
            tasks: this.tasks.length,
            schedules: this.schedules.length,
            machines: this.machines.length,
            titleRules: 0,
            notes: 3,
            taskPrs: 0,
            sharedAgents: 0,
            linkRules: 0,
            transcriptRuns: 0,
            transcriptEvents: 0,
            projects: 1,
            directories: 0,
          });
        case exportClientAccountRoute.path: {
          const table = query.get('table') ?? '';
          const cursor = query.get('cursor');
          this.exportPages.set(table, [...(this.exportPages.get(table) ?? []), cursor ?? '']);
          const rows = this.exportRows[table] ?? [];
          if (cursor === null && rows.length > 1) {
            return json(200, { next: 'page-2', rows: rows.slice(0, 1) });
          }
          return json(200, { next: null, rows: cursor === null ? rows : rows.slice(1) });
        }
        default:
          break;
      }
    }
    if (method === 'POST') {
      switch (path) {
        case setPausedClientScheduleRoute.path: {
          this.writes.push({ path, body: body ?? {} });
          const found = this.schedules.find((s) => s.id === body?.id);
          if (found === undefined) {
            return json(404, { error: { code: 'not-found', message: 'no' } });
          }
          found.paused = body?.paused === true;
          return json(200, found);
        }
        case removeClientScheduleRoute.path:
          this.writes.push({ path, body: body ?? {} });
          this.schedules = this.schedules.filter((s) => s.id !== body?.id);
          return json(200, {});
        case updateClientScheduleRoute.path: {
          this.writes.push({ path, body: body ?? {} });
          const found = this.schedules.find((s) => s.id === body?.id);
          if (found === undefined) {
            return json(404, { error: { code: 'not-found', message: 'no' } });
          }
          found.title = String(body?.title);
          found.input = String(body?.input);
          found.priority = body?.priority as WireSchedule['priority'];
          found.autoDone = body?.autoDone === true;
          const repeat = body?.repeat as { everyMs?: number } | undefined;
          if (repeat?.everyMs !== undefined) found.everyMs = repeat.everyMs;
          return json(200, { schedule: found, pending: 'updated' });
        }
        case issueClientMachineRoute.path: {
          const name = String(body?.name);
          const known = this.machines.some((machine) => machine.name === name);
          if (!known) this.machines.push({ name, clientStatus: 'unknown' });
          this.issued.push(name);
          return json(200, { token: known ? REISSUED_TOKEN : TOKEN });
        }
        case revokeClientMachineRoute.path: {
          const machine = this.machines.find((entry) => entry.name === body?.name);
          if (machine === undefined) {
            return json(404, { error: { code: 'not-found', message: 'no machine' } });
          }
          machine.revokedAt = isoAt(0);
          this.revoked.push(machine.name);
          return json(200, {});
        }
        case setGrantClientMachineRoute.path:
          if (body?.grant === true) this.grants.add(String(body.name));
          else this.grants.delete(String(body?.name));
          return json(200, {});
        case requestClientFeedRoute.path: {
          this.feedRequests.push(body ?? {});
          const machine = this.feedMachines.find((entry) => entry.name === body?.machine);
          machine?.requests.push(`${String(body?.action)}:${String(body?.id)}`);
          return json(200, {});
        }
        case setClientSettingsRoute.path:
          return this.saveDocument('settings', body ?? {});
        case setClientLinksRoute.path:
          return this.saveDocument('links', body ?? {});
        case setClientTitleRulesRoute.path:
          return this.saveDocument('titles', body ?? {});
        case registerOptionsClientPasskeyRoute.path:
          return json(200, {
            flow: 'reg-1',
            options: {
              challenge: 'AQID',
              rp: { name: 'Board' },
              user: { id: 'BAUG', name: this.owner, displayName: this.owner },
              pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
            },
          });
        case registerClientPasskeyRoute.path:
          this.passkeys.push({ id: `cred-${this.passkeys.length + 1}`, name: String(body?.name) });
          return json(200, {});
        case removeClientPasskeyRoute.path:
          this.passkeys = this.passkeys.filter((passkey) => passkey.id !== body?.id);
          return json(200, {});
        case importClientAccountRoute.path: {
          const rows = (body?.rows as unknown[]) ?? [];
          this.imports.push({ table: String(body?.table), rows, keyId: String(body?.keyId) });
          return json(200, { inserted: rows.length, existing: 0, invalid: 0, orphaned: 0 });
        }
        case deleteClientAccountRoute.path:
          if (body?.username !== this.owner) {
            return json(403, { error: { code: 'forbidden', message: 'Wrong username.' } });
          }
          this.deleted = this.owner;
          this.session = 'none';
          return json(200, {});
        default:
          break;
      }
    }
    return super.answer(method, path, body);
  }
}
