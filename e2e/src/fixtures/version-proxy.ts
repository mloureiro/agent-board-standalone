import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface VersionOverride {
  readonly contract?: number;
  readonly minClient?: Readonly<{ cli?: number; web?: number }>;
  readonly minServer?: number;
  readonly features?: readonly string[];
  readonly addFeatures?: readonly string[];
  readonly removeFeatures?: readonly string[];
}

export interface VersionProxyOptions {
  readonly target: string;
  readonly override?: VersionOverride;
  readonly host?: string;
  readonly port?: number;
}

export interface SeenRequest {
  readonly method: string;
  readonly path: string;
  readonly rewritten: boolean;
  readonly at: number;
}

export interface VersionProxy {
  readonly url: string;
  readonly port: number;
  readonly seen: readonly SeenRequest[];
  override(next: VersionOverride): void;
  retarget(url: string): void;
  stop(): Promise<void>;
}

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export function isVersionRequest(method: string, pathname: string): boolean {
  return (
    (method === 'GET' && pathname === '/api/version') ||
    (method === 'POST' && pathname === '/api/machine/version')
  );
}

export function patchVersion(document: unknown, override: VersionOverride): unknown {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    return document;
  }
  const patched: Record<string, unknown> = { ...(document as Record<string, unknown>) };
  if (override.contract !== undefined) patched.contract = override.contract;
  if (override.minServer !== undefined && 'minServer' in patched) {
    patched.minServer = override.minServer;
  }
  if (override.minClient !== undefined) {
    patched.minClient = {
      ...(typeof patched.minClient === 'object' ? (patched.minClient as object) : {}),
      ...override.minClient,
    };
  }
  if (
    override.features !== undefined ||
    override.addFeatures !== undefined ||
    override.removeFeatures !== undefined
  ) {
    const base = override.features ?? (Array.isArray(patched.features) ? patched.features : []);
    const removed = new Set(override.removeFeatures ?? []);
    patched.features = [...new Set([...base, ...(override.addFeatures ?? [])])].filter(
      (feature) => !removed.has(String(feature)),
    );
  }
  return patched;
}

function swapOrigin(
  value: string | string[] | number | undefined,
  from: string,
  to: string,
): string | string[] | number | undefined {
  if (typeof value === 'string') return value.replaceAll(from, to);
  if (Array.isArray(value)) return value.map((entry) => entry.replaceAll(from, to));
  return value;
}

function forwardedHeaders(
  incoming: http.IncomingHttpHeaders,
  target: URL,
  proxyOrigin: string,
  identity: boolean,
): http.OutgoingHttpHeaders {
  const headers: Record<string, http.OutgoingHttpHeader | undefined> = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (!HOP_BY_HOP.has(name)) headers[name] = value;
  }
  headers.host = target.host;
  if (headers.origin !== undefined) {
    headers.origin = swapOrigin(headers.origin, proxyOrigin, target.origin);
  }
  if (headers.referer !== undefined) {
    headers.referer = swapOrigin(headers.referer, proxyOrigin, target.origin);
  }
  if (identity) headers['accept-encoding'] = 'identity';
  return headers;
}

export async function startVersionProxy(options: VersionProxyOptions): Promise<VersionProxy> {
  let target = new URL(options.target);
  let current: VersionOverride = options.override ?? {};
  const seen: SeenRequest[] = [];
  let proxyOrigin = '';

  const server = http.createServer((request, response) => {
    const method = request.method ?? 'GET';
    const incoming = new URL(request.url ?? '/', 'http://proxy.invalid');
    const rewrite = isVersionRequest(method, incoming.pathname);
    seen.push({
      method,
      path: `${incoming.pathname}${incoming.search}`,
      rewritten: rewrite,
      at: Date.now(),
    });

    const upstream = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method,
        path: `${incoming.pathname}${incoming.search}`,
        headers: forwardedHeaders(request.headers, target, proxyOrigin, rewrite),
      },
      (answer) => {
        const headers: Record<string, http.OutgoingHttpHeader | undefined> = {};
        for (const [name, value] of Object.entries(answer.headers)) {
          if (!HOP_BY_HOP.has(name)) headers[name] = value;
        }
        if (headers.location !== undefined) {
          headers.location = swapOrigin(headers.location, target.origin, proxyOrigin);
        }
        if (!rewrite || (answer.statusCode ?? 0) >= 400) {
          response.writeHead(answer.statusCode ?? 502, headers);
          answer.pipe(response);
          return;
        }
        const chunks: Buffer[] = [];
        answer.on('data', (chunk: Buffer) => chunks.push(chunk));
        answer.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let output: string;
          try {
            output = JSON.stringify(patchVersion(JSON.parse(text), current));
          } catch {
            output = text;
          }
          headers['content-length'] = Buffer.byteLength(output);
          delete headers['content-encoding'];
          response.writeHead(answer.statusCode ?? 200, headers);
          response.end(output);
        });
      },
    );
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'unavailable', message: 'proxy upstream' } }));
    });
    response.on('close', () => upstream.destroy());
    request.pipe(upstream);
  });

  const host = options.host ?? target.hostname;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, resolve);
  });
  const port = (server.address() as AddressInfo).port;
  proxyOrigin = `http://${host === '::1' ? '[::1]' : host}:${port}`;

  return {
    url: proxyOrigin,
    port,
    seen,
    override: (next) => {
      current = next;
    },
    retarget: (url) => {
      target = new URL(url);
      server.closeAllConnections();
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
