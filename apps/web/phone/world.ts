import { FEATURES, getClientKeysRoute, meRoute } from '@agent-board/contract';
import { wrapSlot, type KeySetup } from '@agent-board/sealing';
import type { BrowserContext, Page, Route } from '@playwright/test';

import { OWNER_KEYS } from '../test/board-world.js';
import { json } from '../test/fake-board.js';
import { TEST_KDF } from '../test/key-board.js';
import { ProjectsWorld } from '../test/projects-world.js';
import { versionDocument } from '../test/versions.js';

export const PASSPHRASE = 'correct horse battery staple';
export const OWNER = 'owner';

export class PhoneWorld extends ProjectsWorld {
  constructor(session: 'none' | 'not-required' = 'not-required') {
    super({ session });
    this.features = [...FEATURES];
    this.eventsStatus = 503;
  }

  private async setup(): Promise<KeySetup> {
    const keys = await OWNER_KEYS;
    return {
      keyId: keys.keyId,
      slots: [
        await wrapSlot(
          new Uint8Array(32),
          { kind: 'passphrase', passphrase: PASSPHRASE },
          TEST_KDF,
        ),
      ],
    };
  }

  protected override async answer(
    method: string,
    path: string,
    body: Record<string, unknown> | null,
  ): Promise<Response> {
    if (method === 'GET' && path === '/api/version') {
      return json(
        200,
        versionDocument({
          features: this.features,
          session: this.session,
          modules: {
            signIn: this.session === 'none' ? ['handoff'] : [],
            requestSignature: false,
            scheduling: true,
            feeds: true,
          },
        }),
      );
    }
    if (method === 'GET' && path === meRoute.path) {
      return json(200, { username: OWNER, keyId: (await OWNER_KEYS).keyId });
    }
    if (method === 'GET' && path === getClientKeysRoute.path) {
      return json(200, { setup: await this.setup() });
    }
    return super.answer(method, path, body);
  }
}

export async function serve(context: BrowserContext, world: PhoneWorld): Promise<void> {
  await context.route(/\/(api\/|healthz)/, async (route: Route) => {
    const request = route.request();
    const body = request.postData();
    const answer = await world.fetch(request.url(), {
      method: request.method(),
      headers: request.headers(),
      ...(body === null ? {} : { body }),
    });
    await route.fulfill({
      status: answer.status,
      headers: Object.fromEntries(answer.headers.entries()),
      body: Buffer.from(await answer.arrayBuffer()),
    });
  });
}

export async function unlock(page: Page): Promise<void> {
  await page.getByLabel(/passphrase/i).fill(PASSPHRASE);
  await page.getByRole('button', { name: /^unlock$/i }).click();
}
