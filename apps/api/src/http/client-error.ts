import { STATUS_CODES } from 'node:http';
import type { Socket } from 'node:net';

import { DATA_HEADERS, ERROR_STATUS, HSTS_HEADER } from '@agent-board/contract';

import { errorPayload } from '../errors.js';

export const clientErrorHandler =
  (hsts: boolean) =>
  (error: NodeJS.ErrnoException, socket: Socket): void => {
    if (error.code === 'ECONNRESET' || socket.destroyed) return;
    if (socket.writable) {
      const body = JSON.stringify(errorPayload('bad-request', 'malformed HTTP request'));
      const headers = {
        ...DATA_HEADERS,
        ...(hsts ? HSTS_HEADER : {}),
        'content-length': String(Buffer.byteLength(body)),
        connection: 'close',
      };
      const lines = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
      const status = ERROR_STATUS['bad-request'];
      socket.write(
        `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\n${lines.join('\r\n')}\r\n\r\n${body}`,
      );
    }
    socket.destroy(error);
  };
