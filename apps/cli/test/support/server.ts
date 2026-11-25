import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface SeenRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

export interface Answer {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  readonly delayMs?: number;
  readonly stream?: (response: http.ServerResponse) => void;
}

export type Handler = (request: SeenRequest) => Answer | undefined | Promise<Answer | undefined>;

export interface FakeServer {
  readonly url: string;
  readonly seen: SeenRequest[];
  stop(): Promise<void>;
}

export async function startServer(handler: Handler): Promise<FakeServer> {
  const seen: SeenRequest[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', async () => {
      const entry: SeenRequest = {
        method: request.method ?? 'GET',
        path: request.url ?? '/',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      seen.push(entry);
      const answer = (await handler(entry)) ?? {
        status: 404,
        body: { error: { code: 'not-found', message: 'no route' } },
      };
      if (answer.stream !== undefined) {
        response.writeHead(answer.status ?? 200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          ...answer.headers,
        });
        answer.stream(response);
        return;
      }
      setTimeout(() => {
        response.writeHead(answer.status ?? 200, {
          'content-type': 'application/json',
          ...answer.headers,
        });
        response.end(answer.body === undefined ? '' : JSON.stringify(answer.body));
      }, answer.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
