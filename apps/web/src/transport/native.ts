import type { AgentBoardBridge } from '../bridge/types.js';
import type { Transport } from './types.js';

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

export const nativeTransport = (bridge: AgentBoardBridge, serverId: string): Transport => ({
  kind: 'native',
  fetch: async (path, init = {}) => {
    const signal = init.signal;
    if (signal?.aborted) throw new DOMException('The request was aborted', 'AbortError');
    const answer = await bridge.serverFetch(
      serverId,
      init.method ?? 'GET',
      path,
      { ...init.headers },
      init.body ?? null,
    );
    const body = NULL_BODY_STATUSES.has(answer.status) ? null : answer.body;
    signal?.addEventListener('abort', () => void body?.cancel().catch(() => undefined), {
      once: true,
    });
    return new Response(body, { status: answer.status, headers: answer.headers });
  },
});
