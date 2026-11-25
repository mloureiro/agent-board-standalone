import { appendFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 0);
const features = JSON.parse(process.env.FAKE_API_FEATURES ?? '[]') as string[];
const databaseUrl = process.env.DATABASE_URL ?? '';
const SESSION_COOKIE = 'board-session';
const SESSION_VALUE = `abs_${'S'.repeat(43)}`;
const TOKEN = `abc_${'C'.repeat(43)}`;

if (databaseUrl.startsWith('pglite://')) {
  appendFileSync(path.join(databaseUrl.slice('pglite://'.length), 'starts'), `${process.pid}\n`);
}

interface Recorded {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let last: Recorded | null = null;

const versionDocument = () => ({
  contract: 1,
  minClient: { cli: 1, web: 1 },
  features,
  server: { version: '1.0.0', commit: null },
  modules: { signIn: [], requestSignature: false, scheduling: true, feeds: true },
  session: 'not-required',
});

const machineVersion = () => ({
  contract: 1,
  minClient: { cli: 1, web: 1 },
  minServer: 1,
  features,
  server: { version: '1.0.0', commit: null },
  owner: 'tester',
  keyId: null,
  machine: 'fake',
  cli: null,
  catalogIndex: null,
  usageIndex: null,
  feedsIndex: null,
  feedRequests: [],
  agentsVersion: null,
  legacyDirs: false,
  grant: false,
  requestSignature: false,
});

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://fake.invalid');
  const send = (body: unknown, status = 200, headers: Record<string, string> = {}) => {
    response.writeHead(status, { 'content-type': 'application/json', ...headers });
    response.end(JSON.stringify(body));
  };
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const isBoardRoute = /^\/api\/(client|machine)\//.test(url.pathname);
    if (isBoardRoute) {
      last = {
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body,
      };
    }

    if (url.pathname === '/healthz') return send({ status: 'ok' });
    if (url.pathname === '/__last') return send(last);
    if (url.pathname.startsWith('/env/')) {
      return send({ value: process.env[url.pathname.slice('/env/'.length)] ?? null });
    }
    if (url.pathname === '/env') return send(Object.keys(process.env).sort());
    if (request.method === 'GET' && url.pathname === '/api/version') return send(versionDocument());

    if (isBoardRoute && !request.headers['x-board-contract']) {
      return send(
        {
          error: {
            code: 'upgrade-required',
            message: 'this client did not send its contract version',
          },
        },
        412,
      );
    }

    if (url.pathname === '/api/machine/version') return send(machineVersion());
    if (url.pathname === '/api/auth/config') {
      return send(
        { login: false },
        200,
        request.headers.cookie?.includes(SESSION_COOKIE)
          ? {}
          : { 'set-cookie': `${SESSION_COOKIE}=${SESSION_VALUE}; HttpOnly; Path=/` },
      );
    }
    if (url.pathname === '/api/auth/handoff/start') {
      return send({ flow: 'flow-1', code: 'ABCD-2345' });
    }
    if (url.pathname === '/api/auth/handoff/finish') {
      return send({ status: 'signed-in', token: TOKEN });
    }
    if (url.pathname === '/api/pair') return send({ keyId: '0123456789abcdef' });
    if (url.pathname === '/api/auth/logout') return send({});
    if (url.pathname === '/api/client/me') return send({ username: 'tester', keyId: null });
    if (url.pathname === '/api/client/revision') {
      return send({ revision: request.headers.cookie ?? null });
    }
    if (url.pathname === '/api/client/tasks/list') return send({ tasks: [] });
    if (url.pathname === '/api/client/tasks/create') return send({ task: null });
    if (url.pathname === '/api/client/tasks/get') {
      return send({ error: { code: 'not-found', message: 'no such task' } }, 404);
    }
    if (url.pathname === '/api/client/machines/issue') return send({ token: TOKEN });
    if (url.pathname === '/api/auth/saml/acs') {
      response.writeHead(303, { location: '/' });
      return response.end();
    }
    if (url.pathname === '/api/client/events' || url.pathname === '/api/machine/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      const hold = url.searchParams.get('project') === 'hold';
      response.write('event: tasks\ndata: {}\n\n');
      response.write(': ping\n\n');
      if (hold) return;
      response.write('event: changed\ndata: {"n":2}\n\n');
      return response.end();
    }
    return send({ error: 'not-found' }, 404);
  });
});

server.listen(port, host, () => {
  if (process.env.FAKE_API_SILENT === '1') {
    console.error('fake api started without announcing');
    return;
  }
  console.log(JSON.stringify({ listening: `http://${host}:${port}` }));
});

process.on('SIGTERM', () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
});
