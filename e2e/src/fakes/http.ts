import http from 'node:http';

export type Handler = (
  request: http.IncomingMessage,
  response: http.ServerResponse,
) => void | Promise<void>;

export async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

export function sendText(
  response: http.ServerResponse,
  status: number,
  contentType: string,
  body: string,
): void {
  response.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  response.end(body);
}

export function redirect(response: http.ServerResponse, location: string): void {
  response.writeHead(302, { location, 'cache-control': 'no-store' });
  response.end();
}

export function serve(handler: Handler, port: number, host = '127.0.0.1'): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error: unknown) => {
      if (!response.headersSent) sendJson(response, 500, { error: 'server_error' });
      console.error(error);
      response.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

export function onTermination(server: http.Server): void {
  const stop = (): void => {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

export function readFlags(argv: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag?.startsWith('--') && value !== undefined) {
      flags.set(flag.slice(2), value);
      index += 1;
    }
  }
  return flags;
}

export function requiredFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined || value === '') throw new Error(`missing --${name}`);
  return value;
}
