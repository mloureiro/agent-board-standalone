import { appendFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 0);
const features = JSON.parse(process.env.FAKE_API_FEATURES ?? '[]') as string[];
const databaseUrl = process.env.DATABASE_URL ?? '';

if (databaseUrl.startsWith('pglite://')) {
  appendFileSync(path.join(databaseUrl.slice('pglite://'.length), 'starts'), `${process.pid}\n`);
}

const server = http.createServer((request, response) => {
  const send = (body: unknown) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(body));
  };
  if (request.url === '/healthz') return send({ status: 'ok' });
  if (request.url === '/api/version') return send({ contract: 1, features });
  if (request.url === '/env') return send(Object.keys(process.env).sort());
  response.statusCode = 404;
  return send({ error: 'not-found' });
});

server.listen(port, host, () => {
  if (process.env.FAKE_API_SILENT === '1') {
    console.error('fake api started without announcing');
    return;
  }
  console.log(JSON.stringify({ listening: `http://${host}:${port}` }));
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
