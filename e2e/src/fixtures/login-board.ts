import { startOidcFake, startSamlFake, type FakeHandle } from '../fakes/process.js';
import type { Board } from '../harness/board.js';
import { freePort } from '../harness/ports.js';
import { launchBoard, originOf, retryOnPortRace, type LaunchOptions } from './boards.js';

export const OIDC_CLIENT_ID = 'e2e-board';
export const OIDC_CLIENT_SECRET = 'e2e-board-secret';
export const OIDC_REDIRECT_PATH = '/auth/callback';
export const SAML_ACS_PATH = '/api/auth/saml/acs';

export interface LoginBoardOptions extends Omit<LaunchOptions, 'auth' | 'port' | 'onStop'> {
  readonly port?: number;
  readonly oidc?: boolean;
  readonly saml?: boolean;
  readonly passkeys?: boolean;
  readonly signupToken?: string;
  readonly allowedOrigins?: readonly string[];
  readonly requestSignature?: boolean;
}

export interface LoginBoard extends Board {
  readonly origin: string;
  readonly oidc: FakeHandle | null;
  readonly saml: FakeHandle | null;
  readonly redirectUri: string;
}

export function loginEnv(
  options: LoginBoardOptions,
  fakes: { oidc: FakeHandle | null; saml: FakeHandle | null },
  origin: string,
): Record<string, string> {
  const env: Record<string, string> = {
    PASSKEYS: options.passkeys === true ? 'on' : 'off',
  };
  if (fakes.oidc !== null) {
    env.OIDC_ISSUER = fakes.oidc.url;
    env.OIDC_CLIENT_ID = OIDC_CLIENT_ID;
    env.OIDC_CLIENT_SECRET = OIDC_CLIENT_SECRET;
  }
  if (fakes.saml !== null) {
    env.SAML_IDP_METADATA_URL = `${fakes.saml.url}/metadata`;
    env.SAML_SP_ENTITY_ID = `${origin}/saml/metadata`;
  }
  if (options.signupToken !== undefined) env.SIGNUP_TOKEN = options.signupToken;
  if (options.allowedOrigins !== undefined && options.allowedOrigins.length > 0) {
    env.ALLOWED_ORIGINS = options.allowedOrigins.join(',');
  }
  if (options.requestSignature !== undefined) {
    env.REQUEST_SIGNATURE = options.requestSignature ? 'on' : 'off';
  }
  return { ...env, ...options.env };
}

export function startLoginBoard(options: LoginBoardOptions = {}): Promise<LoginBoard> {
  return options.port === undefined
    ? retryOnPortRace(() => startLoginBoardOnce(options))
    : startLoginBoardOnce(options);
}

export interface LoginBoardPair {
  readonly a: LoginBoard;
  readonly b: LoginBoard;
  stop(): Promise<void>;
}

export function startLoginBoardPair(options: LoginBoardOptions = {}): Promise<LoginBoardPair> {
  return retryOnPortRace(async () => {
    const [portA, portB] = [await freePort(), await freePort()];
    const a = await startLoginBoardOnce({ ...options, port: portA });
    let b: LoginBoard;
    try {
      b = await startLoginBoardOnce({
        ...options,
        port: portB,
        allowedOrigins: [originOf('login', portA)],
      });
    } catch (error) {
      await a.stop();
      throw error;
    }
    return { a, b, stop: async () => void (await Promise.all([a.stop(), b.stop()])) };
  });
}

async function startLoginBoardOnce(options: LoginBoardOptions): Promise<LoginBoard> {
  const port = options.port ?? (await freePort());
  const origin = originOf('login', port);
  const redirectUri = `${origin}${OIDC_REDIRECT_PATH}`;
  const started: FakeHandle[] = [];
  const stopFakes = async (): Promise<void> => {
    await Promise.all(started.map((fake) => fake.stop().catch(() => undefined)));
  };
  try {
    const oidc =
      options.oidc === false
        ? null
        : await startOidcFake({
            clientId: OIDC_CLIENT_ID,
            clientSecret: OIDC_CLIENT_SECRET,
            redirectUri,
          });
    if (oidc !== null) started.push(oidc);
    const saml =
      options.saml === true
        ? await startSamlFake({
            spEntityId: `${origin}/saml/metadata`,
            acsUrl: `${origin}${SAML_ACS_PATH}`,
          })
        : null;
    if (saml !== null) started.push(saml);

    const board = await launchBoard({
      ...options,
      auth: 'login',
      port,
      env: loginEnv(options, { oidc, saml }, origin),
      onStop: stopFakes,
    });
    return { ...board, origin, oidc, saml, redirectUri };
  } catch (error) {
    await stopFakes();
    throw error;
  }
}
