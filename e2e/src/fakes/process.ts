import path from 'node:path';

import { E2E_ROOT } from '../harness/paths.ts';
import { freePort, LOOPBACK } from '../harness/ports.ts';
import { launch, terminate } from '../harness/run.ts';

export const OIDC_MAIN = path.join(E2E_ROOT, 'src', 'fakes', 'oidc', 'main.ts');
export const SAML_MAIN = path.join(E2E_ROOT, 'src', 'fakes', 'saml', 'main.ts');

export interface FakeHandle {
  readonly url: string;
  readonly port: number;
  readonly output: { stdout: string; stderr: string };
  failNext(description?: string): Promise<void>;
  stop(): Promise<void>;
}

export interface FakeOptions {
  readonly readyPath: string;
  readonly readyTimeoutMs?: number;
  readonly port?: number;
}

const POLL_MS = 50;

export async function startFake(
  script: string,
  args: readonly string[],
  options: FakeOptions,
): Promise<FakeHandle> {
  const port = options.port ?? (await freePort());
  const url = `http://${LOOPBACK}:${port}`;
  const running = launch(script, ['--port', String(port), ...args], {
    env: { PATH: process.env.PATH ?? '' },
  });
  const timeoutMs = options.readyTimeoutMs ?? 10_000;
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  void running.exited.then(
    () => (exited = true),
    () => (exited = true),
  );

  while (true) {
    if (exited) {
      throw new Error(
        `fake ${path.basename(path.dirname(script))} exited early\n${running.output.stderr}`,
      );
    }
    const response = await fetch(`${url}${options.readyPath}`).catch(() => null);
    if (response?.ok) break;
    if (Date.now() > deadline) {
      await terminate(running, 1_000);
      throw new Error(
        `fake did not answer ${options.readyPath} within ${timeoutMs} ms\n${running.output.stderr}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  return {
    url,
    port,
    output: running.output,
    failNext: async (description) => {
      const response = await fetch(`${url}/control/next-error`, {
        method: 'POST',
        body: JSON.stringify(description === undefined ? {} : { description }),
      });
      if (!response.ok) throw new Error(`control endpoint answered ${response.status}`);
    },
    stop: async () => {
      await terminate(running, 2_000);
    },
  };
}

export interface OidcFakeOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly port?: number;
}

export function startOidcFake(options: OidcFakeOptions): Promise<FakeHandle> {
  return startFake(
    OIDC_MAIN,
    [
      '--client-id',
      options.clientId,
      '--client-secret',
      options.clientSecret,
      '--redirect-uri',
      options.redirectUri,
    ],
    {
      readyPath: '/.well-known/openid-configuration',
      ...(options.port === undefined ? {} : { port: options.port }),
    },
  );
}

export interface SamlFakeOptions {
  readonly spEntityId: string;
  readonly acsUrl: string;
  readonly port?: number;
}

export function startSamlFake(options: SamlFakeOptions): Promise<FakeHandle> {
  return startFake(SAML_MAIN, ['--sp-entity-id', options.spEntityId, '--acs-url', options.acsUrl], {
    readyPath: '/metadata',
    ...(options.port === undefined ? {} : { port: options.port }),
  });
}
