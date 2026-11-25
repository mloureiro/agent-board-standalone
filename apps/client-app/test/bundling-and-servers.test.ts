import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import 'fake-indexeddb/auto';
import { ADDRESS_PROBLEM_MESSAGES, BLANK_NAME_MESSAGE, serverNamespace } from '@agent-board/web';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { assembleFrontend } from '../scripts/assemble.js';
import { createBridge } from '../src/bridge/bridge.js';
import { mountList } from '../src/native/list/page.js';
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
    expect(added).toContain(path.join('_native', 'tabbar.html'));
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

    for (const name of ['page', 'list', 'tabbar', 'tab']) {
      const capability = await json('capabilities', `${name}.json`);
      expect(capability.windows, name).toBeUndefined();
      expect(capability.remote, name).toBeUndefined();
    }
    expect(page.webviews).toEqual(['tab-*', 'all-servers']);
    const list = await json('capabilities', 'list.json');
    expect(list.webviews).toEqual(['list']);
    expect(list.permissions).not.toContain(permission('server_fetch'));
    const tab = await json('capabilities', 'tab.json');
    expect(tab.webviews).toEqual(['tab-*']);
    expect([...(tab.permissions as string[])].sort()).toEqual(
      ['tab_navigate', 'tab_title', 'tab_cycle', 'tab_focused'].map(permission).sort(),
    );
    const tabbar = await json('capabilities', 'tabbar.json');
    expect(tabbar.webviews).toEqual(['tabbar-*']);
    expect(tabbar.permissions).not.toContain(permission('server_fetch'));
    expect(tabbar.permissions).not.toContain(permission('tab_navigate'));
    expect(tabbar.permissions).not.toContain(permission('tab_focused'));
    const everyGranted = new Set<string>();
    for (const name of ['page', 'list', 'tabbar', 'tab']) {
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

const ALPHA = {
  id: '6ba7b810-9dad-41d1-80b4-00c04fd430c8',
  name: 'Alpha',
  url: 'https://a.example.test/',
};
const BETA = {
  id: '0b9e4c1a-7d2f-4a55-9c3e-5f1d8a7b6c42',
  name: 'Beta',
  url: 'https://b.example.test/',
};

type Entry = typeof ALPHA;

async function seedNamespace(id: string): Promise<void> {
  const namespace = serverNamespace(id);
  namespace.local.set('theme', 'dark');
  await namespace.secrets.put('token', 'x');
}

async function namespaceExists(id: string): Promise<boolean> {
  const databases = await indexedDB.databases();
  return (
    databases.some((database) => database.name === `agent-board:${id}`) ||
    localStorage.getItem(`ab:${id}:theme`) !== null
  );
}

async function clearStorage(): Promise<void> {
  localStorage.clear();
  for (const database of await indexedDB.databases()) {
    if (database.name !== undefined) indexedDB.deleteDatabase(database.name);
  }
}

const argsOf = (internals: ReturnType<typeof installInternals>, command: string): unknown[] =>
  internals.invoke.mock.calls.filter(([name]) => name === command).map(([, args]) => args);

function press(root: ParentNode, label: string, index = 0): void {
  const buttons = [...root.querySelectorAll('button')].filter(
    (button) => button.textContent === label,
  );
  const button = buttons[index];
  if (button === undefined) throw new Error(`no ${label} button`);
  button.click();
}

const alertsText = (root: ParentNode): string =>
  [...root.querySelectorAll('[role="alert"]')]
    .map((alert) => alert.textContent ?? '')
    .filter((text) => text !== '')
    .join('\n');

interface ListSetup {
  servers: Entry[];
  failures?: { name: string; text: string }[];
  handlers?: Record<string, (args: Record<string, unknown>) => unknown>;
  options?: Parameters<typeof mountList>[1];
}

async function mountPage(setup: ListSetup): Promise<{
  root: HTMLElement;
  internals: ReturnType<typeof installInternals>;
}> {
  const internals = installInternals((command, args) => {
    const custom = setup.handlers?.[command];
    if (custom) return custom(args);
    if (command === 'list_servers') return setup.servers;
    if (command === 'take_open_failures') return setup.failures ?? [];
    if (command === 'list_is_complete') return true;
    return undefined;
  });
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById('root') as HTMLElement;
  await mountList(root, setup.options);
  return { root, internals };
}

describe('server list page', () => {
  afterEach(clearStorage);

  it("[client-app-003] an open failure shows the error with the server's name", async () => {
    const { root, internals } = await mountPage({
      servers: [ALPHA],
      handlers: {
        open_server: () => {
          throw 'Alpha could not be opened: the server did not answer';
        },
      },
    });
    expect(root.querySelectorAll('li')).toHaveLength(1);
    press(root, 'Open');
    await vi.waitFor(() => {
      expect(alertsText(root)).toContain('Alpha could not be opened');
    });
    expect(argsOf(internals, 'open_server')).toEqual([{ serverId: ALPHA.id }]);
  });

  it('[client-app-007] removing from the list deletes the web namespace and offers Retry when it keeps failing', async () => {
    await seedNamespace(ALPHA.id);
    const listed = [ALPHA];
    const handlers = {
      list_servers: () => listed,
      list_remove_server: () => {
        listed.splice(0);
        return { purge: ALPHA.id };
      },
    };
    const { root } = await mountPage({ servers: listed, handlers });
    expect(await namespaceExists(ALPHA.id)).toBe(true);
    press(root, 'Remove');
    await vi.waitFor(async () => {
      expect(await namespaceExists(ALPHA.id)).toBe(false);
    });
    expect(root.querySelectorAll('li')).toHaveLength(0);
    expect(alertsText(root)).toBe('');

    listed.push(BETA);
    let failing = true;
    const destroyNamespace = vi.fn(async () => {
      if (failing) throw new Error('blocked');
    });
    const failed = await mountPage({
      servers: listed,
      handlers: {
        list_servers: () => listed,
        list_remove_server: () => ({ purge: BETA.id }),
      },
      options: { destroyNamespace, retryDelaysMs: [0, 0] },
    });
    press(failed.root, 'Remove');
    await vi.waitFor(() => {
      expect(alertsText(failed.root)).toContain("Couldn't delete the stored data of Beta.");
    });
    expect(destroyNamespace).toHaveBeenCalledTimes(3);
    expect(destroyNamespace).toHaveBeenCalledWith(BETA.id);

    failing = false;
    press(failed.root.querySelector('[role="alert"]') as HTMLElement, 'Retry');
    await vi.waitFor(() => {
      expect(destroyNamespace).toHaveBeenCalledTimes(4);
    });
    expect(alertsText(failed.root)).toBe('');
  });

  it('[client-app-008] the list page deletes namespaces of servers no longer listed', async () => {
    await seedNamespace(ALPHA.id);
    await seedNamespace(BETA.id);
    localStorage.setItem('ab:device:theme', 'dark');
    await mountPage({ servers: [ALPHA] });
    await vi.waitFor(async () => {
      expect(await namespaceExists(BETA.id)).toBe(false);
    });
    expect(await namespaceExists(ALPHA.id)).toBe(true);
    expect(localStorage.getItem('ab:device:theme')).toBe('dark');
  });

  it('[client-app-008] nothing is deleted when the list cannot be read', async () => {
    await seedNamespace(BETA.id);
    const { root } = await mountPage({
      servers: [],
      handlers: {
        list_servers: () => {
          throw 'the list could not be read';
        },
      },
    });
    expect(alertsText(root)).toContain('the list could not be read');
    expect(await namespaceExists(BETA.id)).toBe(true);
  });

  it('[client-app-008] nothing is deleted while the native list is incomplete', async () => {
    await seedNamespace(BETA.id);
    const { internals } = await mountPage({
      servers: [ALPHA],
      handlers: { list_is_complete: () => false },
    });
    expect(argsOf(internals, 'list_is_complete')).toHaveLength(1);
    expect(await namespaceExists(BETA.id)).toBe(true);
  });

  it('[client-app-015] failures recorded before the list loaded are shown', async () => {
    const { root, internals } = await mountPage({
      servers: [],
      failures: [
        { name: 'Alpha', text: 'Alpha could not be opened: the server did not answer' },
        {
          name: 'Agent Board',
          text: 'That link uses a handover version this app does not understand.',
        },
      ],
    });
    expect(alertsText(root)).toContain('Alpha could not be opened');
    expect(alertsText(root)).toContain('handover version');
    expect(argsOf(internals, 'take_open_failures')).toHaveLength(1);
  });

  it("[client-app-002] the add form uses the web client's texts for a blank name and an address problem", async () => {
    const { root, internals } = await mountPage({
      servers: [],
      handlers: {
        list_add_server: () => {
          throw 'address insecure';
        },
      },
    });
    const [name, address] = [...root.querySelectorAll('form input')] as HTMLInputElement[];
    const submit = (): void => {
      root.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    };

    submit();
    expect(alertsText(root)).toContain(BLANK_NAME_MESSAGE);
    expect(argsOf(internals, 'list_add_server')).toEqual([]);

    (name as HTMLInputElement).value = 'Remote';
    (address as HTMLInputElement).value = 'http://board.example.test';
    submit();
    await vi.waitFor(() => {
      expect(alertsText(root)).toContain(ADDRESS_PROBLEM_MESSAGES.insecure);
    });
    expect(alertsText(root)).not.toContain(BLANK_NAME_MESSAGE);
  });

  it('[client-app-005] renaming from the list sends the new name and refuses a blank one', async () => {
    const { root, internals } = await mountPage({ servers: [ALPHA] });
    press(root, 'Rename');
    const input = root.querySelector('form input') as HTMLInputElement;
    expect(input.value).toBe('Alpha');
    input.value = '  ';
    root.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(alertsText(root)).toContain(BLANK_NAME_MESSAGE);
    expect(argsOf(internals, 'rename_server')).toEqual([]);

    input.value = 'Gamma';
    root.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => {
      expect(argsOf(internals, 'rename_server')).toEqual([{ serverId: ALPHA.id, name: 'Gamma' }]);
    });
  });
});
