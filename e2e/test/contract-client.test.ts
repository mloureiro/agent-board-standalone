import path from 'node:path';

import { SIGNATURE_HEADERS, canonicalString } from '@rumo/contract';
import { contentDigest, importPublicKey, verify } from '@rumo/sealing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  anonymous,
  call,
  callOk,
  callRaw,
  clientToken,
  cookieSession,
  machineToken,
  type ServerRef,
} from '../src/client/contract-client.js';
import { CookieJar } from '../src/client/cookies.js';
import { isPing, openEvents, parseSseBlock, readSse } from '../src/client/events.js';
import { createRequestSigner } from '../src/client/signer.js';
import { startApi, type ApiHandle } from '../src/harness/api.js';
import { createPgliteDatabase } from '../src/harness/database.js';
import { E2E_ROOT } from '../src/harness/paths.js';
import { createTmp, type Tmp } from '../src/harness/tmp.js';

const fakeApi = path.join(E2E_ROOT, 'test', 'fixtures', 'fake-api.ts');
const originalBin = process.env.RUMO_API_BIN;

let api: ApiHandle;
let tmp: Tmp;
let server: ServerRef;

interface Last {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

async function last(): Promise<Last> {
  return (await (await fetch(`${server.url}/__last`)).json()) as Last;
}

beforeAll(async () => {
  process.env.RUMO_API_BIN = fakeApi;
  tmp = createTmp('contract-client');
  api = await startApi({ tmp, database: createPgliteDatabase(tmp), auth: 'no-login' });
  server = { url: api.url };
});

afterAll(async () => {
  await api.stop();
  tmp.remove();
  if (originalBin === undefined) delete process.env.RUMO_API_BIN;
  else process.env.RUMO_API_BIN = originalBin;
});

describe('contract client headers', () => {
  it('sends the contract header and a web client header for a cookie or no credential', async () => {
    await call(server, 'client.me', {}, anonymous);
    const seen = await last();
    expect(seen.headers['x-board-contract']).toBe('1');
    expect(seen.headers['x-board-client']).toMatch(/^web\/\d+\.\d+\.\d+/);
    expect(seen.headers.authorization).toBeUndefined();
  });

  it('sends a cli client header and the bearer for a machine token', async () => {
    const token = `abm_${'M'.repeat(43)}`;
    const result = await call(server, 'machine.version', {}, machineToken(token));
    expect(result.ok).toBe(true);
    const seen = await last();
    expect(seen.headers['x-board-client']).toMatch(/^cli\//);
    expect(seen.headers.authorization).toBe(`Bearer ${token}`);
  });

  it('sends a client token as a bearer under a web client header', async () => {
    const token = `abc_${'C'.repeat(43)}`;
    await call(server, 'client.me', {}, clientToken(token));
    const seen = await last();
    expect(seen.headers.authorization).toBe(`Bearer ${token}`);
    expect(seen.headers['x-board-client']).toMatch(/^web\//);
  });

  it('omits or overrides the contract header and sets the client version on request', async () => {
    const omitted = await call(server, 'client.me', {}, anonymous, { omitContractHeader: true });
    expect(omitted.status).toBe(412);
    expect(omitted.error?.code).toBe('upgrade-required');
    expect((await last()).headers['x-board-contract']).toBeUndefined();

    await call(server, 'client.me', {}, anonymous, {
      contractHeader: 99,
      clientVersion: '0.9.1',
      clientKind: 'cli',
    });
    const seen = await last();
    expect(seen.headers['x-board-contract']).toBe('99');
    expect(seen.headers['x-board-client']).toBe('cli/0.9.1');
  });
});

describe('contract client requests', () => {
  it('puts the input in the query for a GET and in a JSON body for a POST', async () => {
    await call(server, 'client.tasks.list', { closed: 'true' }, anonymous);
    const read = await last();
    expect(read.method).toBe('GET');
    expect(read.url).toBe('/api/client/tasks/list?closed=true');
    expect(read.body).toBe('');

    await call(server, 'client.tasks.done', { id: 'task-1' }, anonymous);
    const write = await last();
    expect(write.method).toBe('POST');
    expect(write.url).toBe('/api/client/tasks/done');
    expect(write.headers['content-type']).toBe('application/json');
    expect(JSON.parse(write.body)).toEqual({ id: 'task-1' });
  });

  it('can leave the content type out or override it', async () => {
    await call(server, 'client.tasks.done', { id: 'task-1' }, anonymous, {
      omitContentType: true,
    });
    expect((await last()).headers['content-type']).toBeUndefined();
    await call(server, 'client.tasks.done', { id: 'task-1' }, anonymous, {
      contentType: 'text/plain',
    });
    expect((await last()).headers['content-type']).toBe('text/plain');
  });

  it('parses a success body with the route schema', async () => {
    const result = await call(server, 'client.me', {}, anonymous);
    expect(result.body).toEqual({ username: 'tester', keyId: null });
    expect(await callOk(server, 'client.me', {}, anonymous)).toEqual(result.body);
  });

  it('returns a non-2xx answer without throwing', async () => {
    const result = await call(server, 'client.tasks.get', { id: 'missing' }, anonymous);
    expect(result.status).toBe(404);
    expect(result.ok).toBe(false);
    expect(result.body).toBeNull();
    expect(result.error).toEqual({ code: 'not-found', message: 'no such task' });
    await expect(callOk(server, 'client.tasks.get', { id: 'missing' }, anonymous)).rejects.toThrow(
      /404/,
    );
  });

  it('sends a raw request when the contract would refuse the input', async () => {
    const result = await callRaw(server, {
      method: 'POST',
      path: '/api/client/tasks/done',
      rawBody: 'not json',
    });
    expect(result.status).toBe(404);
    expect((await last()).body).toBe('not json');
  });
});

describe('cookie jar', () => {
  it('keeps a cookie the server sets and sends it back', async () => {
    const jar = new CookieJar();
    const credential = cookieSession(jar);
    await call(server, 'auth.config', {}, credential);
    expect(jar.get('board-session')).toMatch(/^abs_/);
    const revision = await call(server, 'client.revision', {}, credential);
    expect(revision.body?.revision).toContain('board-session=abs_');
  });

  it('drops a cookie the server expires', () => {
    const jar = new CookieJar();
    jar.store(['a=1; Path=/', 'b=2; HttpOnly']);
    expect(jar.header()).toBe('a=1; b=2');
    jar.store(['a=; Max-Age=0; Path=/']);
    expect(jar.header()).toBe('b=2');
  });
});

describe('request signing', () => {
  it('adds the four signature headers and a content digest that verify', async () => {
    const signer = await createRequestSigner();
    await call(server, 'client.tasks.done', { id: 'task-1' }, anonymous, { signer });
    const seen = await last();
    const body = seen.body;
    expect(seen.headers[SIGNATURE_HEADERS.key]).toBe(signer.keyId);
    expect(seen.headers[SIGNATURE_HEADERS.nonce]).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const ts = Number(seen.headers[SIGNATURE_HEADERS.ts]);
    expect(Math.abs(ts - Date.now() / 1000)).toBeLessThan(30);
    const digest = await contentDigest(new TextEncoder().encode(body));
    expect(seen.headers[SIGNATURE_HEADERS.digest]).toBe(digest);
    const canonical = canonicalString({
      method: 'POST',
      pathWithQuery: '/api/client/tasks/done',
      ts,
      nonce: seen.headers[SIGNATURE_HEADERS.nonce] as string,
      digest,
    });
    expect(
      await verify(
        await importPublicKey(signer.publicKey),
        canonical,
        seen.headers[SIGNATURE_HEADERS.sig] as string,
      ),
    ).toBe(true);
  });

  it('signs a read without a content digest, over the path and query', async () => {
    const signer = await createRequestSigner();
    await call(server, 'client.tasks.list', { closed: 'false' }, anonymous, { signer });
    const seen = await last();
    expect(seen.headers[SIGNATURE_HEADERS.digest]).toBeUndefined();
    const canonical = canonicalString({
      method: 'GET',
      pathWithQuery: '/api/client/tasks/list?closed=false',
      ts: Number(seen.headers[SIGNATURE_HEADERS.ts]),
      nonce: seen.headers[SIGNATURE_HEADERS.nonce] as string,
      digest: null,
    });
    expect(
      await verify(
        await importPublicKey(signer.publicKey),
        canonical,
        seen.headers[SIGNATURE_HEADERS.sig] as string,
      ),
    ).toBe(true);
  });
});

describe('event stream reader', () => {
  it('parses events and pings', () => {
    expect(parseSseBlock('event: changed\ndata: {}')).toEqual([
      { type: 'event', event: 'changed', data: '{}' },
    ]);
    const [ping] = parseSseBlock(': ping');
    expect(ping && isPing(ping)).toBe(true);
    expect(parseSseBlock('data: a\ndata: b')).toEqual([
      { type: 'event', event: 'message', data: 'a\nb' },
    ]);
  });

  it('reads chunks split anywhere and ends with the body', async () => {
    const text = 'event: tasks\r\ndata: {}\r\n\r\n: ping\n\nevent: x\ndata: 1\n\n';
    const encoded = new TextEncoder().encode(text);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < encoded.length; index += 5) {
          controller.enqueue(encoded.slice(index, index + 5));
        }
        controller.close();
      },
    });
    const items = [];
    for await (const item of readSse(body)) items.push(item);
    expect(items.map((item) => item.type)).toEqual(['event', 'comment', 'event']);
  });

  it('delivers events from a server and ends when the stream closes', async () => {
    const stream = await openEvents(
      server,
      'machine.events',
      machineToken(`abm_${'M'.repeat(43)}`),
    );
    expect(stream.status).toBe(200);
    expect(await stream.nextEvent()).toEqual({ event: 'tasks', data: {} });
    expect(await stream.nextEvent()).toEqual({ event: 'changed', data: { n: 2 } });
    expect(await stream.next()).toBeNull();
    await stream.closed;
    expect(stream.items.some(isPing)).toBe(true);
  });

  it('times out when no event arrives', async () => {
    const stream = await openEvents(server, 'client.events', anonymous, {
      query: { project: 'hold' },
    });
    await stream.nextEvent();
    await expect(stream.nextEvent(150)).rejects.toThrow(/no event within/);
    stream.close();
    await stream.closed;
  });
});
