import type { BridgeServerEntry } from '@agent-board/web';
import type { BrowserContext, Page } from '@playwright/test';

export interface FakeAnswer {
  readonly status: number;
  readonly body: unknown;
}

export class FakeBoard {
  servers: BridgeServerEntry[];
  readonly calls: Array<{ name: string; args: unknown[] }> = [];
  readonly fetches: Array<{ serverId: string; method: string; path: string }> = [];
  pairFails = false;
  private routes = new Map<string, FakeAnswer>();

  constructor(servers: BridgeServerEntry[]) {
    this.servers = servers;
  }

  answer(method: string, path: string, answer: FakeAnswer): void {
    this.routes.set(`${method} ${path}`, answer);
  }

  called(name: string): unknown[][] {
    return this.calls.filter((call) => call.name === name).map((call) => call.args);
  }

  async install(context: BrowserContext): Promise<void> {
    await context.exposeFunction(
      '__fakeFetch',
      (serverId: string, method: string, path: string): FakeAnswer => {
        this.fetches.push({ serverId, method, path });
        const route = path.split('?')[0] ?? path;
        return (
          this.routes.get(`${method} ${route}`) ?? { status: 404, body: { error: 'not-found' } }
        );
      },
    );
    await context.exposeFunction('__fakeCall', (name: string, args: unknown[]): unknown => {
      this.calls.push({ name, args });
      if (name === 'pair' && this.pairFails) return { failed: 'refused' };
      if (name === 'listServers') return this.servers;
      if (name === 'addServer') {
        const input = args[0] as { name: string; address: string };
        const entry = {
          id: `00000000-0000-4000-8000-${String(this.servers.length + 1).padStart(12, '0')}`,
          name: input.name,
          url: new URL(input.address).href,
        };
        this.servers.push(entry);
        return entry;
      }
      if (name === 'removeServer') {
        this.servers = this.servers.filter((server) => server.id !== args[0]);
        return true;
      }
      return null;
    });
    await context.addInitScript(() => {
      const w = window as unknown as Record<string, (...args: unknown[]) => Promise<never>>;
      const call = async (name: string, ...args: unknown[]): Promise<unknown> => {
        const result = await w.__fakeCall(name, args);
        if (result !== null && typeof result === 'object' && 'failed' in result) {
          throw new Error(String(result.failed));
        }
        return result;
      };
      w.agentBoardBridge = {
        kind: 'mobile',
        serverFetch: async (serverId: string, method: string, path: string) => {
          const answer = await w.__fakeFetch(serverId, method, path);
          const bytes = new TextEncoder().encode(JSON.stringify(answer.body));
          return {
            status: answer.status,
            headers: { 'content-type': 'application/json' },
            body: new ReadableStream({
              start(controller) {
                controller.enqueue(bytes);
                controller.close();
              },
            }),
          };
        },
        handoffFinish: (...a: unknown[]) => call('handoffFinish', ...a),
        pair: (...a: unknown[]) => call('pair', ...a),
        signOut: (...a: unknown[]) => call('signOut', ...a),
        notify: (...a: unknown[]) => call('notify', ...a),
        openLink: (...a: unknown[]) => call('openLink', ...a),
        reportTab: async () => {},
        listServers: () => call('listServers'),
        addServer: (...a: unknown[]) => call('addServer', ...a),
        removeServer: (...a: unknown[]) => call('removeServer', ...a),
        renameServer: (...a: unknown[]) => call('renameServer', ...a),
      };
    });
  }
}

export const versionDocument = (overrides: Record<string, unknown> = {}): unknown => ({
  contract: 1,
  minClient: { cli: 1, web: 1 },
  features: [],
  server: { version: '1.0.0', commit: null },
  modules: { signIn: ['handoff'], requestSignature: false, scheduling: true, feeds: true },
  session: 'none',
  ...overrides,
});

export const SERVER: BridgeServerEntry = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Home',
  url: 'https://board.example.com/',
};

export const open = async (page: Page, path = '/'): Promise<void> => {
  await page.goto(path);
};
