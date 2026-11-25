import type { BrowserContext, Page } from '@playwright/test';

export interface VirtualAuthenticator {
  readonly authenticatorId: string;
  credentials(): Promise<{ credentialId: string; isResidentCredential: boolean }[]>;
  setUserVerified(verified: boolean): Promise<void>;
  remove(): Promise<void>;
}

export async function withVirtualAuthenticator(page: Page): Promise<VirtualAuthenticator> {
  const session = await page.context().newCDPSession(page);
  await session.send('WebAuthn.enable', { enableUI: false });
  const added = await session.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  const { authenticatorId } = added;
  return {
    authenticatorId,
    credentials: async () =>
      (await session.send('WebAuthn.getCredentials', { authenticatorId })).credentials,
    setUserVerified: async (verified) => {
      await session.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: verified });
    },
    remove: async () => {
      await session.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
      await session.send('WebAuthn.disable');
    },
  };
}

export const APPROVAL_PATH = '/approve';
export const UNLOCK_NAMES = {
  passphrase: /passphrase/i,
  unlock: /^unlock$/i,
  approve: /^approve$/i,
} as const;

export async function approveHandoff(
  otherContext: BrowserContext,
  serverUrl: string,
  code: string,
  path: string = APPROVAL_PATH,
): Promise<Page> {
  const page = await otherContext.newPage();
  const target = new URL(path, serverUrl);
  target.searchParams.set('code', code);
  await page.goto(target.toString());
  await page.getByRole('button', { name: UNLOCK_NAMES.approve }).click();
  return page;
}

export async function unlockInPage(page: Page, passphrase: string): Promise<void> {
  await page.getByLabel(UNLOCK_NAMES.passphrase).fill(passphrase);
  await page.getByRole('button', { name: UNLOCK_NAMES.unlock }).click();
}

export interface PersistentContextOptions {
  readonly browser?: 'chromium' | 'webkit';
  readonly use?: Parameters<typeof import('@playwright/test').chromium.launchPersistentContext>[1];
}

export async function persistentContext(
  dir: string,
  options: PersistentContextOptions = {},
): Promise<BrowserContext> {
  const playwright = await import('@playwright/test');
  const type = options.browser === 'webkit' ? playwright.webkit : playwright.chromium;
  return type.launchPersistentContext(dir, options.use);
}
