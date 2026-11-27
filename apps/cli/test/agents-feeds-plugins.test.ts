import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { bindings } from '@rumo/sealing';
import { parse, stringify } from 'yaml';
import { describe, expect, it } from 'vitest';

import { execFileText } from '../src/runtime.js';
import { tmpDir, tmpFile } from './support/files.js';
import { useRig } from './support/harness.js';

const rig = useRig();

const REVIEWER = {
  description: 'Reviews a change',
  tools: ['Read', 'Grep'],
  allowedTools: ['Bash(git diff:*)'],
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.test',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd, encoding: 'utf8' },
  ).trim();
}

function pluginRepo(items: string, name = 'acme'): string {
  const repo = tmpDir();
  git(repo, 'init', '--quiet', '-b', 'main');
  mkdirSync(path.join(repo, '.rumo'));
  writeFileSync(
    path.join(repo, '.rumo', 'marketplace.json'),
    JSON.stringify({
      protocol: 1,
      name,
      feeds: { prs: { program: 'bin/prs', description: 'open PRs' } },
    }),
  );
  mkdirSync(path.join(repo, 'bin'));
  writeFileSync(
    path.join(repo, 'bin', 'prs'),
    `#!/bin/sh\ncat "$PWD/items.json" 2>/dev/null || echo '${items}'\n`,
  );
  chmodSync(path.join(repo, 'bin', 'prs'), 0o755);
  git(repo, 'add', '-A');
  git(repo, 'commit', '--quiet', '-m', 'first');
  return repo;
}

function configOf(cli: { test: { path(...segments: string[]): string } }): Record<string, unknown> {
  return parse(readFileSync(cli.test.path('config', 'config.yaml'), 'utf8')) as Record<
    string,
    unknown
  >;
}

function agentFile(definition: Record<string, unknown>, name = 'agent.yaml'): string {
  return tmpFile(JSON.stringify(definition), name);
}

describe('rumo agents', () => {
  it('[cli-041] adds an agent from a file, naming it from the file, and lists, shows and exports it', async () => {
    const { cli } = await rig();
    const file = agentFile(REVIEWER, 'reviewer.json');
    expect(await cli.run('agents', 'add', '--yes', file)).toBe(0);
    expect(configOf(cli).agents).toEqual({ reviewer: REVIEWER });

    cli.reset();
    expect(await cli.run('agents')).toBe(0);
    expect(cli.stdout()).toBe('reviewer  Reviews a change\n');
    cli.reset();
    expect(await cli.run('agents', 'show', 'reviewer')).toBe(0);
    expect(cli.stdout()).toContain('tools: Read, Grep');
    cli.reset();
    expect(await cli.run('agents', 'export', 'reviewer')).toBe(0);
    expect(parse(cli.stdout())).toEqual({ name: 'reviewer', ...REVIEWER });
    cli.reset();
    expect(await cli.run('agents', 'export', 'reviewer', '--json')).toBe(0);
    expect(JSON.parse(cli.stdout())).toEqual({ name: 'reviewer', ...REVIEWER });
    cli.reset();
    expect(await cli.run('agents', 'list', '--json')).toBe(0);
    expect(JSON.parse(cli.stdout())).toEqual([{ name: 'reviewer', ...REVIEWER }]);
    expect(await cli.run('agents', 'show', 'reviewer', '--json', '--yaml')).toBe(2);
  });

  it('[cli-041] adds from stdin, from an example and from an https URL pinned by sha256', async () => {
    const stdin = await rig({ stdin: JSON.stringify({ name: 'piped', ...REVIEWER }) });
    expect(await stdin.cli.run('agents', 'add', '--yes', '-')).toBe(0);
    expect(Object.keys(configOf(stdin.cli).agents as object)).toEqual(['piped']);

    const example = await rig();
    expect(await example.cli.run('agents', 'add', '--yes', 'example:researcher')).toBe(0);
    expect(configOf(example.cli).agents).toMatchObject({
      researcher: { source: 'example:researcher' },
    });
    expect(await example.cli.run('agents', 'add', '--yes', 'example:nope')).toBe(2);

    const text = JSON.stringify(REVIEWER);
    const { createHash } = await import('node:crypto');
    const digest = createHash('sha256').update(text).digest('hex');
    const seen: string[] = [];
    const remote = await rig({
      fetch: ((url: URL) => {
        seen.push(String(url));
        return Promise.resolve(new Response(text));
      }) as unknown as typeof fetch,
    });
    expect(
      await remote.cli.run(
        'agents',
        'add',
        '--yes',
        `https://example.test/agents/lint.json#sha256=${digest}`,
      ),
    ).toBe(0);
    expect(seen).toEqual(['https://example.test/agents/lint.json']);
    expect(configOf(remote.cli).agents).toMatchObject({
      lint: { source: 'https://example.test/agents/lint.json' },
    });
    expect(
      await remote.cli.run(
        'agents',
        'add',
        '--yes',
        '--replace',
        `https://example.test/agents/lint.json#sha256=${'0'.repeat(64)}`,
      ),
    ).toBe(2);
    expect(remote.cli.stderr()).toContain('does not match the pinned sha256');
    expect(await remote.cli.run('agents', 'add', '--yes', 'http://example.test/a.json')).toBe(2);
  });

  it('[cli-041] refuses a cross-host redirect, an oversized document and a failing server', async () => {
    const redirect = await rig({
      fetch: (() =>
        Promise.resolve(
          new Response(null, { status: 302, headers: { location: 'https://other.test/a.json' } }),
        )) as unknown as typeof fetch,
    });
    expect(await redirect.cli.run('agents', 'add', '--yes', 'https://example.test/a.json')).toBe(2);
    expect(redirect.cli.stderr()).toContain('same-host');

    const big = await rig({
      fetch: (() =>
        Promise.resolve(new Response('x'.repeat(300 * 1024)))) as unknown as typeof fetch,
    });
    expect(await big.cli.run('agents', 'add', '--yes', 'https://example.test/a.json')).toBe(2);
    expect(big.cli.stderr()).toContain('larger than');

    const down = await rig({
      fetch: (() =>
        Promise.resolve(new Response('no', { status: 500 }))) as unknown as typeof fetch,
    });
    expect(await down.cli.run('agents', 'add', '--yes', 'https://example.test/a.json')).toBe(2);
  });

  it('[cli-041] validates the definition and refuses an existing name without --replace', async () => {
    const { cli } = await rig();
    expect(
      await cli.run('agents', 'add', '--yes', agentFile({ ...REVIEWER, prompt: 5 }, 'x.json')),
    ).toBe(2);
    expect(
      await cli.run('agents', 'add', '--yes', agentFile({ ...REVIEWER, tols: [] }, 'x.json')),
    ).toBe(2);
    expect(cli.stderr()).toContain('did you mean "tools"?');
    expect(
      await cli.run(
        'agents',
        'add',
        '--yes',
        agentFile({ ...REVIEWER, tools: ['Bash(git)'] }, 'x.json'),
      ),
    ).toBe(2);
    expect(await cli.run('agents', 'add', '--yes', agentFile(REVIEWER, 'Bad Name.json'))).toBe(2);
    expect(
      await cli.run(
        'agents',
        'add',
        '--yes',
        '--name',
        'good',
        agentFile(REVIEWER, 'Bad Name.json'),
      ),
    ).toBe(0);
    expect(await cli.run('agents', 'add', '--yes', '--name', 'good', agentFile(REVIEWER))).toBe(2);
    expect(cli.stderr()).toContain('--replace');
    expect(
      await cli.run(
        'agents',
        'add',
        '--yes',
        '--replace',
        '--name',
        'good',
        agentFile({ ...REVIEWER, description: 'new' }),
      ),
    ).toBe(0);
    expect(configOf(cli).agents).toMatchObject({ good: { description: 'new' } });
  });

  it('[cli-041] asks at a terminal and cannot ask for stdin, add, push and rm are refused for restricted and in-run agents', async () => {
    const yes = await rig({ tty: true, answers: ['y'] });
    expect(await yes.cli.run('agents', 'add', agentFile(REVIEWER, 'asked.json'))).toBe(0);
    expect(yes.cli.stderr()).toContain('Use this agent definition');

    const no = await rig({ tty: true, answers: ['n'] });
    expect(await no.cli.run('agents', 'add', agentFile(REVIEWER, 'asked.json'))).toBe(2);
    expect(configOf(no.cli).agents).toBeUndefined();

    const nobody = await rig({ stdin: JSON.stringify({ name: 'piped', ...REVIEWER }) });
    expect(await nobody.cli.run('agents', 'add', '-')).toBe(2);
    expect(nobody.cli.stderr()).toContain('--yes');

    const restricted = await rig({ env: { RUMO_RESTRICTED: '1' } });
    expect(await restricted.cli.run('agents', 'add', '--yes', agentFile(REVIEWER))).toBe(2);
    expect(await restricted.cli.run('agents')).toBe(0);
    const inRun = await rig({ env: { RUMO_TASK: 'taskAAAA' } });
    expect(await inRun.cli.run('agents', 'rm', 'x')).toBe(2);
  });

  it('[cli-041] rm removes the local agent, and --board removes it from the shared document', async () => {
    const { stub, cli } = await rig();
    await cli.run('agents', 'add', '--yes', agentFile(REVIEWER, 'reviewer.json'));
    expect(await cli.run('agents', 'rm', 'reviewer')).toBe(0);
    expect(configOf(cli).agents).toBeUndefined();
    expect(await cli.run('agents', 'rm', 'reviewer')).toBe(2);

    await cli.run('agents', 'add', '--yes', agentFile(REVIEWER, 'reviewer.json'));
    expect(await cli.run('agents', 'push', 'reviewer', '--yes')).toBe(0);
    expect(await cli.run('agents', 'rm', '--board', 'reviewer')).toBe(0);
    const last = stub.published.agents.at(-1);
    expect(JSON.parse(await stub.open(bindings.sharedAgents(2), last?.document ?? ''))).toEqual({
      agents: {},
    });
    expect(await cli.run('agents', 'rm', '--board', 'reviewer')).toBe(2);
    expect(configOf(cli).agents).toMatchObject({ reviewer: REVIEWER });
  });

  it('[cli-041] push shares a local agent, a file or an example through a versioned sealed document', async () => {
    const { stub, cli } = await rig();
    await cli.run('agents', 'add', '--yes', agentFile(REVIEWER, 'reviewer.json'));
    expect(await cli.run('agents', 'push', '--yes', 'reviewer')).toBe(0);
    expect(await cli.run('agents', 'push', '--yes', 'example:researcher')).toBe(0);
    expect(stub.published.agents.map((entry) => entry.version)).toEqual([1, 2]);
    const document = JSON.parse(
      await stub.open(bindings.sharedAgents(2), stub.published.agents[1]?.document ?? ''),
    ) as { agents: Record<string, unknown> };
    expect(Object.keys(document.agents).sort()).toEqual(['researcher', 'reviewer']);
    expect(
      await cli.run('agents', 'push', '--yes', '--name', 'from-file', agentFile(REVIEWER)),
    ).toBe(0);
    expect(stub.published.agents).toHaveLength(3);
  });

  it('[cli-042] a newer board document replaces a same-named local agent and keeps the old one aside', async () => {
    const { stub, cli } = await rig();
    await cli.run('agents', 'add', '--yes', agentFile(REVIEWER, 'reviewer.json'));
    await cli.run(
      'agents',
      'add',
      '--yes',
      agentFile({ ...REVIEWER, description: 'mine only' }, 'mine.json'),
    );
    const shared = { reviewer: { ...REVIEWER, description: 'the board version' }, fresh: REVIEWER };
    stub.setBoardAgents(
      3,
      await stub.seal(bindings.sharedAgents(3), JSON.stringify({ agents: shared })),
    );
    cli.reset();
    expect(await cli.run('agents')).toBe(0);
    expect(cli.stderr()).toContain('replaced local agent reviewer');
    expect(cli.stderr()).toContain('added board agent fresh');
    expect(configOf(cli).agents).toMatchObject({
      reviewer: { description: 'the board version' },
      fresh: REVIEWER,
      mine: { description: 'mine only' },
    });
    const aside = path.join(cli.test.path('config'), 'agents.aside');
    const [kept] = readdirSync(aside);
    expect(kept).toMatch(/^reviewer-\d{8}T\d{6}\.yaml$/);
    expect(parse(readFileSync(path.join(aside, kept ?? ''), 'utf8'))).toEqual(REVIEWER);

    cli.reset();
    expect(await cli.run('agents')).toBe(0);
    expect(cli.stderr()).toBe('');
    expect(readdirSync(aside)).toHaveLength(1);
  });

  it('[cli-042] a board document this machine cannot decrypt, or with a bad agent, changes nothing', async () => {
    const { stub, cli } = await rig();
    stub.setBoardAgents(2, await stub.seal(bindings.sharedAgents(7), '{}'));
    expect(await cli.run('agents')).toBe(0);
    expect(cli.stderr()).toContain('cannot be decrypted');

    stub.setBoardAgents(
      4,
      await stub.seal(
        bindings.sharedAgents(4),
        JSON.stringify({ agents: { broken: { description: 'x' }, ok: REVIEWER } }),
      ),
    );
    cli.reset();
    await cli.run('agents');
    expect(cli.stderr()).toContain('board agent broken not applied');
    expect(Object.keys(configOf(cli).agents as object)).toEqual(['ok']);
  });
});

describe('rumo plugins', () => {
  const real = { exec: execFileText };

  it('[cli-045] installs a marketplace from git, pinned to the commit, and lists its feeds', async () => {
    const repo = pluginRepo('{"items":[]}');
    const { cli } = await rig(real);
    expect(await cli.run('plugins', 'install', repo)).toBe(0);
    const commit = git(repo, 'rev-parse', 'HEAD');
    expect(cli.stdout()).toContain(
      `installed marketplace acme at ${commit.slice(0, 12)}: acme:prs`,
    );
    cli.reset();
    expect(await cli.run('plugins')).toBe(0);
    expect(cli.stdout()).toContain(`acme  ${commit.slice(0, 12)}`);
    expect(cli.stdout()).toContain('acme:prs  open PRs');
    const registry = JSON.parse(
      readFileSync(path.join(cli.test.path('state'), 'plugins', 'installed.json'), 'utf8'),
    ) as { marketplaces: Record<string, { commit: string }> };
    expect(registry.marketplaces.acme?.commit).toBe(commit);
    expect(await cli.run('plugins', 'install', repo)).toBe(2);
  });

  it('[cli-045] update accepts new code only after the manifest and programs check out', async () => {
    const repo = pluginRepo('{"items":[]}');
    const { cli } = await rig(real);
    await cli.run('plugins', 'install', repo);
    cli.reset();
    expect(await cli.run('plugins', 'update', 'acme')).toBe(0);
    expect(cli.stdout()).toContain('already at');

    writeFileSync(path.join(repo, 'bin', 'extra'), '#!/bin/sh\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '--quiet', '-m', 'not executable');
    const manifest = JSON.parse(
      readFileSync(path.join(repo, '.rumo', 'marketplace.json'), 'utf8'),
    ) as {
      feeds: Record<string, unknown>;
    };
    manifest.feeds.extra = { program: 'bin/extra' };
    writeFileSync(
      path.join(repo, '.rumo', 'marketplace.json'),
      JSON.stringify({ protocol: 1, name: 'acme', feeds: manifest.feeds }),
    );
    git(repo, 'commit', '--quiet', '-am', 'declare it');
    cli.reset();
    expect(await cli.run('plugins', 'update', 'acme')).toBe(1);
    expect(cli.stderr()).toContain('not executable');

    chmodSync(path.join(repo, 'bin', 'extra'), 0o755);
    git(repo, 'update-index', '--chmod=+x', 'bin/extra');
    git(repo, 'commit', '--quiet', '-m', 'executable');
    cli.reset();
    expect(await cli.run('plugins', 'update', 'acme')).toBe(0);
    expect(cli.stdout()).toContain('updated marketplace acme');
  });

  it('[cli-045] refuses an install URL that could be an option, a local path that is missing, and a marketplace with a bad manifest', async () => {
    const { cli } = await rig(real);
    for (const url of ['--upload-pack=touch /tmp/x', 'ftp://host/repo', '/does/not/exist', 'a b']) {
      expect(await cli.run('plugins', 'install', url), url).toBe(2);
    }
    const repo = tmpDir();
    git(repo, 'init', '--quiet', '-b', 'main');
    writeFileSync(path.join(repo, 'README'), 'no manifest');
    git(repo, 'add', '-A');
    git(repo, 'commit', '--quiet', '-m', 'first');
    expect(await cli.run('plugins', 'install', repo)).toBe(1);
    expect(cli.stderr()).toContain('marketplace.json');
    expect(existsSync(path.join(cli.test.path('state'), 'plugins', 'marketplaces', 'acme'))).toBe(
      false,
    );
  });

  it('[cli-045] remove deletes the checkout, and is refused while a feed uses the marketplace', async () => {
    const repo = pluginRepo('{"items":[]}');
    const work = tmpDir();
    const { cli } = await rig({ ...real, cwd: work });
    await cli.run('plugins', 'install', repo);
    await cli.run('dirs', 'add', '--no-repo');
    const feed = tmpFile(
      JSON.stringify({ integration: 'acme:prs', action: 'list', every: '10m', dir: work }),
    );
    expect(await cli.run('feeds', 'add', 'prs', feed)).toBe(0);
    expect(await cli.run('plugins', 'remove', 'acme')).toBe(2);
    expect(cli.stderr()).toContain('feed(s) prs use acme');
    await cli.run('feeds', 'rm', 'prs');
    expect(await cli.run('plugins', 'remove', 'acme')).toBe(0);
    expect(existsSync(path.join(cli.test.path('state'), 'plugins', 'marketplaces', 'acme'))).toBe(
      false,
    );
    expect(await cli.run('plugins', 'remove', 'acme')).toBe(2);
  });

  it('[cli-045] a feed never runs code that drifted from the pin or from the checkout', async () => {
    const repo = pluginRepo('{"items":[{"key":"a","prompt":"do a"}]}');
    const work = tmpDir();
    const { stub, cli } = await rig({ ...real, cwd: work });
    await cli.run('plugins', 'install', repo);
    await cli.run('dirs', 'add', '--no-repo');
    const feed = tmpFile(
      JSON.stringify({ integration: 'acme:prs', action: 'list', every: '10m', dir: work }),
    );
    await cli.run('feeds', 'add', 'prs', feed);
    const checkout = path.join(cli.test.path('state'), 'plugins', 'marketplaces', 'acme');
    writeFileSync(path.join(checkout, 'bin', 'prs'), '#!/bin/sh\necho tampered\n');
    cli.reset();
    expect(await cli.run('feeds', 'run', 'prs')).toBe(1);
    expect(cli.stdout()).toContain('has local changes');
    expect(stub.tasks.size).toBe(0);
  });
});

describe('rumo feeds', () => {
  const real = { exec: execFileText };

  async function started(items: string) {
    const repo = pluginRepo(items);
    const work = tmpDir();
    const made = await rig({ ...real, cwd: work });
    await made.cli.run('plugins', 'install', repo);
    await made.cli.run('dirs', 'add', '--no-repo');
    const definition = {
      integration: 'acme:prs',
      action: 'list',
      every: '10m',
      dir: work,
      lane: 'ci',
    };
    expect(await made.cli.run('feeds', 'add', 'prs', tmpFile(JSON.stringify(definition)))).toBe(0);
    made.cli.reset();
    return { ...made, work, repo };
  }

  const items = (...list: { key: string; prompt: string; version?: string }[]) =>
    JSON.stringify({ items: list });

  it('[cli-043] each item becomes a keyed Todo task bound to the feed directory', async () => {
    const { stub, cli, work } = await started(
      items(
        { key: 'pr-1', prompt: 'review PR 1', version: 'aaa' },
        { key: 'pr-2', prompt: 'review PR 2' },
      ),
    );
    expect(await cli.run('feeds', 'run', 'prs')).toBe(0);
    expect(cli.stdout()).toContain('2 listed, 2 created, 0 requeued, 0 closed');
    const tasks = [...stub.tasks.values()];
    expect(tasks).toHaveLength(2);
    const [directory] = [...stub.directories.values()];
    for (const task of tasks) {
      expect(task).toMatchObject({
        status: 'todo',
        createdBy: 'user',
        requestedLane: 'ci',
        directoryId: directory?.id,
      });
    }
    expect(
      await stub.open(bindings.title({ task: tasks[0]?.id ?? '' }), tasks[0]?.title ?? ''),
    ).toBe('review PR 1');
    expect(work).toBeTruthy();
    cli.reset();
    expect(await cli.run('feeds', 'run', 'prs')).toBe(0);
    expect(cli.stdout()).toContain('2 listed, 0 created');
    expect(stub.tasks.size).toBe(2);
  });

  it('[cli-043] a changed item requeues its task and a vanished item closes a fresh one', async () => {
    const { stub, cli, work } = await started(
      items(
        { key: 'pr-1', prompt: 'review PR 1', version: 'v1' },
        { key: 'pr-2', prompt: 'review PR 2' },
      ),
    );
    await cli.run('feeds', 'run', 'prs');
    const [first, second] = [...stub.tasks.values()];
    stub.patch(first?.id ?? '', { status: 'needs-me' });
    writeFileSync(
      path.join(work, 'items.json'),
      items({ key: 'pr-1', prompt: 'review PR 1', version: 'v2' }),
    );
    cli.reset();
    expect(await cli.run('feeds', 'run', 'prs')).toBe(0);
    expect(cli.stdout()).toContain('1 listed, 0 created, 1 requeued, 1 closed');
    expect(stub.tasks.get(first?.id ?? '')).toMatchObject({ status: 'todo', next: 'fresh' });
    expect(stub.tasks.get(second?.id ?? '')?.closed).toBe(true);
  });

  it('[cli-043] a vanished item whose task already ran stays open', async () => {
    const { stub, cli, work } = await started(items({ key: 'pr-1', prompt: 'review PR 1' }));
    await cli.run('feeds', 'run', 'prs');
    const [task] = [...stub.tasks.values()];
    stub.patch(task?.id ?? '', { status: 'running' });
    writeFileSync(path.join(work, 'items.json'), items());
    cli.reset();
    expect(await cli.run('feeds', 'run', 'prs')).toBe(0);
    expect(cli.stdout()).toContain('0 listed, 0 created, 0 requeued, 0 closed');
    expect(stub.tasks.get(task?.id ?? '')?.closed).toBe(false);
  });

  it('[cli-043] a failing integration exits 1 and records the failure', async () => {
    const { cli, work } = await started('not json');
    writeFileSync(path.join(work, 'items.json'), 'not json');
    expect(await cli.run('feeds', 'run', 'prs')).toBe(1);
    expect(cli.stdout()).toContain('failed');
    cli.reset();
    await cli.run('feeds');
    expect(cli.stdout()).toMatch(/failed .*no JSON/);
  });

  it('[cli-043] lists the feeds, and pauses, resumes and removes one, publishing the document to the board', async () => {
    const { stub, cli } = await started(items());
    expect(await cli.run('feeds')).toBe(0);
    expect(cli.stdout()).toMatch(/prs {2}active {2}acme:prs · list {2}every 10m .* lane ci/);
    expect(cli.stdout()).toContain('never run');
    expect(await cli.run('feeds', 'pause', 'prs')).toBe(0);
    cli.reset();
    await cli.run('feeds');
    expect(cli.stdout()).toContain('paused');
    expect(await cli.run('feeds', 'resume', 'prs')).toBe(0);
    const published = stub.published.feeds.at(-1) ?? '';
    const document = JSON.parse(
      await stub.open(bindings.machineDocument('machine.feeds', 'test-machine'), published),
    ) as {
      feeds: { name: string; paused: boolean }[];
    };
    expect(document.feeds).toMatchObject([{ name: 'prs', paused: false }]);
    expect(await cli.run('feeds', 'rm', 'prs')).toBe(0);
    expect(configOf(cli).feeds).toBeUndefined();
    expect(await cli.run('feeds', 'run', 'prs')).toBe(2);
  });

  it('[cli-043] add validates the entry, the directory and the integration', async () => {
    const { cli, work } = await started(items());
    const entry = (extra: Record<string, unknown>) =>
      tmpFile(
        JSON.stringify({
          integration: 'acme:prs',
          action: 'list',
          every: '10m',
          dir: work,
          ...extra,
        }),
      );
    expect(await cli.run('feeds', 'add', 'Bad_Name', entry({}))).toBe(2);
    expect(await cli.run('feeds', 'add', 'x', entry({ every: '30s' }))).toBe(2);
    expect(await cli.run('feeds', 'add', 'x', entry({ every: '1m' }))).toBe(0);
    expect(await cli.run('feeds', 'add', 'x', entry({ extra: 1 }))).toBe(2);
    expect(await cli.run('feeds', 'add', 'x', entry({ dir: tmpDir() }))).toBe(2);
    expect(cli.stderr()).toContain('not a listed directory');
    expect(await cli.run('feeds', 'add', 'x', entry({ integration: 'ghost:prs' }))).toBe(2);
    expect(await cli.run('feeds', 'add', 'x', entry({ integration: 'acme:ghost' }))).toBe(2);
    expect(await cli.run('feeds', 'add', 'x', entry({ agent: 'Not An Agent' }))).toBe(2);
  });

  it('[cli-044] at most 30 feeds per machine', async () => {
    const { cli, work } = await started(items());
    const definition = { integration: 'acme:prs', action: 'list', every: '10m', dir: work };
    const entry = tmpFile(JSON.stringify(definition));
    const config = configOf(cli);
    const seeded = Object.fromEntries(
      Array.from({ length: 28 }, (_, index) => [`feed-${index + 1}`, definition]),
    );
    config.feeds = { ...(config.feeds as object), ...seeded };
    writeFileSync(cli.test.path('config', 'config.yaml'), stringify(config));
    expect(await cli.run('feeds', 'add', 'feed-29', entry)).toBe(0);
    cli.reset();
    expect(await cli.run('feeds', 'add', 'one-too-many', entry)).toBe(2);
    expect(cli.stderr()).toContain('at most 30 feeds');
    expect(await cli.run('feeds', 'add', 'feed-3', entry)).toBe(0);
    expect(Object.keys(configOf(cli).feeds as object)).toHaveLength(30);
  });

  it('[cli-043] changes are refused inside a run and list stays available', async () => {
    const { cli } = await rig({ env: { RUMO_TASK: 'taskAAAA' } });
    expect(await cli.run('feeds', 'run', 'prs')).toBe(2);
    expect(await cli.run('feeds')).toBe(0);
    expect(await cli.run('plugins', 'install', '/tmp')).toBe(2);
    expect(await cli.run('plugins')).toBe(0);
  });
});
