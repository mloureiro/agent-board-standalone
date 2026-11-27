import { createHash } from 'node:crypto';

import type { BoardExportRecord } from '@agent-board/contract';

export const envelope = (seed: string): string =>
  `abe1.${seed.padEnd(40, 'A').replaceAll(/[^A-Za-z0-9_-]/g, 'A')}`;

export const blind = (seed: string): string =>
  `abh1.${seed
    .padEnd(43, 'B')
    .replaceAll(/[^A-Za-z0-9_-]/g, 'B')
    .slice(0, 43)}`;

const AT = '2026-03-01T10:00:00.000Z';
const LATER = '2026-03-02T11:30:00.000Z';

export const PROJECT_DEFAULT = '6f1d3d6e-8f4a-4b1b-9f3a-000000000001';
export const PROJECT_SIDE = '6f1d3d6e-8f4a-4b1b-9f3a-000000000002';
export const DIRECTORY_NATIVE = '7a1d3d6e-8f4a-4b1b-9f3a-000000000001';
export const WATCH_STOPS = Array.from({ length: 256 }, (_, index) =>
  index.toString(16).padStart(16, '0'),
);

export interface SyntheticOptions {
  owner: string;
  keyId?: string;
  machines?: readonly string[];
  tokenSeed?: string;
}

type Row<T extends BoardExportRecord['table']> = Extract<BoardExportRecord, { table: T }>['row'];

export const syntheticRecords = (options: SyntheticOptions): BoardExportRecord[] => {
  const { owner } = options;
  const machines = options.machines ?? ['alpha', 'beta'];
  const tokenSeed = options.tokenSeed ?? owner;
  const record = <T extends BoardExportRecord['table']>(table: T, row: Row<T>) =>
    ({ owner, table, row }) as BoardExportRecord;
  const tokenOf = (index: number): string =>
    Buffer.from(`${tokenSeed}-${index}`).toString('hex').padEnd(64, '0').slice(0, 64);

  const task = (id: string, extra: Partial<Row<'task'>> = {}): BoardExportRecord =>
    record('task', {
      id,
      title: envelope(`title-${id}`),
      input: envelope(`input-${id}`),
      status: 'todo',
      priority: 'normal',
      model: null,
      effort: null,
      requestedLane: null,
      autoDone: false,
      movedBy: null,
      position: 1,
      closed: false,
      closedAt: null,
      machine: null,
      sessionId: null,
      projectId: PROJECT_DEFAULT,
      directoryId: null,
      legacyDirectory: null,
      legacyHomeWorkdir: null,
      agent: null,
      icon: null,
      labels: null,
      watches: null,
      watchStops: [],
      prState: null,
      next: 'fresh',
      lane: null,
      borrowed: false,
      lastActiveAt: null,
      pausedAt: null,
      notBefore: null,
      wakeAt: null,
      waitCheck: false,
      wokenAt: null,
      head: null,
      openQuestionNoteId: null,
      dedupeKey: null,
      parentId: null,
      createdBy: 'user',
      scheduleId: null,
      forkOf: null,
      occurrenceFinishedAt: null,
      proposed: false,
      createdAt: AT,
      updatedAt: LATER,
      ...extra,
    });

  const schedule = (id: string, extra: Partial<Row<'schedule'>>): BoardExportRecord =>
    record('schedule', {
      id,
      title: envelope(`title-${id}`),
      input: envelope(`input-${id}`),
      priority: 'normal',
      model: null,
      effort: null,
      requestedLane: null,
      autoDone: false,
      machine: null,
      projectId: PROJECT_DEFAULT,
      directoryId: null,
      legacyDirectory: null,
      agent: null,
      icon: null,
      labels: null,
      everyMs: null,
      cron: null,
      moreCrons: [],
      timezone: null,
      afterScheduleId: null,
      afterDelayMs: null,
      maxConcurrent: null,
      anchorAt: AT,
      lastOccurrenceAt: null,
      remaining: null,
      until: null,
      pausedAt: null,
      endedAt: null,
      occurrenceTaskId: null,
      createdAt: AT,
      ...extra,
    });

  const document = (kind: 'agents' | 'links' | 'titles' | 'settings'): BoardExportRecord =>
    record('document', { kind, document: envelope(`doc-${kind}`), version: 3, updatedAt: LATER });

  return [
    record('user', {
      createdAt: AT,
      keyId: options.keyId ?? '0123456789abcdef',
      keySlots: [
        {
          kind: 'passphrase',
          kdf: 'argon2id',
          m: 8192,
          t: 1,
          p: 1,
          salt: 'AAAAAAAAAAAAAAAAAAAAAA',
          wrapped: `abw1.${'W'.repeat(80)}`,
        },
      ],
      source: 'passkey',
    }),
    record('passkey', {
      credentialId: `cred-${owner}`,
      publicKey: 'pk',
      counter: 4,
      transports: ['internal'],
      name: 'laptop',
      createdAt: AT,
      lastUsedAt: LATER,
    }),
    ...machines.map((name, index) =>
      record('machine', {
        name,
        tokenHash: tokenOf(index),
        createdAt: AT,
        lastSeenAt: LATER,
        revokedAt: null,
        clientVersion: '1.2.3',
        grant: index === 0,
        catalog: envelope(`catalog-${name}`),
        catalogIndex: blind(`catalog-${name}`),
        catalogUpdatedAt: LATER,
        usage: null,
        usageIndex: null,
        usageUpdatedAt: null,
        feeds: null,
        feedsIndex: null,
        feedsUpdatedAt: null,
      }),
    ),
    record('project', {
      id: PROJECT_DEFAULT,
      name: null,
      icon: null,
      position: 0,
      isDefault: true,
      archivedAt: null,
      createdAt: AT,
      updatedAt: AT,
    }),
    record('project', {
      id: PROJECT_SIDE,
      name: envelope('side'),
      icon: null,
      position: 1,
      isDefault: false,
      archivedAt: null,
      createdAt: AT,
      updatedAt: AT,
    }),
    record('directory', {
      id: DIRECTORY_NATIVE,
      machineName: machines[0] as string,
      projectId: PROJECT_SIDE,
      path: envelope('dir-native'),
      repo: null,
      createdAt: AT,
    }),
    ...machines.map((name) =>
      record('legacy_dirs', { machineName: name, document: envelope(`dirs-${name}`) }),
    ),
    task('t-parent', { watches: envelope('watches'), watchStops: WATCH_STOPS }),
    task('t-child', {
      parentId: 't-parent',
      machine: machines[0] as string,
      legacyDirectory: envelope('legacy-child'),
      openQuestionNoteId: 'n-question',
    }),
    task('t-unassigned', { legacyDirectory: envelope('legacy-unassigned'), status: 'backlog' }),
    task('t-beta', {
      machine: machines[1] ?? machines[0] ?? null,
      legacyDirectory: envelope('legacy-beta'),
    }),
    record('task_pr', {
      id: 'pr-1',
      taskId: 't-parent',
      pr: envelope('pr'),
      state: 'open',
      createdAt: AT,
    }),
    record('note', {
      id: 'n-question',
      taskId: 't-child',
      author: 'agent',
      kind: 'question',
      body: envelope('q'),
      preview: null,
      suggestion: null,
      questions: envelope('questions'),
      answers: null,
      questionNoteId: null,
      by: null,
      viaMachine: null,
      queued: false,
      deliveredAt: null,
      createdAt: AT,
    }),
    record('note', {
      id: 'n-answer',
      taskId: 't-child',
      author: 'user',
      kind: 'answer',
      body: envelope('a'),
      preview: null,
      suggestion: null,
      questions: null,
      answers: envelope('answers'),
      questionNoteId: 'n-question',
      by: 'someone',
      viaMachine: machines[0] as string,
      queued: true,
      deliveredAt: null,
      createdAt: LATER,
    }),
    record('note', {
      id: 'n-server',
      taskId: 't-parent',
      author: 'server',
      kind: 'event',
      body: 'Taken back from ' + 'm'.repeat(256) + ': no sign of life for 20 minutes.',
      preview: null,
      suggestion: null,
      questions: null,
      answers: null,
      questionNoteId: null,
      by: null,
      viaMachine: null,
      queued: false,
      deliveredAt: null,
      createdAt: LATER,
    }),
    schedule('s-after', { afterScheduleId: 's-base', afterDelayMs: 1000 }),
    schedule('s-base', {
      cron: '0 9 * * *',
      timezone: 'Europe/Lisbon',
      legacyDirectory: envelope('legacy-sched'),
    }),
    record('transcript_run', {
      id: 'run-0000001',
      taskId: 't-child',
      machine: machines[0] as string,
      sessionId: null,
      resumed: false,
      startedAt: AT,
      lastEventAt: LATER,
      eventCount: 2,
    }),
    record('transcript_event', {
      runId: 'run-0000001',
      seq: 0,
      at: AT,
      kind: 'text',
      parent: null,
      data: envelope('event-0'),
      output: null,
      outputSize: 12,
    }),
    record('transcript_event', {
      runId: 'run-0000001',
      seq: 1,
      at: LATER,
      kind: 'tool_result',
      parent: 'tool-1',
      data: envelope('event-1'),
      output: envelope('output-1'),
      outputSize: 4096,
    }),
    document('agents'),
    document('links'),
    document('titles'),
    document('settings'),
    record('device', {
      keyId: createHash('sha256').update(owner).digest('hex').slice(0, 16),
      publicKey: 'public-key-1',
      label: 'phone',
      kind: 'paired',
      machine: null,
      createdAt: AT,
      lastUsedAt: null,
    }),
  ];
};

export const exportFile = (
  records: readonly BoardExportRecord[],
  header = {
    format: 'agent-board-export',
    version: 1,
    createdAt: AT,
    source: { kind: 'migrate', version: '0.0.0' },
  },
): string => [header, ...records].map((line) => JSON.stringify(line)).join('\n') + '\n';

const DOCUMENT_NAMES = {
  agents: 'shared_agents',
  links: 'link_rules',
  titles: 'title_rules',
  settings: 'setting',
} as const;

export const countsOf = (records: readonly BoardExportRecord[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const entry of records) {
    const name = entry.table === 'document' ? DOCUMENT_NAMES[entry.row.kind] : entry.table;
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return counts;
};
