import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type FakeHandler = (request: IncomingMessage, response: ServerResponse, url: URL) => unknown;

export interface FakeServer {
  url: string;
  close(): Promise<void>;
}

export const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

export const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

export const listen = async (
  handler: (url: string) => FakeHandler,
): Promise<{ server: FakeServer; url: string }> => {
  let handle: FakeHandler = () => undefined;
  const http: Server = createServer((request, response) => {
    const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    Promise.resolve(handle(request, response, new URL(request.url ?? '/', base))).catch(() => {
      response.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  handle = handler(url);
  return {
    url,
    server: {
      url,
      close: () =>
        new Promise<void>((resolve) => {
          http.close(() => resolve());
          http.closeAllConnections();
        }),
    },
  };
};
