import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { assembleFrontend } from '../scripts/assemble.js';
import { createBridge } from '../src/bridge/bridge.js';
import { bytes, installInternals, readAll } from './fake-native.js';

const shell = (...parts: string[]): string =>
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src-tauri', ...parts);

const json = async (...parts: string[]): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(shell(...parts), 'utf8')) as Record<string, unknown>;

async function filesUnder(root: string, relative = ''): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) found.push(...(await filesUnder(root, next)));
    else found.push(next);
  }
  return found.sort();
}

const WEB_FILES: Record<string, string> = {
  'index.html':
    '<!doctype html><title>web</title><script type="module" src="/assets/app.js"></script>',
  'assets/app.js': 'console.log("web");\n',
  'assets/app.css': 'body{color:red}\n',
  'version.json': '{"version":"0.0.0","contract":1}\n',
};

const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function temporary(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'client-app-'));
  scratch.push(dir);
  return dir;
}

const BRIDGE_MEMBERS = [
  'addServer',
  'handoffFinish',
  'kind',
  'listServers',
  'notify',
  'openLink',
  'pair',
  'removeServer',
  'renameServer',
  'reportTab',
  'serverFetch',
  'signOut',
];

describe('bundling', () => {
  it('[client-app-001] the assembled frontend holds the web build unchanged plus the native pages', async () => {
    const root = await temporary();
    const webDist = path.join(root, 'web');
    const outDir = path.join(root, 'out');
    for (const [name, contents] of Object.entries(WEB_FILES)) {
      await mkdir(path.dirname(path.join(webDist, name)), { recursive: true });
      await writeFile(path.join(webDist, name), contents);
    }
    await assembleFrontend({ webDist, outDir });

    for (const [name, contents] of Object.entries(WEB_FILES)) {
      expect(await readFile(path.join(outDir, name), 'utf8')).toBe(contents);
    }
    const added = (await filesUnder(outDir)).filter((name) => !(name in WEB_FILES));
    expect(added).toContain(path.join('_native', 'list.html'));
    expect(added.every((name) => name.startsWith('_native'))).toBe(true);
    const page = await readFile(path.join(outDir, '_native', 'list.html'), 'utf8');
    expect(page).not.toMatch(/(?:src|href)="https?:/);
  });

  it('[client-app-001] assembling fails when the web build is missing', async () => {
    const root = await temporary();
    await expect(
      assembleFrontend({ webDist: path.join(root, 'nothing'), outDir: path.join(root, 'out') }),
    ).rejects.toThrow(/version\.json is missing/);
  });

  it('[client-app-001] the app config loads no remote page and its CSP connects only to IPC', async () => {
    const config = await json('tauri.conf.json');
    const app = config.app as {
      windows: unknown[];
      withGlobalTauri: boolean;
      security: { csp: string };
    };
    const build = config.build as Record<string, string>;
    expect(app.windows).toEqual([]);
    expect(app.withGlobalTauri).toBe(false);
    expect(build.devUrl).toBeUndefined();
    expect(build.frontendDist).toBe('../dist');

    const directives = Object.fromEntries(
      app.security.csp.split(';').map((directive) => {
        const [name = '', ...sources] = directive.trim().split(/\s+/);
        return [name, sources];
      }),
    ) as Record<string, string[]>;
    expect(directives['connect-src']).toEqual(['ipc:', 'http://ipc.localhost']);
    for (const [name, sources] of Object.entries(directives)) {
      expect(
        sources.filter((source) => /^https?:\/\//.test(source) && name !== 'connect-src'),
        name,
      ).toEqual([]);
    }

    const sources = await Promise.all(
      (await readdir(shell('src'), { recursive: true }))
        .filter((name) => name.endsWith('.rs'))
        .map((name) => readFile(shell('src', name), 'utf8')),
    );
    expect(sources.join('\n')).not.toContain('WebviewUrl::External');
  });
});

describe('bridge', () => {
  it('[client-app-002] the bridge exposes exactly the AgentBoardBridge members and cannot be replaced', async () => {
    installInternals(() => undefined);
    await import('../src/bridge/install.js');
    const bridge = window.agentBoardBridge;
    expect(bridge).toBeDefined();
    expect(Object.keys(bridge ?? {}).sort()).toEqual(BRIDGE_MEMBERS);
    expect(bridge?.kind).toBe('client-app');
    expect(Object.isFrozen(bridge)).toBe(true);

    expect(() => {
      Object.defineProperty(window, 'agentBoardBridge', { value: {} });
    }).toThrow();
    expect(() => {
      (window as { agentBoardBridge?: unknown }).agentBoardBridge = {};
    }).toThrow();
    expect(Reflect.deleteProperty(window, 'agentBoardBridge')).toBe(false);
    expect(window.agentBoardBridge).toBe(bridge);
    expect(() => {
      (bridge as unknown as { serverFetch: unknown }).serverFetch = () => undefined;
    }).toThrow();
  });

  it('[client-app-002] every bridge member calls its own native command', async () => {
    const internals = installInternals((command) => {
      if (command === 'list_servers') return [];
      if (command === 'page_add_server') return null;
      if (command === 'page_remove_server') return true;
      return undefined;
    });
    const bridge = createBridge();
    await bridge.pair('s', 'code', 'label');
    await bridge.signOut('s');
    await bridge.notify({ serverId: 's', taskId: 't', title: 'x' });
    await bridge.openLink('https://example.test/');
    await bridge.reportTab({ path: '/', title: 'T' });
    await bridge.listServers();
    await bridge.addServer({ name: 'n', address: 'a' });
    await bridge.removeServer('s');
    await bridge.renameServer('s', 'n');
    expect(internals.invoke.mock.calls.map(([command]) => command)).toEqual([
      'pair',
      'sign_out',
      'notify',
      'open_link',
      'report_tab',
      'list_servers',
      'page_add_server',
      'page_remove_server',
      'rename_server',
    ]);
    expect(internals.invoke).toHaveBeenCalledWith('page_add_server', { name: 'n', address: 'a' });
  });

  it('[client-app-002] page webviews are granted only the bridge commands', async () => {
    const manifest = await readFile(shell('build.rs'), 'utf8');
    const declared = [...manifest.matchAll(/^\s+"([a-z_]+)",$/gm)].map((match) => match[1]);
    const permission = (command: string): string => `allow-${command.replaceAll('_', '-')}`;
    const page = await json('capabilities', 'page.json');
    const granted = page.permissions as string[];

    const bridgeCommands = [
      'server_fetch',
      'server_fetch_cancel',
      'handoff_finish',
      'pair',
      'sign_out',
      'notify',
      'open_link',
      'report_tab',
      'list_servers',
      'page_add_server',
      'page_remove_server',
      'rename_server',
    ];
    expect([...granted].sort()).toEqual(bridgeCommands.map(permission).sort());
    for (const command of bridgeCommands) expect(declared).toContain(command);
    expect(granted.some((name) => name.startsWith('core:'))).toBe(false);

    const own = ['list_add_server', 'list_remove_server', 'open_server', 'open_all_servers'];
    for (const command of own) expect(granted).not.toContain(permission(command));

    for (const name of ['page', 'list', 'tabbar']) {
      const capability = await json('capabilities', `${name}.json`);
      expect(capability.windows, name).toBeUndefined();
      expect(capability.remote, name).toBeUndefined();
    }
    expect(page.webviews).toEqual(['tab-*', 'all-servers']);
    const list = await json('capabilities', 'list.json');
    expect(list.webviews).toEqual(['list']);
    expect(list.permissions).not.toContain(permission('server_fetch'));
    const everyGranted = new Set<string>();
    for (const name of ['page', 'list', 'tabbar']) {
      const capability = await json('capabilities', `${name}.json`);
      for (const entry of capability.permissions as string[]) everyGranted.add(entry);
    }
    for (const command of declared) {
      expect(everyGranted.has(permission(command ?? '')), String(command)).toBe(true);
    }
  });
});

describe('streaming', () => {
  it('[client-app-049] serverFetch returns a stream that yields chunks in order, including those sent before the head', async () => {
    const internals = installInternals((command, args) => {
      if (command !== 'server_fetch') return undefined;
      const { channel } = args;
      internals.deliver(channel, 1, bytes(2, 2));
      internals.deliver(channel, 0, bytes(1));
      setTimeout(() => {
        internals.deliver(channel, 2, bytes(3, 3, 3));
        internals.deliver(channel, 3, { end: true });
      }, 5);
      return { fetchId: 9, status: 201, headers: { 'content-type': 'text/plain' } };
    });
    const response = await createBridge().serverFetch('s', 'GET', '/api/x', {}, null);

    expect(response.status).toBe(201);
    expect(response.headers).toEqual({ 'content-type': 'text/plain' });
    expect(await readAll(response.body as ReadableStream<Uint8Array>)).toEqual([
      [1],
      [2, 2],
      [3, 3, 3],
    ]);
    expect(internals.invoke).toHaveBeenCalledWith(
      'server_fetch',
      expect.objectContaining({
        serverId: 's',
        method: 'GET',
        path: '/api/x',
        headers: {},
        body: null,
      }),
    );
  });

  it('[client-app-049] a native error ends the stream with that error', async () => {
    const internals = installInternals((command, args) => {
      if (command !== 'server_fetch') return undefined;
      internals.deliver(args.channel, 0, bytes(7));
      internals.deliver(args.channel, 1, { error: 'request failed' });
      return { fetchId: 1, status: 200, headers: {} };
    });
    const response = await createBridge().serverFetch('s', 'GET', '/api/x', {}, null);
    await expect(readAll(response.body as ReadableStream<Uint8Array>)).rejects.toThrow(
      'request failed',
    );
  });

  it('[client-app-049] cancelling the stream cancels the native request', async () => {
    const internals = installInternals((command) =>
      command === 'server_fetch' ? { fetchId: 42, status: 200, headers: {} } : undefined,
    );
    const response = await createBridge().serverFetch('s', 'GET', '/api/x', {}, null);
    await (response.body as ReadableStream<Uint8Array>).cancel();
    expect(internals.invoke).toHaveBeenCalledWith('server_fetch_cancel', { fetchId: 42 });
    expect(internals.invoke.mock.calls.filter(([c]) => c === 'server_fetch_cancel')).toHaveLength(
      1,
    );
  });

  it('[client-app-049] a native refusal rejects the call', async () => {
    installInternals((command) => {
      if (command === 'server_fetch') throw 'refused path: dot segment';
      return undefined;
    });
    await expect(createBridge().serverFetch('s', 'GET', '/api/../x', {}, null)).rejects.toThrow(
      'refused path: dot segment',
    );
  });
});

describe('sign-in', () => {
  it('[client-app-037] handoffFinish rejects while the flow is pending', async () => {
    let status = 'pending';
    const internals = installInternals(() => ({ status }));
    const bridge = createBridge();
    await expect(bridge.handoffFinish('s', 'flow', 'verifier')).rejects.toThrow(/pending/);
    expect(internals.invoke).toHaveBeenCalledWith('handoff_finish', {
      serverId: 's',
      flow: 'flow',
      verifier: 'verifier',
    });
    status = 'signed-in';
    await expect(bridge.handoffFinish('s', 'flow', 'verifier')).resolves.toBeUndefined();
  });
});
