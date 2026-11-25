import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)), 'dist-web');
const PORT = Number(process.env.PORT ?? 4181);
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
};

createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  const file = normalize(join(ROOT, pathname));
  const target = file.startsWith(ROOT) && extname(file) !== '' ? file : join(ROOT, 'index.html');
  readFile(target)
    .then((bytes) => {
      response.writeHead(200, {
        'content-type': TYPES[extname(target)] ?? 'application/octet-stream',
      });
      response.end(bytes);
    })
    .catch(() => {
      response.writeHead(404);
      response.end();
    });
}).listen(PORT, '127.0.0.1');
