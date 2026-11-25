import { request } from 'node:http';

export const requestPairCode = (socketPath: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const call = request(
      {
        socketPath,
        path: '/pair-code',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': 2 },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: { code?: unknown; error?: unknown } = {};
          try {
            body = JSON.parse(text) as typeof body;
          } catch {
            body = {};
          }
          if (response.statusCode === 200 && typeof body.code === 'string') resolve(body.code);
          else
            reject(
              new Error(
                typeof body.error === 'string'
                  ? body.error
                  : `the API answered ${response.statusCode}`,
              ),
            );
        });
        response.on('error', reject);
      },
    );
    call.on('error', reject);
    call.end('{}');
  });
