import {
  RECOVERY_KEY_BYTES,
  bindings,
  blindIndex,
  deriveKeys,
  encodeDataKey,
  formatRecoveryKey,
  generateDataKey,
  seal,
  tokenHash,
  toBase64Url,
  unlockKeys,
  wrapSlot,
  type Binding,
  type Keys,
  type KeySetup,
} from '@rumo/sealing';

export const OWNER = 'fixture-owner';
export const PASSPHRASE = 'correct horse battery staple';
export const MACHINES = ['fixture-laptop', 'fixture-server'] as const;

export interface Insert {
  readonly table: string;
  readonly row: Readonly<Record<string, unknown>>;
}

export interface Credentials {
  readonly owner: string;
  readonly passphrase: string;
  readonly keyId: string;
  readonly dataKey: string;
  readonly recoveryKey: string;
  readonly machines: Readonly<Record<string, string>>;
}

export interface Content {
  readonly inserts: readonly Insert[];
  readonly credentials: Credentials;
}

const START = Date.UTC(2026, 10, 1, 9, 0, 0);
const at = (minutes: number): string => new Date(START + minutes * 60_000).toISOString();
const json = (value: unknown): string => JSON.stringify(value);

const SHARED_AGENTS_VERSION = 3;
const LINK_RULES_VERSION = 2;
const TITLE_RULES_VERSION = 1;

type NoteAuthor = 'user' | 'agent' | 'system';

export async function buildContent(): Promise<Content> {
  const dataKey = generateDataKey();
  const recovery = crypto.getRandomValues(new Uint8Array(RECOVERY_KEY_BYTES));
  const keys: Keys = await deriveKeys(dataKey, OWNER);
  const passphraseSlot = await wrapSlot(dataKey, {
    kind: 'passphrase',
    passphrase: PASSPHRASE,
  });
  const recoverySlot = await wrapSlot(dataKey, { kind: 'recovery', recoveryKey: recovery });
  const setup: KeySetup = { keyId: keys.keyId, slots: [passphraseSlot, recoverySlot] };
  await unlockKeys(OWNER, setup, { kind: 'passphrase', passphrase: PASSPHRASE });

  const sealed = (binding: Binding, plaintext: string): Promise<string> =>
    seal(keys, binding, plaintext);
  const inserts: Insert[] = [];
  const add = (table: string, row: Record<string, unknown>): void => {
    inserts.push({ table, row });
  };
  const token = (): string => `abm_${toBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;

  add('app_user', {
    username: OWNER,
    created_at: at(0),
    key_id: setup.keyId,
    key_slots: json(setup.slots),
    source: 'passkey',
  });

  const tokens: Record<string, string> = {};
  const machineDocuments = {
    'fixture-laptop': {
      dirs: [
        {
          path: '/srv/fixture/alpha',
          label: 'alpha',
          repo: 'https://git.example.test/fixture/alpha.git',
        },
        { path: '/srv/fixture/beta', label: 'beta' },
      ],
      skills: [{ name: 'fixture-skill', description: 'A made-up skill' }],
    },
    'fixture-server': {
      dirs: [{ path: '/srv/fixture/gamma', label: 'gamma' }],
      skills: [],
    },
  } as const;
  for (const [index, name] of MACHINES.entries()) {
    tokens[name] = token();
    const documents = machineDocuments[name];
    const dirs = json({ dirs: documents.dirs });
    const catalog = json({
      models: ['sonnet', 'opus'],
      skills: documents.skills,
      dirs: {},
    });
    const usage = json({
      windows: { fiveHour: { percent: 12, resetsAt: at(300), seenAt: at(60) } },
      reached: [],
      held: [],
      open: [],
    });
    const feeds = json({ feeds: [{ id: 'fixture-feed', name: 'Fixture feed', status: 'idle' }] });
    const field = (kind: 'machine.dirs' | 'machine.catalog' | 'machine.usage' | 'machine.feeds') =>
      bindings.machineDocument(kind, name);
    add('machine', {
      owner: OWNER,
      name,
      token_hash: await tokenHash(tokens[name]!),
      created_at: at(1 + index),
      last_seen_at: at(120 + index),
      client_version: '0.0.0-fixture',
      client_api: 3,
      dirs: await sealed(field('machine.dirs'), dirs),
      dirs_index: await blindIndex(keys, dirs),
      dirs_updated_at: at(10 + index),
      catalog: await sealed(field('machine.catalog'), catalog),
      catalog_index: await blindIndex(keys, catalog),
      catalog_updated_at: at(11 + index),
      usage: await sealed(field('machine.usage'), usage),
      usage_index: await blindIndex(keys, usage),
      usage_updated_at: at(12 + index),
      feeds: await sealed(field('machine.feeds'), feeds),
      feeds_index: await blindIndex(keys, feeds),
      feeds_updated_at: at(13 + index),
      feed_requests: index === 0 ? ['pause:fixture-feed'] : [],
    });
  }

  const [laptop, server] = MACHINES;

  interface Fields {
    readonly title: string;
    readonly prompt: string;
    readonly creator?: 'user' | 'agent' | 'intake';
    readonly forkOf?: string;
    readonly agent?: string;
    readonly icon?: string;
    readonly labels?: readonly string[];
    readonly directory?: string;
    readonly sessionDirectory?: string;
  }

  const taskFields = async (id: string, f: Fields): Promise<Record<string, unknown>> => {
    const origin = { task: id };
    const homeWorkdir =
      f.directory === undefined ? null : await sealed(bindings.workdir(origin), f.directory);
    return {
      title: await sealed(bindings.title(origin), f.title),
      input: await sealed(
        bindings.input({
          origin,
          creator: f.creator ?? 'user',
          forkOf: f.forkOf ?? null,
          agent: f.agent ?? null,
        }),
        f.prompt,
      ),
      workdir:
        f.sessionDirectory === undefined
          ? homeWorkdir
          : await sealed(bindings.workdir(origin), f.sessionDirectory),
      home_workdir: homeWorkdir,
      agent: f.agent === undefined ? null : await sealed(bindings.agent(origin), f.agent),
      icon: f.icon === undefined ? null : await sealed(bindings.icon(origin), f.icon),
      labels: f.labels === undefined ? null : await sealed(bindings.labels(origin), json(f.labels)),
      created_by: f.creator ?? 'user',
      fork_of: f.forkOf ?? null,
    };
  };

  const watchDocument = (ids: readonly string[]): string =>
    json({
      watches: [
        {
          id: ids[0],
          name: 'ci-main',
          kind: 'ci',
          label: 'CI on fixture/alpha',
          status: 'pending',
          deadline: at(900),
        },
        {
          id: ids[1],
          name: 'wake-up',
          kind: 'timer',
          label: 'Timer',
          status: 'waiting',
          deadline: at(600),
        },
      ],
    });
  const WATCH_IDS = ['0123456789abcdef', 'fedcba9876543210'] as const;

  const stamps = (offset: number) => ({
    created_at: at(offset),
    updated_at: at(offset + 5),
  });

  add('task', {
    id: 'fixture-backlog',
    owner: OWNER,
    ...(await taskFields('fixture-backlog', {
      title: 'Sketch the release notes',
      prompt: 'Draft release notes for the fixture project.',
      icon: '📝',
      labels: ['docs'],
    })),
    status: 'backlog',
    priority: 'low',
    position: 1,
    ...stamps(20),
  });

  add('task', {
    id: 'fixture-proposed',
    owner: OWNER,
    ...(await taskFields('fixture-proposed', {
      title: 'Proposal: split the alpha module',
      prompt: 'Propose a split of the alpha module into two packages.',
      creator: 'agent',
      directory: '/srv/fixture/alpha',
    })),
    status: 'backlog',
    proposed: true,
    position: 2,
    ...stamps(22),
  });

  add('task', {
    id: 'fixture-todo',
    owner: OWNER,
    ...(await taskFields('fixture-todo', {
      title: 'Add a retry to the sync job',
      prompt: 'Add a bounded retry to the sync job in the alpha repository.',
      directory: '/srv/fixture/alpha',
      icon: '🔁',
      labels: ['backend', 'fixture'],
    })),
    status: 'todo',
    priority: 'high',
    model: 'sonnet',
    effort: 'high',
    requested_lane: 'default',
    auto_done: true,
    position: 1,
    not_before: at(1500),
    ...stamps(30),
  });

  add('task', {
    id: 'fixture-running',
    owner: OWNER,
    ...(await taskFields('fixture-running', {
      title: 'Fix the flaky export test',
      prompt: 'Find and fix the flaky export test in the beta repository.',
      directory: '/srv/fixture/beta',
      sessionDirectory: '/srv/fixture/beta/worktrees/export',
      icon: '🧪',
      labels: ['tests'],
    })),
    status: 'running',
    priority: 'urgent',
    model: 'opus',
    position: 1,
    machine: laptop,
    session_id: '00000000-0000-4000-8000-000000000001',
    next: 'resume',
    lane: 'main',
    last_active_at: at(200),
    run_started_at: at(190),
    run_id: 'fixture-run-current-0001',
    inbox_read: true,
    moved_by: 'machine',
    watches: await sealed(bindings.watches('fixture-running'), watchDocument(WATCH_IDS)),
    watch_stops: [WATCH_IDS[1]],
    ...stamps(40),
  });

  add('task', {
    id: 'fixture-waiting',
    owner: OWNER,
    ...(await taskFields('fixture-waiting', {
      title: 'Wait for the gamma deploy',
      prompt: 'Wait until the gamma deploy finishes, then verify the health page.',
      directory: '/srv/fixture/gamma',
    })),
    status: 'waiting',
    position: 1,
    machine: server,
    session_id: '00000000-0000-4000-8000-000000000002',
    wake_at: at(800),
    wait_check: true,
    moved_by: 'agent',
    watches: await sealed(bindings.watches('fixture-waiting'), watchDocument(WATCH_IDS)),
    ...stamps(50),
  });

  add('task', {
    id: 'fixture-needs-me',
    owner: OWNER,
    ...(await taskFields('fixture-needs-me', {
      title: 'Choose the cache strategy',
      prompt: 'Compare caching strategies for the alpha API and pick one.',
      directory: '/srv/fixture/alpha',
    })),
    status: 'needs-me',
    position: 1,
    machine: laptop,
    session_id: '00000000-0000-4000-8000-000000000003',
    moved_by: 'agent',
    open_question_note_id: 'fixture-note-question-open',
    ...stamps(60),
  });

  add('task', {
    id: 'fixture-done',
    owner: OWNER,
    ...(await taskFields('fixture-done', {
      title: 'Bump the alpha dependencies',
      prompt: 'Bump the alpha dependencies and open a pull request.',
      directory: '/srv/fixture/alpha',
    })),
    status: 'done',
    auto_done: true,
    position: 1,
    machine: laptop,
    session_id: '00000000-0000-4000-8000-000000000004',
    pr_state: 'merged',
    moved_by: 'agent',
    ...stamps(70),
  });

  add('task', {
    id: 'fixture-closed',
    owner: OWNER,
    ...(await taskFields('fixture-closed', {
      title: 'Archive the old beta branch',
      prompt: 'Archive the old beta branch.',
      directory: '/srv/fixture/beta',
    })),
    status: 'done',
    position: 2,
    closed: true,
    closed_at: at(400),
    parent_id: 'fixture-done',
    ...stamps(80),
  });

  add('task', {
    id: 'fixture-fork',
    owner: OWNER,
    ...(await taskFields('fixture-fork', {
      title: 'Review the alpha bump',
      prompt: 'Review the dependency bump pull request and list risks.',
      creator: 'agent',
      forkOf: 'fixture-done',
      agent: 'reviewer',
      directory: '/srv/fixture/alpha',
    })),
    status: 'todo',
    position: 2,
    parent_id: 'fixture-done',
    ...stamps(90),
  });

  const prUrl = 'https://github.example.test/fixture/alpha/pull/12';
  add('task', {
    id: 'fixture-review',
    owner: OWNER,
    ...(await taskFields('fixture-review', {
      title: 'Review alpha pull request 12',
      prompt: `Review ${prUrl}.`,
      creator: 'intake',
    })),
    status: 'todo',
    position: 3,
    head: await blindIndex(keys, '0123456789abcdef0123456789abcdef01234567'),
    dedupe_key: await blindIndex(keys, prUrl),
    pr_state: 'open',
    ...stamps(95),
  });

  const scheduleFields = async (id: string, f: Fields): Promise<Record<string, unknown>> => {
    const origin = { schedule: id };
    return {
      title: await sealed(bindings.title(origin), f.title),
      input: await sealed(
        bindings.input({ origin, creator: 'user', agent: f.agent ?? null }),
        f.prompt,
      ),
      workdir:
        f.directory === undefined ? null : await sealed(bindings.workdir(origin), f.directory),
      agent: f.agent === undefined ? null : await sealed(bindings.agent(origin), f.agent),
      icon: f.icon === undefined ? null : await sealed(bindings.icon(origin), f.icon),
      labels: f.labels === undefined ? null : await sealed(bindings.labels(origin), json(f.labels)),
    };
  };

  const intervalSchedule = await scheduleFields('fixture-schedule-interval', {
    title: 'Hourly sync check',
    prompt: 'Check that the sync job ran in the last hour.',
    directory: '/srv/fixture/alpha',
    icon: '⏱️',
    labels: ['ops'],
  });

  const occurrence = (id: string, scheduleId: string): Record<string, unknown> => ({
    id,
    owner: OWNER,
    title: intervalSchedule['title'],
    input: intervalSchedule['input'],
    icon: intervalSchedule['icon'],
    labels: intervalSchedule['labels'],
    home_workdir: intervalSchedule['workdir'],
    schedule_id: scheduleId,
  });

  add('task', {
    ...occurrence('fixture-occurrence-done', 'fixture-schedule-interval'),
    workdir: await sealed(
      bindings.workdir({ task: 'fixture-occurrence-done', schedule: 'fixture-schedule-interval' }),
      '/srv/fixture/alpha',
    ),
    status: 'done',
    position: 3,
    machine: laptop,
    occurrence_finished_at: at(260),
    ...stamps(100),
  });

  add('task', {
    ...occurrence('fixture-occurrence-next', 'fixture-schedule-interval'),
    workdir: intervalSchedule['workdir'],
    status: 'todo',
    position: 4,
    not_before: at(1560),
    ...stamps(105),
  });

  add('schedule', {
    id: 'fixture-schedule-interval',
    owner: OWNER,
    ...intervalSchedule,
    machine: laptop,
    every_ms: 3_600_000,
    anchor_at: at(0),
    last_occurrence_at: at(60),
    max_concurrent: 1,
    occurrence_task_id: 'fixture-occurrence-next',
    created_at: at(2),
  });

  add('schedule', {
    id: 'fixture-schedule-cron',
    owner: OWNER,
    ...(await scheduleFields('fixture-schedule-cron', {
      title: 'Weekday digest',
      prompt: 'Summarise yesterday activity on the alpha repository.',
      directory: '/srv/fixture/alpha',
    })),
    model: 'sonnet',
    effort: 'low',
    machine: server,
    cron: '30 8 * * 1-5',
    more_crons: ['0 18 * * 5'],
    timezone: 'UTC',
    anchor_at: at(0),
    remaining: 10,
    until: at(60 * 24 * 90),
    paused_at: at(300),
    created_at: at(3),
  });

  add('schedule', {
    id: 'fixture-schedule-after',
    owner: OWNER,
    ...(await scheduleFields('fixture-schedule-after', {
      title: 'Follow-up after the sync check',
      prompt: 'Report the result of the latest sync check.',
      agent: 'reviewer',
    })),
    priority: 'high',
    machine: laptop,
    after_schedule_id: 'fixture-schedule-interval',
    after_delay_ms: 120_000,
    anchor_at: at(0),
    created_at: at(4),
  });

  const note = async (
    id: string,
    taskId: string,
    author: NoteAuthor,
    kind: 'comment' | 'question' | 'answer' | 'event' | 'polish',
    text: string,
    offset: number,
    extra: Record<string, unknown> = {},
  ): Promise<void> => {
    const binding = (
      field: 'note.body' | 'note.preview' | 'note.suggestion' | 'note.questions' | 'note.answers',
    ) => bindings.note({ field, taskId, author, kind });
    add('note', {
      id,
      owner: OWNER,
      task_id: taskId,
      author,
      kind,
      body: await sealed(binding('note.body'), text),
      preview: await sealed(binding('note.preview'), text.slice(0, 40)),
      by: author === 'user' ? OWNER : laptop,
      created_at: at(offset),
      ...extra,
    });
  };

  const questions = json({
    questions: [
      {
        header: 'Cache',
        question: 'Which cache strategy should the alpha API use?',
        multiSelect: false,
        options: [
          { label: 'In-process', description: 'Simple, per instance', recommended: true },
          { label: 'Shared', description: 'One cache for every instance' },
        ],
      },
    ],
  });

  await note(
    'fixture-note-question-open',
    'fixture-needs-me',
    'agent',
    'question',
    'Which cache strategy should the alpha API use?',
    120,
    {
      questions: await sealed(
        bindings.note({
          field: 'note.questions',
          taskId: 'fixture-needs-me',
          author: 'agent',
          kind: 'question',
        }),
        questions,
      ),
    },
  );
  await note(
    'fixture-note-question-done',
    'fixture-done',
    'agent',
    'question',
    'Should the lockfile be regenerated?',
    130,
    {
      questions: await sealed(
        bindings.note({
          field: 'note.questions',
          taskId: 'fixture-done',
          author: 'agent',
          kind: 'question',
        }),
        questions,
      ),
    },
  );
  await note('fixture-note-answer', 'fixture-done', 'user', 'answer', 'Yes, regenerate it.', 135, {
    question_note_id: 'fixture-note-question-done',
    answers: await sealed(
      bindings.note({
        field: 'note.answers',
        taskId: 'fixture-done',
        author: 'user',
        kind: 'answer',
      }),
      json([{ selected: ['In-process'] }]),
    ),
  });
  await note(
    'fixture-note-comment-user',
    'fixture-todo',
    'user',
    'comment',
    'Keep the retry limit below five attempts.',
    140,
  );
  await note(
    'fixture-note-comment-pending',
    'fixture-running',
    'user',
    'comment',
    'Please also check the import test.',
    150,
    { pending: true, queued: true },
  );
  await note(
    'fixture-note-comment-delivered',
    'fixture-running',
    'user',
    'comment',
    'Use the beta fixtures only.',
    155,
    { queued: true, delivered_at: at(156) },
  );
  await note(
    'fixture-note-comment-agent',
    'fixture-running',
    'agent',
    'comment',
    'The test depends on the clock; I will freeze it.',
    160,
    {
      suggestion: await sealed(
        bindings.note({
          field: 'note.suggestion',
          taskId: 'fixture-running',
          author: 'agent',
          kind: 'comment',
        }),
        'Go ahead and freeze the clock.',
      ),
    },
  );
  await note(
    'fixture-note-polish',
    'fixture-done',
    'agent',
    'polish',
    'Polished the pull request description.',
    165,
  );
  await note(
    'fixture-note-event-system',
    'fixture-running',
    'system',
    'event',
    'Run claimed by fixture-laptop.',
    170,
  );
  add('note', {
    id: 'fixture-note-event-server',
    owner: OWNER,
    task_id: 'fixture-running',
    author: 'server',
    kind: 'event',
    body: 'Moved from Todo to Running.',
    created_at: at(171),
  });

  const pr = async (id: string, taskId: string, number: number, state: string): Promise<void> => {
    add('task_pr', {
      id,
      owner: OWNER,
      task_id: taskId,
      pr: await sealed(
        bindings.pr(taskId),
        `https://github.example.test/fixture/alpha/pull/${number}`,
      ),
      state,
      created_at: at(180 + number),
    });
  };
  await pr('fixture-pr-merged', 'fixture-done', 11, 'merged');
  await pr('fixture-pr-open', 'fixture-running', 12, 'open');
  await pr('fixture-pr-closed', 'fixture-done', 10, 'closed');

  const run = async (
    id: string,
    taskId: string,
    machine: string,
    resumed: boolean,
    events: readonly {
      kind: string;
      body: Record<string, unknown>;
      output?: string;
    }[],
  ): Promise<void> => {
    add('transcript_run', {
      id,
      owner: OWNER,
      task_id: taskId,
      machine,
      session_id: '00000000-0000-4000-8000-000000000004',
      resumed,
      started_at: at(210),
      last_event_at: at(210 + events.length),
      event_count: events.length,
    });
    for (const [seq, event] of events.entries()) {
      const binding = (field: 'tr.data' | 'tr.output') =>
        bindings.transcript({ field, taskId, runId: id, seq });
      add('transcript_event', {
        owner: OWNER,
        run_id: id,
        seq,
        at: at(210 + seq),
        kind: event.kind,
        parent: null,
        data: await sealed(
          binding('tr.data'),
          json({ seq, at: at(210 + seq), parent: null, kind: event.kind, ...event.body }),
        ),
        output:
          event.output === undefined ? null : await sealed(binding('tr.output'), event.output),
        output_size: event.output === undefined ? null : event.output.length,
      });
    }
  };

  await run('fixture-run-0000000001', 'fixture-done', laptop, false, [
    { kind: 'text', body: { text: 'Reading the dependency manifest.' } },
    {
      kind: 'tool_use',
      body: { toolUseId: 'tool-1', name: 'Bash', input: { command: 'cat package.json' } },
    },
    {
      kind: 'tool_result',
      body: { toolUseId: 'tool-1', isError: false },
      output: '{ "name": "fixture-alpha", "version": "1.2.3" }',
    },
    {
      kind: 'result',
      body: {
        text: 'Dependencies bumped.',
        isError: false,
        turns: 3,
        durationMs: 4200,
        costUsd: 0.12,
        denials: [],
      },
    },
  ]);
  await run('fixture-run-0000000002', 'fixture-running', laptop, true, [
    { kind: 'text', body: { text: 'Resuming the export test investigation.' } },
    { kind: 'note', body: { text: 'Session resumed.' } },
  ]);

  add('passkey', {
    credential_id: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
    owner: OWNER,
    public_key: toBase64Url(crypto.getRandomValues(new Uint8Array(77))),
    counter: 4,
    transports: json(['internal', 'hybrid']),
    name: 'Fixture laptop key',
    created_at: at(5),
    last_used_at: at(250),
  });

  add('shared_agents', {
    owner: OWNER,
    version: SHARED_AGENTS_VERSION,
    document: await sealed(
      bindings.sharedAgents(SHARED_AGENTS_VERSION),
      json({
        version: SHARED_AGENTS_VERSION,
        agents: {
          reviewer: {
            description: 'Reviews pull requests',
            prompt: 'Review the diff and list the risks.',
            model: 'sonnet',
            tools: ['Read', 'Grep'],
          },
        },
      }),
    ),
    pushed_at: at(6),
  });

  add('link_rules', {
    owner: OWNER,
    version: LINK_RULES_VERSION,
    document: await sealed(
      bindings.links(LINK_RULES_VERSION),
      json({
        version: LINK_RULES_VERSION,
        rules: [
          { pattern: 'FX-(\\d+)', url: 'https://tracker.example.test/browse/FX-$1', flags: 'i' },
        ],
      }),
    ),
    updated_at: at(7),
  });

  add('title_rules', {
    owner: OWNER,
    version: TITLE_RULES_VERSION,
    document: await sealed(
      bindings.titles(TITLE_RULES_VERSION),
      json({
        version: TITLE_RULES_VERSION,
        rules: [
          {
            pattern: '^release',
            icon: '🚀',
            labels: ['release'],
            instruction: 'Start the title with the version number.',
          },
        ],
      }),
    ),
    updated_at: at(8),
  });

  return {
    inserts,
    credentials: {
      owner: OWNER,
      passphrase: PASSPHRASE,
      keyId: keys.keyId,
      dataKey: encodeDataKey(dataKey),
      recoveryKey: await formatRecoveryKey(recovery),
      machines: tokens,
    },
  };
}
