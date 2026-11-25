import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  bindings,
  deriveKeys,
  generateDataKey,
  isEnvelope,
  open,
  type Keys,
} from '@agent-board/sealing';
import { describe, expect, it } from 'vitest';

import { buildContext } from '../src/commands/context.js';
import type { OpenNote, OpenTask } from '../src/commands/tasks/open.js';
import { createRunRecords } from '../src/dispatch/run-record.js';
import { execFileText } from '../src/runtime.js';
import {
  autoTitle,
  checkTitle,
  matchTitleRule,
  parseTitleRules,
  titleArguments,
  titleQuestion,
} from '../src/worker/auto-title.js';
import { parseHookInput, runHook } from '../src/worker/hook.js';
import {
  AGENT_PERMISSION_MODE,
  USER_PERMISSION_MODE,
  claudeArguments,
  expandRule,
} from '../src/worker/invocation.js';
import { CONTINUE_PROMPT, planRun, resumePrompt } from '../src/worker/plan.js';
import { rateLimitIn, recordUsage, sameReading } from '../src/worker/rate-limit.js';
import { createSessionStore } from '../src/worker/sessions.js';
import { condense, mainContext, parseLine, truncateUtf8 } from '../src/worker/stream.js';
import {
  TRANSCRIPT_BYTE_LIMIT,
  TRANSCRIPT_EVENT_LIMIT,
  createTranscript,
  sealedBytes,
  type TranscriptSink,
} from '../src/worker/transcript.js';
import { createWorktreeLocks, lockReason } from '../src/worker/worktree-locks.js';
import { limitReached } from '../src/worker/run.js';
import { readStoredUsage } from '../src/dispatch/usage.js';
import { useRig } from './support/harness.js';
import { tmpDir } from './support/files.js';

const rig = useRig();
const TASK = 'taskAAAA';
const SESSION = '11111111-1111-4111-8111-111111111111';
const OTHER_SESSION = '22222222-2222-4222-8222-222222222222';

async function keys(): Promise<Keys> {
  return deriveKeys(generateDataKey(), 'owner');
}

interface Posted {
  runId: string;
  events: { seq: number; kind: string; data: string; output?: string }[];
}

async function sink(overrides: Partial<TranscriptSink> = {}) {
  const posted: Posted[] = [];
  const sealingKeys = await keys();
  const value: TranscriptSink = {
    keys: sealingKeys,
    taskId: TASK,
    runId: 'run-aaaaaaaa',
    startedAt: new Date(0).toISOString(),
    sessionId: SESSION,
    resumed: false,
    post: (request) => {
      posted.push(request as unknown as Posted);
      return Promise.resolve(null);
    },
    log: () => undefined,
    now: () => new Date(0),
    reportContext: true,
    ...overrides,
  };
  return { value, posted, keys: sealingKeys };
}

const text = (body: string) => ({ kind: 'text' as const, parent: null, data: { text: body } });

function note(author: string, body: string | null, unreadable = false): OpenNote {
  return {
    id: `n-${author}-${String(body)}`,
    author,
    kind: 'comment',
    createdAt: '2026-01-01T00:00:00.000Z',
    text: body,
    questions: null,
    answers: null,
    questionNoteId: null,
    suggestion: null,
    unreadable,
  };
}

describe('the stream of the agent', () => {
  it('[cli-077] turns assistant blocks, tool calls and their results into transcript drafts', () => {
    const assistant = parseLine(
      JSON.stringify({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          content: [
            { type: 'text', text: 'hello' },
            { type: 'thinking', thinking: 'hm' },
            { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      }),
    );
    const drafts = condense(assistant ?? {});
    expect(drafts.map((draft) => draft.kind)).toEqual(['text', 'thinking', 'tool_use']);
    expect(drafts[2]?.data).toMatchObject({ id: 'toolu_1', name: 'Bash' });
    const result = condense(
      parseLine(
        JSON.stringify({
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a\nb' }],
          },
        }),
      ) ?? {},
    );
    expect(result).toEqual([
      expect.objectContaining({
        kind: 'tool_result',
        output: 'a\nb',
        data: { toolUseId: 'toolu_1', isError: false, size: 3 },
      }),
    ]);
    expect(condense({ type: 'system', subtype: 'init' })).toEqual([]);
    expect(parseLine('not json')).toBeNull();
  });

  it('[cli-077] cuts a long text on a character boundary and keeps an output within its bound', () => {
    const cut = truncateUtf8('é'.repeat(10), 5);
    expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(5);
    expect(cut).toBe('éé');
    const big = condense({
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 't', content: 'x'.repeat(300_000) }],
      },
    });
    expect(big[0]?.output).toHaveLength(256 * 1024);
  });

  it('[cli-078] reads the context only from the main agent and ignores empty usage reports', () => {
    const main = (usage: unknown, parent: string | null = null) => ({
      type: 'assistant',
      parent_tool_use_id: parent,
      message: { model: 'm', usage },
    });
    expect(
      mainContext(
        main({ input_tokens: 40_000, cache_read_input_tokens: 10_000, output_tokens: 7 }),
      ),
    ).toEqual({ used: 50_000, model: 'm' });
    expect(mainContext(main({ input_tokens: 4_321 }, 'toolu_sub'))).toBeNull();
    expect(mainContext(main({ input_tokens: 0, output_tokens: 0 }))).toBeNull();
    expect(mainContext({ type: 'user' })).toBeNull();
  });
});

describe('the transcript uploader', () => {
  it('[cli-077] seals every event and its output and sends them in order', async () => {
    const { value, posted, keys: sealing } = await sink();
    const transcript = createTranscript(value);
    transcript.add([
      text('one'),
      {
        kind: 'tool_result',
        parent: null,
        data: { toolUseId: 't' },
        output: 'long output',
      },
    ]);
    await transcript.flush();
    const [batch] = posted;
    expect(batch?.events.map((event) => event.seq)).toEqual([0, 1]);
    for (const event of batch?.events ?? []) expect(isEnvelope(event.data)).toBe(true);
    expect(isEnvelope(batch?.events[1]?.output ?? '')).toBe(true);
    expect(
      await open(
        sealing,
        bindings.transcript({ field: 'tr.data', taskId: TASK, runId: 'run-aaaaaaaa', seq: 0 }),
        batch?.events[0]?.data ?? '',
      ),
    ).toBe('{"text":"one"}');
  });

  it('[cli-077] keeps what the board did not take for the next upload', async () => {
    let failing = true;
    const { value, posted } = await sink({
      post: (request) => {
        if (failing) return Promise.reject(new Error('down'));
        posted.push(request as unknown as Posted);
        return Promise.resolve(null);
      },
    });
    const transcript = createTranscript(value);
    transcript.add([text('a'), text('b')]);
    await transcript.flush();
    expect(posted).toHaveLength(0);
    failing = false;
    await transcript.flush();
    expect(posted[0]?.events.map((event) => event.seq)).toEqual([0, 1]);
  });

  it('[cli-077] stores at most 20,000 events', async () => {
    const { value, posted } = await sink();
    const transcript = createTranscript(value);
    transcript.add(
      Array.from({ length: TRANSCRIPT_EVENT_LIMIT + 1 }, (_, index) => text(`e${index}`)),
    );
    await transcript.flush();
    const sent = posted.reduce((total, batch) => total + batch.events.length, 0);
    expect(sent).toBe(TRANSCRIPT_EVENT_LIMIT);
    expect(posted.every((batch) => batch.events.length <= 1000)).toBe(true);
  }, 30_000);

  it('[cli-077] stops before the sealed events pass 32 MB and splits what it sends under the body limit', async () => {
    const { value, posted } = await sink();
    const transcript = createTranscript(value);
    transcript.add(Array.from({ length: 40 }, () => text('x'.repeat(1_000_000))));
    await transcript.flush();
    const sent = posted.reduce((total, batch) => total + batch.events.length, 0);
    expect(sent).toBeLessThan(40);
    expect(sent * sealedBytes(1_000_012)).toBeLessThanOrEqual(TRANSCRIPT_BYTE_LIMIT);
    for (const batch of posted) {
      expect(JSON.stringify(batch).length).toBeLessThan(16 * 1024 * 1024);
    }
  }, 60_000);

  it('[cli-078] sends the latest context of the main agent once, and nothing when the board lacks the feature', async () => {
    const withFeature = await sink();
    const transcript = createTranscript(withFeature.value);
    transcript.setContext({ used: 50_000, model: 'stub' });
    transcript.add([text('a')]);
    await transcript.flush();
    await transcript.flush();
    const context = withFeature.posted.flatMap((batch) =>
      batch.events.filter((event) => event.kind === 'context'),
    );
    expect(context).toHaveLength(1);
    expect(
      JSON.parse(
        await open(
          withFeature.keys,
          bindings.transcript({
            field: 'tr.data',
            taskId: TASK,
            runId: 'run-aaaaaaaa',
            seq: context[0]?.seq ?? 0,
          }),
          context[0]?.data ?? '',
        ),
      ),
    ).toEqual({ used: 50_000, window: 200_000, model: 'stub' });
    expect(transcript.stored()).toBe(1);

    const without = await sink({ reportContext: false });
    const quiet = createTranscript(without.value);
    quiet.setContext({ used: 50_000, model: 'stub' });
    quiet.add([text('a')]);
    await quiet.flush();
    expect(without.posted.flatMap((batch) => batch.events).map((event) => event.kind)).toEqual([
      'text',
    ]);
  });
});

describe('the invocation of claude', () => {
  const run = { kind: 'fresh', sessionId: SESSION } as const;
  const base = {
    run,
    model: null,
    effort: null,
    hookCommand: "'board' 'internal' 'hook'",
    home: '/srv/runner',
  } as const;

  it('[cli-072] a user task runs in auto mode with the settings of the user, the project and the local file', () => {
    const { args } = claudeArguments(base);
    expect(args).toEqual(expect.arrayContaining(['-p', '--permission-mode', USER_PERMISSION_MODE]));
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('auto');
    expect(args).not.toContain('--setting-sources');
    expect(args).toEqual(expect.arrayContaining(['--session-id', SESSION]));
  });

  it('[cli-072] an agent task runs in dontAsk mode with user settings only and its allow and deny lists', () => {
    const { args, agentsFile } = claudeArguments({
      ...base,
      agent: {
        name: 'reviewer',
        definition: {
          description: 'reviews',
          prompt: 'be careful',
          tools: ['Bash', 'Read', 'mcp__x__y'],
          allowedTools: ['Bash(git diff:*)', 'Bash(~/bin/tool:*)'],
          disallowedTools: ['Bash(rm:*)'],
        },
      },
      agentsPath: '/run/agents.json',
    });
    expect(args[args.indexOf('--permission-mode') + 1]).toBe(AGENT_PERMISSION_MODE);
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('user');
    expect(args).toContain('--tools=Bash,Read');
    expect(
      args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--allowedTools') + 3),
    ).toEqual(['Bash(git diff:*)', 'Bash(/srv/runner/bin/tool:*)']);
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe('Bash(rm:*)');
    expect(JSON.parse(agentsFile?.content ?? '{}')).toMatchObject({
      reviewer: {
        description: 'reviews',
        prompt: 'be careful',
        tools: ['Bash', 'Read', 'mcp__x__y'],
      },
    });
    expect(expandRule('Read(~/x)', '/srv/runner')).toBe('Read(~/x)');
  });

  it('[cli-072] a tool rule that would read as an option refuses the run', () => {
    expect(() =>
      claudeArguments({
        ...base,
        agent: {
          name: 'a',
          definition: { description: 'd', tools: ['Bash'], allowedTools: ['--dangerous'] },
        },
        agentsPath: '/run/agents.json',
      }),
    ).toThrow(/read as an option/);
  });

  it('[cli-071] never puts the prompt on the command line and always carries the hook', () => {
    const { args } = claudeArguments(base);
    expect(args).toEqual(expect.arrayContaining(['--input-format', 'stream-json']));
    const settings = JSON.parse(args[args.indexOf('--settings') + 1] ?? '{}');
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe(base.hookCommand);
  });

  it('[cli-076] a fork resumes the parent session into a copy with its own id', () => {
    const { args } = claudeArguments({
      ...base,
      run: { kind: 'fork', sessionId: SESSION, fromSessionId: OTHER_SESSION, parent: 'parentAA' },
    });
    expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 5)).toEqual([
      '--resume',
      OTHER_SESSION,
      '--fork-session',
      '--session-id',
      SESSION,
    ]);
  });
});

describe('the run plan', () => {
  const task = (wire: Record<string, unknown>): OpenTask =>
    ({ id: TASK, wire: { id: TASK, next: 'fresh', sessionId: null, ...wire } }) as OpenTask;

  function store(recorded: [string, string][]) {
    const dir = tmpDir();
    const sessions = createSessionStore(dir);
    for (const [id, session] of recorded) sessions.record(id, session);
    return sessions;
  }

  it('[cli-076] resumes only a session this machine recorded for the task', () => {
    const wire = { next: 'resume', sessionId: SESSION };
    const own = planRun({ task: task(wire), notes: [], sessions: store([[TASK, SESSION]]) });
    expect(own).toEqual({ kind: 'resume', sessionId: SESSION, prompt: CONTINUE_PROMPT });
    const foreign = planRun({ task: task(wire), notes: [], sessions: store([]) });
    expect(foreign).toMatchObject({ kind: 'blocked' });
    const swapped = planRun({
      task: task(wire),
      notes: [],
      sessions: store([['taskBBBB', SESSION]]),
    });
    expect(swapped).toMatchObject({ kind: 'blocked' });
  });

  it('[cli-076] a fork needs the session of its parent on this machine', () => {
    const wire = { forkOf: 'parentAA' };
    const sessions = store([['parentAA', SESSION]]);
    const forked = planRun({
      task: task(wire),
      notes: [],
      sessions,
      parent: { id: 'parentAA', sessionId: SESSION },
      newSessionId: () => OTHER_SESSION,
    });
    expect(forked).toEqual({
      kind: 'fork',
      sessionId: OTHER_SESSION,
      fromSessionId: SESSION,
      parent: 'parentAA',
    });
    for (const parent of [
      undefined,
      { id: 'another', sessionId: SESSION },
      { id: 'parentAA', sessionId: null },
      { id: 'parentAA', sessionId: OTHER_SESSION },
    ]) {
      expect(planRun({ task: task(wire), notes: [], sessions, parent })).toMatchObject({
        kind: 'blocked',
      });
    }
  });

  it('[cli-076] a fresh run gets a new session id', () => {
    expect(
      planRun({ task: task({}), notes: [], sessions: store([]), newSessionId: () => SESSION }),
    ).toEqual({
      kind: 'fresh',
      sessionId: SESSION,
    });
  });

  it('[cli-076] the resume prompt is what the user and the board wrote since the agent last spoke', () => {
    const notes = [
      note('user', 'first'),
      note('agent', 'asking'),
      note('user', 'the answer'),
      note('system', 'woken'),
    ];
    expect(resumePrompt(notes)).toEqual({ text: 'the answer\n\nwoken', unreadable: false });
    expect(resumePrompt([note('user', null, true)]).unreadable).toBe(true);
    expect(
      planRun({
        task: task({ next: 'resume', sessionId: SESSION }),
        notes: [note('user', null, true)],
        sessions: store([[TASK, SESSION]]),
      }),
    ).toMatchObject({ kind: 'blocked' });
  });
});

describe('the limits of a run', () => {
  const minute = 60_000;
  const input = { now: 0, startedAt: 0, lastActive: null, inactivityMinutes: 15, maxRunHours: 6 };

  it('[cli-073] a run is stopped after the inactivity limit and after the maximum hours', () => {
    expect(limitReached({ ...input, now: 14 * minute })).toBeNull();
    expect(limitReached({ ...input, now: 16 * minute })).toMatch(/no tool call for 15 minutes/);
    expect(limitReached({ ...input, now: 16 * minute, lastActive: 15 * minute })).toBeNull();
    expect(
      limitReached({ ...input, now: 6 * 60 * minute + 1, lastActive: 6 * 60 * minute }),
    ).toMatch(/after 6 hours/);
  });
});

describe('the title rules', () => {
  const document = JSON.stringify({
    version: 1,
    rules: [
      { pattern: 'nomatch', icon: '1' },
      {
        pattern: 'REVIEW (\\S+)',
        flags: 'i',
        title: 'name the PR',
        icon: '🔍',
        labels: ['review'],
      },
      { pattern: '(', icon: 'x' },
    ],
  });

  it('[cli-079] picks the first rule whose pattern matches and skips a broken pattern', () => {
    const rules = parseTitleRules(document);
    expect(matchTitleRule(rules, 'please review https://x/1')?.icon).toBe('🔍');
    expect(matchTitleRule(rules, 'nothing here')).toBeUndefined();
    expect(parseTitleRules('not json')).toEqual([]);
  });

  it('[cli-079] the small model may read only pull requests and issues and answers one line of 1 to 100 characters', () => {
    const args = titleArguments();
    expect(
      args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--permission-mode')),
    ).toEqual(['Bash(gh pr view:*)', 'Bash(gh issue view:*)']);
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(args[args.indexOf('--model') + 1]).toBe('haiku');
    expect(titleQuestion('name it', 'the prompt')).toContain('gh pr view');
    expect(checkTitle('  A title  ', 'other')).toEqual({ title: 'A title' });
    expect(checkTitle('', 'x')).toMatchObject({ problem: expect.any(String) });
    expect(checkTitle('two\nlines', 'x')).toMatchObject({ problem: expect.any(String) });
    expect(checkTitle('x'.repeat(101), 'x')).toMatchObject({ problem: expect.any(String) });
    expect(checkTitle('x'.repeat(100), 'y')).toEqual({ title: 'x'.repeat(100) });
    expect(checkTitle('same', 'same')).toMatchObject({ problem: expect.any(String) });
  });

  it('[cli-079] a matching rule sets icon, labels and the written title, which only replaces the title it saw', async () => {
    const { stub, cli } = await rig();
    await stub.setTitleRules(1, document);
    const prompt = 'review https://github.com/acme/widgets/pull/9';
    const wire = await stub.addTask({ id: TASK, status: 'running', input: prompt, title: prompt });
    stub.patch(TASK, { run: 'runAAAAAAAAAAAAAA' });
    const ctx = buildContext(cli.test.rt, {});
    const { openSession } = await import('../src/transport/session.js');
    const { openTask } = await import('../src/commands/tasks/open.js');
    const s = await openSession({ rt: ctx.rt, dirs: ctx.dirs, dryRun: false });
    const opened = await openTask(s.keys, stub.tasks.get(TASK) ?? wire);
    const log: string[] = [];
    await autoTitle({
      s,
      task: opened,
      cwd: '/tmp',
      write: ({ instruction }) => Promise.resolve({ title: `Written from: ${instruction}` }),
      log: (line) => log.push(line),
    });
    const [icon, labels, title] = stub.titleChanges;
    expect(await stub.open(bindings.icon({ task: TASK }), String(icon?.icon))).toBe('🔍');
    expect(
      JSON.parse(await stub.open(bindings.labels({ task: TASK }), String(labels?.labels))),
    ).toEqual(['review']);
    expect(await stub.open(bindings.title({ task: TASK }), String(title?.title))).toBe(
      'Written from: name the PR',
    );
    expect(title?.expectTitle).toBe(wire.title);
    expect(log).toContain('title set');
  });

  it('[cli-079] leaves a task alone whose title was set by hand, and one a failed writer gave no title', async () => {
    const { stub, cli } = await rig();
    await stub.setTitleRules(1, document);
    const prompt = 'review https://github.com/acme/widgets/pull/9';
    await stub.addTask({ id: TASK, status: 'running', input: prompt, title: 'my own title' });
    await stub.addTask({ id: 'taskBBBB', status: 'running', input: prompt, title: prompt });
    stub.patch(TASK, { run: 'runAAAAAAAAAAAAAA' });
    stub.patch('taskBBBB', { run: 'runBBBBBBBBBBBBBB' });
    const ctx = buildContext(cli.test.rt, {});
    const { openSession } = await import('../src/transport/session.js');
    const { openTask } = await import('../src/commands/tasks/open.js');
    const s = await openSession({ rt: ctx.rt, dirs: ctx.dirs, dryRun: false });
    const log: string[] = [];
    const write = () => Promise.resolve({ problem: 'no answer' });
    const hand = await openTask(s.keys, stub.tasks.get(TASK)!);
    await autoTitle({ s, task: hand, cwd: '/tmp', write, log: (line) => log.push(line) });
    expect(stub.titleChanges).toHaveLength(0);
    const failing = await openTask(s.keys, stub.tasks.get('taskBBBB')!);
    await autoTitle({ s, task: failing, cwd: '/tmp', write, log: (line) => log.push(line) });
    expect(stub.titleChanges.filter((change) => change.title !== undefined)).toHaveLength(0);
    expect(log).toContain('title not written: no answer');
  });
});

describe('the usage the agent reports', () => {
  const event = (info: unknown) => ({ type: 'rate_limit_event', rate_limit_info: info });

  it('[cli-068] reads both windows of a rate limit event and ignores other shapes', () => {
    const reset = Math.floor(Date.now() / 1000) + 3600;
    const reading = rateLimitIn(
      event({
        unifiedWindows: {
          five_hour: { utilization: 0.4, resetsAt: reset },
          seven_day: { utilization: 0.1, resetsAt: reset },
        },
      }),
    );
    expect(reading?.fiveHour?.utilization).toBe(0.4);
    expect(reading?.sevenDay?.resetsAt.getTime()).toBe(reset * 1000);
    expect(
      rateLimitIn(event({ rateLimitType: 'five_hour', status: 'rejected', resetsAt: reset }))
        ?.fiveHour?.utilization,
    ).toBe(1);
    expect(rateLimitIn(event({ nothing: true }))).toBeUndefined();
    expect(rateLimitIn({ type: 'assistant' })).toBeUndefined();
    expect(sameReading(reading ?? {}, reading ?? {})).toBe(true);
  });

  it('[cli-068] writes the windows to usage.json where the tick reads them and keeps the others', () => {
    const state = tmpDir();
    const reset = new Date(Date.now() + 3_600_000);
    recordUsage(state, { fiveHour: { utilization: 0.5, resetsAt: reset } }, new Date());
    recordUsage(state, { sevenDay: { utilization: 0.2, resetsAt: reset } }, new Date());
    const stored = readStoredUsage(state);
    expect(stored.fiveHour?.utilization).toBe(0.5);
    expect(stored.sevenDay?.utilization).toBe(0.2);
    expect(readFileSync(path.join(state, 'usage.json'), 'utf8')).toContain('fiveHour');
  });
});

describe('worktree locks', () => {
  function repository() {
    const root = mkdtempSync(path.join(os.tmpdir(), 'board-wt-'));
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 't',
          GIT_AUTHOR_EMAIL: 't@t',
          GIT_COMMITTER_NAME: 't',
          GIT_COMMITTER_EMAIL: 't@t',
        },
      });
    const main = path.join(root, 'main');
    mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');
    git(main, 'commit', '-q', '--allow-empty', '-m', 'first');
    const linked = path.join(root, 'linked');
    git(main, 'worktree', 'add', '-q', '-b', 'topic', linked);
    return { main, linked: readlinked(linked), git };
  }
  const readlinked = (dir: string): string =>
    execFileSync('realpath', [dir], { encoding: 'utf8' }).trim();

  it('[cli-081] locks a linked worktree with the task as reason and unlocks it when asked', async () => {
    const { main, linked, git } = repository();
    const locks = createWorktreeLocks(tmpDir(), execFileText);
    expect(await locks.hold(TASK, main)).toBeUndefined();
    expect(await locks.hold(TASK, linked)).toMatch(/locked the worktree/);
    expect(git(main, 'worktree', 'list', '--porcelain')).toContain(`locked ${lockReason(TASK)}`);
    expect(await locks.hold(TASK, linked)).toBeUndefined();
    expect(locks.tasks()).toEqual([TASK]);
    expect(await locks.release(TASK, linked)).toEqual([]);
    expect(await locks.release(TASK)).toEqual([expect.stringMatching(/unlocked the worktree/)]);
    expect(git(main, 'worktree', 'list', '--porcelain')).not.toContain('locked');
    expect(locks.tasks()).toEqual([]);
  });

  it('[cli-081] leaves a worktree somebody else locked as it is', async () => {
    const { linked, git, main } = repository();
    git(main, 'worktree', 'lock', '--reason', 'mine', linked);
    const locks = createWorktreeLocks(tmpDir(), execFileText);
    expect(await locks.hold(TASK, linked)).toMatch(/locked already/);
    expect(locks.tasks()).toEqual([]);
  });
});

describe('the PreToolUse hook', () => {
  async function hookContext(env: Record<string, string> = {}, stdin = '{}') {
    const { cli, stub } = await rig({ env, stdin });
    const ctx = buildContext(cli.test.rt, {});
    return { ctx, cli, stub };
  }

  it('[cli-080] reads the working directory of the agent from its input', () => {
    expect(parseHookInput('{"cwd":"/work/tree"}')).toEqual({ cwd: '/work/tree' });
    expect(parseHookInput('{"cwd":"relative"}')).toEqual({ cwd: null });
    expect(parseHookInput('nonsense')).toEqual({ cwd: null });
  });

  it('[cli-080] touches the liveness of the task and records where the agent is', async () => {
    const { ctx } = await hookContext({}, JSON.stringify({ cwd: '/work/tree' }));
    mkdirSync(ctx.dirs.run, { recursive: true });
    await runHook(ctx, [ctx.dirs.run, TASK]);
    const records = createRunRecords(ctx.dirs.run);
    expect(records.lastActive(TASK)).not.toBeNull();
    expect(records.lastCwd(TASK)).toBe('/work/tree');
  });

  it('[cli-080] ignores a call that names another task or run directory inside a run, and never fails', async () => {
    const { ctx, cli } = await hookContext({ AGENT_BOARD_TASK: 'taskBBBB' });
    mkdirSync(ctx.dirs.run, { recursive: true });
    await runHook(ctx, [ctx.dirs.run, TASK]);
    expect(createRunRecords(ctx.dirs.run).lastActive(TASK)).toBeNull();
    await runHook(ctx, []);
    await runHook(ctx, ['relative', TASK]);
    expect(cli.stderr()).toContain('board internal hook');
  });

  it('[cli-080] is a command that exits 0 even when its arguments are wrong', async () => {
    const { cli } = await rig({ stdin: '' });
    expect(await cli.run('internal', 'hook', '--unknown', 'x')).toBe(0);
    expect(await cli.run('internal', 'hook')).toBe(0);
  });
});
