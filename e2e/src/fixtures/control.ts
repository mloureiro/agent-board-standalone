import http from 'node:http';

export type ControlCommand = 'hold' | 'resume' | 'pair-code' | 'status';

export interface ControlAnswer {
  readonly status: number;
  readonly body: unknown;
  readonly text: string;
}

export interface ControlClient {
  readonly socketPath: string;
  send(command: ControlCommand, timeoutMs?: number): Promise<ControlAnswer>;
  hold(): Promise<ControlAnswer>;
  resume(): Promise<ControlAnswer>;
  status(): Promise<ControlAnswer>;
  pairCode(): Promise<string>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

function parse(text: string): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function controlClient(socketPath: string): ControlClient {
  const send = (command: ControlCommand, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ControlAnswer> =>
    new Promise((resolve, reject) => {
      const request = http.request(
        {
          socketPath,
          path: `/${command}`,
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': 2 },
          timeout: timeoutMs,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({ status: response.statusCode ?? 0, body: parse(text), text });
          });
          response.on('error', reject);
        },
      );
      request.on('timeout', () => request.destroy(new Error(`control ${command} timed out`)));
      request.on('error', reject);
      request.end('{}');
    });

  return {
    socketPath,
    send,
    hold: () => send('hold'),
    resume: () => send('resume'),
    status: () => send('status'),
    pairCode: async () => {
      const answer = await send('pair-code');
      const body = answer.body as { code?: unknown } | string | null;
      const code = typeof body === 'string' ? body.trim() : body?.code;
      if (answer.status !== 200 || typeof code !== 'string') {
        throw new Error(`pair-code answered ${answer.status}: ${answer.text}`);
      }
      return code;
    },
  };
}
