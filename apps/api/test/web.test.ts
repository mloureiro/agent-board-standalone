import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ASSET_HEADERS, DATA_HEADERS, PAGE_HEADERS, WEB_CSP } from '@agent-board/contract';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { selectRanges, type Selection } from '../src/modules/web/ranges.js';
import { boot, noLoginEnv, type TestBoard } from './helpers.js';

let folder = '';
let root = '';
const boards: TestBoard[] = [];

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), 'board-api-web-'));
  root = join(folder, 'site');
  mkdirSync(join(root, 'assets'), { recursive: true });
  mkdirSync(join(root, 'docs'));
  writeFileSync(join(root, 'index.html'), '<html>page</html>');
  writeFileSync(join(root, 'docs', 'index.html'), '<html>docs</html>');
  writeFileSync(join(root, 'sw.js'), 'self.skip()');
  writeFileSync(join(root, 'app.webmanifest'), '{}');
  writeFileSync(join(root, 'assets', 'app.js'), '0123456789');
  writeFileSync(join(folder, 'secret.txt'), 'top secret');
  symlinkSync(join(folder, 'secret.txt'), join(root, 'assets', 'leak.txt'));
  symlinkSync(join(folder, 'secret.txt'), join(root, 'leak.txt'));
});

afterAll(() => rmSync(folder, { recursive: true, force: true }));

afterEach(async () => {
  await Promise.all(boards.splice(0).map((board) => board.app.close()));
});

const started = async (extra: Record<string, string> = {}): Promise<TestBoard> => {
  const board = await boot(noLoginEnv({ WEB_ROOT: root, ...extra }));
  boards.push(board);
  return board;
};

const raw = async (board: TestBoard, request: string): Promise<string> => {
  if (!board.app.server.listening) await board.app.listen({ port: 0, host: '127.0.0.1' });
  const address = board.app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let received = '';
    socket.on('data', (chunk) => (received += chunk.toString('latin1')));
    socket.on('close', () => resolve(received));
    socket.on('error', reject);
    socket.write(`${request}\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
  });
};

const subset = (headers: Record<string, unknown>, table: Readonly<Record<string, string>>) =>
  Object.fromEntries(Object.keys(table).map((name) => [name, headers[name]]));

describe('[api-108] static files', () => {
  it('serves the page at / and falls back to it for non-asset misses with the page headers', async () => {
    const { app } = await started();
    for (const url of ['/', '/boards/42/settings', '/assets']) {
      const answer = await app.inject({ url });
      expect(answer.statusCode, url).toBe(200);
      expect(answer.body, url).toBe('<html>page</html>');
      expect(answer.headers['cache-control'], url).toBe('no-cache');
      expect(answer.headers['content-type'], url).toBe('text/html; charset=utf-8');
      expect(subset(answer.headers, PAGE_HEADERS), url).toEqual(PAGE_HEADERS);
      expect(answer.headers['content-security-policy']).toBe(WEB_CSP);
    }
  });

  it('serves a directory through its own index.html', async () => {
    const { app } = await started();
    expect((await app.inject({ url: '/docs/' })).body).toBe('<html>docs</html>');
    expect((await app.inject({ url: '/docs' })).body).toBe('<html>docs</html>');
  });

  it('marks /assets/ immutable and the rest no-cache, with the asset headers and content types', async () => {
    const { app } = await started();
    const asset = await app.inject({ url: '/assets/app.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(asset.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(subset(asset.headers, ASSET_HEADERS)).toEqual(ASSET_HEADERS);
    expect(asset.headers['content-security-policy']).toBeUndefined();

    const worker = await app.inject({ url: '/sw.js' });
    expect(worker.headers['cache-control']).toBe('no-cache');
    expect(worker.headers['content-type']).toBe('text/javascript; charset=utf-8');
    const manifest = await app.inject({ url: '/app.webmanifest' });
    expect(manifest.headers['content-type']).toBe('application/manifest+json');
  });

  it('answers a missing asset with 404 instead of the page', async () => {
    const { app } = await started();
    const answer = await app.inject({ url: '/assets/missing.js' });
    expect(answer.statusCode).toBe(404);
    expect(answer.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(subset(answer.headers, ASSET_HEADERS)).toEqual(ASSET_HEADERS);
    expect((await app.inject({ url: '/assets/' })).statusCode).toBe(404);
  });

  it('answers HEAD like GET without a body', async () => {
    const { app } = await started();
    const answer = await app.inject({ method: 'HEAD', url: '/assets/app.js' });
    expect(answer.statusCode).toBe(200);
    expect(answer.body).toBe('');
    expect(answer.headers['content-length']).toBe('10');
  });

  it('refuses every method but GET and HEAD with 405 and Allow', async () => {
    const { app } = await started();
    for (const method of ['PUT', 'PATCH', 'DELETE'] as const) {
      const answer = await app.inject({ method, url: '/index.html', payload: {} });
      expect(answer.statusCode, method).toBe(405);
      expect(answer.headers.allow, method).toBe('GET, HEAD');
      expect(answer.headers['cache-control'], method).toBe('no-cache');
    }
    const post = await app.inject({ method: 'POST', url: '/assets/app.js', payload: {} });
    expect(post.statusCode).toBe(405);
    expect(post.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('keeps the API answers on /api/ and the contract routes untouched', async () => {
    const { app } = await started();
    const unknown = await app.inject({ url: '/api/nowhere' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.code).toBe('not-found');
    expect(subset(unknown.headers, DATA_HEADERS)).toEqual(DATA_HEADERS);
    const version = await app.inject({ url: '/api/version' });
    expect(version.statusCode).toBe(200);
    expect(version.json()).toHaveProperty('contract');
    const unknownPost = await app.inject({ method: 'POST', url: '/api/nowhere', payload: {} });
    expect(unknownPost.statusCode).toBe(404);
    for (const url of ['/api', '/%61pi/nowhere']) {
      const miss = await app.inject({ url });
      expect(miss.statusCode, url).toBe(404);
      expect(miss.json().error.code, url).toBe('not-found');
    }
  });

  it('refuses traversal, NUL, backslash and bad encodings with 400', async () => {
    const board = await started();
    const cases = [
      '/assets/..%2f..%2fsecret.txt',
      '/assets/%2e%2e/%2e%2e/secret.txt',
      '/../secret.txt',
      '/assets/../../secret.txt',
      '/assets/..%5c..%5csecret.txt',
      '/assets/a\\b',
      '/a%00b',
      '/%ff',
    ];
    for (const target of cases) {
      const answer = await raw(board, `GET ${target} HTTP/1.1`);
      expect(answer.split('\r\n')[0], target).toBe('HTTP/1.1 400 Bad Request');
      expect(answer, target).not.toContain('top secret');
    }
  });

  it('takes a doubly encoded dot for a plain missing file', async () => {
    const { app } = await started();
    const answer = await app.inject({ url: '/assets/%252e%252e/secret.txt' });
    expect(answer.statusCode).toBe(404);
  });

  it('does not follow a symlink out of the root', async () => {
    const { app } = await started();
    const inAssets = await app.inject({ url: '/assets/leak.txt' });
    expect(inAssets.statusCode).toBe(404);
    expect(inAssets.body).not.toContain('top secret');
    const outside = await app.inject({ url: '/leak.txt' });
    expect(outside.body).toBe('<html>page</html>');
  });

  it('serves nothing without WEB_ROOT', async () => {
    const board = await boot(noLoginEnv());
    boards.push(board);
    const answer = await board.app.inject({ url: '/' });
    expect(answer.statusCode).toBe(404);
    expect(answer.json().error.code).toBe('not-found');
  });
});

const spans = (...pairs: [number, number][]): Selection => ({
  kind: 'spans',
  spans: pairs.map(([start, length]) => ({ start, length })),
});
const whole: Selection = { kind: 'whole' };
const invalid: Selection = { kind: 'invalid' };
const noOverlap: Selection = { kind: 'no-overlap' };

describe('[api-109] static byte ranges', () => {
  it('selects the bytes Go selects', () => {
    const cases: [string, number, Selection][] = [
      ['', 10, whole],
      ['bytes=0-4', 10, spans([0, 5])],
      ['bytes=3-', 10, spans([3, 7])],
      ['bytes=-4', 10, spans([6, 4])],
      ['bytes=-99', 10, spans([0, 10])],
      ['bytes=-0', 10, spans([10, 0])],
      ['bytes=2-99', 10, spans([2, 8])],
      ['bytes= 1 - 2 ', 10, spans([1, 2])],
      ['bytes=+1-2', 10, spans([1, 2])],
      ['bytes=0-1,,4-5', 10, spans([0, 2], [4, 2])],
      ['bytes=0-1,20-30', 10, spans([0, 2])],
      ['bytes=0-6,4-9', 10, whole],
      ['bytes=', 10, whole],
      ['bytes=,', 10, whole],
      ['bytes=10-', 10, noOverlap],
      ['bytes=20-5', 10, noOverlap],
      ['bytes=20-x', 10, noOverlap],
      ['bytes=20-,30-', 10, noOverlap],
      ['bytes=0-0', 0, noOverlap],
      ['bytes=-5', 0, noOverlap],
      ['bytes=5-2', 10, invalid],
      ['bytes=a-b', 10, invalid],
      ['bytes=-', 10, invalid],
      ['bytes=--5', 10, invalid],
      ['bytes=5', 10, invalid],
      ['bytes=0-1,x', 10, invalid],
      ['items=0-1', 10, invalid],
      ['Bytes=0-1', 10, invalid],
      ['bytes=9223372036854775807-', 10, noOverlap],
      ['bytes=9223372036854775808-', 10, invalid],
      ['bytes=0-9223372036854775807', 10, spans([0, 10])],
      ['bytes=0-9223372036854775808', 10, invalid],
      ['bytes=0--0', 10, spans([0, 1])],
      ['bytes=5--0', 10, invalid],
    ];
    for (const [header, size, expected] of cases)
      expect(selectRanges(header, size), `${header} on ${size}`).toEqual(expected);
  });

  it('answers a list of more than 200 items with the whole file', () => {
    const list = (count: number, tail = '') => `bytes=${Array(count).fill('0-0').join(',')}${tail}`;
    expect(selectRanges(list(200), 1000)).toMatchObject({ kind: 'spans' });
    expect(selectRanges(list(201), 1000)).toEqual(whole);
    expect(selectRanges(list(200, ','), 1000)).toEqual(whole);
  });

  it('answers a single range with 206 and Content-Range', async () => {
    const { app } = await started();
    const answer = await app.inject({ url: '/assets/app.js', headers: { range: 'bytes=2-4' } });
    expect(answer.statusCode).toBe(206);
    expect(answer.body).toBe('234');
    expect(answer.headers['content-range']).toBe('bytes 2-4/10');
    expect(answer.headers['accept-ranges']).toBe('bytes');
    expect(answer.headers['content-type']).toBe('text/javascript; charset=utf-8');
  });

  it('answers several ranges as multipart/byteranges with a 60-hex boundary', async () => {
    const { app } = await started();
    const answer = await app.inject({
      url: '/assets/app.js',
      headers: { range: 'bytes=0-1,4-5' },
    });
    expect(answer.statusCode).toBe(206);
    const match = /^multipart\/byteranges; boundary=([0-9a-f]{60})$/.exec(
      String(answer.headers['content-type']),
    );
    expect(match).not.toBeNull();
    const boundary = match![1]!;
    const type = 'text/javascript; charset=utf-8';
    expect(answer.body).toBe(
      `--${boundary}\r\nContent-Range: bytes 0-1/10\r\nContent-Type: ${type}\r\n\r\n01` +
        `\r\n--${boundary}\r\nContent-Range: bytes 4-5/10\r\nContent-Type: ${type}\r\n\r\n45` +
        `\r\n--${boundary}--\r\n`,
    );
  });

  it('answers a range that overlaps nothing with 416 and the file size', async () => {
    const { app } = await started();
    const answer = await app.inject({ url: '/assets/app.js', headers: { range: 'bytes=10-' } });
    expect(answer.statusCode).toBe(416);
    expect(answer.headers['content-range']).toBe('bytes */10');
    expect(answer.body).toBe('invalid range: failed to overlap\n');
    expect(answer.headers['content-type']).toBe('text/plain; charset=utf-8');
    const garbled = await app.inject({ url: '/assets/app.js', headers: { range: 'items=1-2' } });
    expect(garbled.statusCode).toBe(416);
    expect(garbled.body).toBe('invalid range\n');
    expect(garbled.headers['content-range']).toBeUndefined();
  });

  it('answers any If-Range with the whole file', async () => {
    const { app } = await started();
    const answer = await app.inject({
      url: '/assets/app.js',
      headers: { range: 'bytes=2-4', 'if-range': '"anything"' },
    });
    expect(answer.statusCode).toBe(200);
    expect(answer.body).toBe('0123456789');
  });
});

describe('[api-110] malformed HTTP', () => {
  it('answers a request that is not HTTP with 400 carrying the data headers', async () => {
    const board = await boot(noLoginEnv());
    boards.push(board);
    for (const request of ['GARBAGE', 'GET / HTTP/1.1\r\nBad Header']) {
      const answer = await raw(board, request);
      const [head, ...rest] = answer.split('\r\n\r\n');
      expect(head!.split('\r\n')[0], request).toBe('HTTP/1.1 400 Bad Request');
      const lower = head!.toLowerCase();
      for (const [name, value] of Object.entries(DATA_HEADERS))
        expect(lower, `${request} ${name}`).toContain(`${name}: ${value}`.toLowerCase());
      expect(JSON.parse(rest.join('\r\n\r\n')).error.code).toBe('bad-request');
    }
  });
});
