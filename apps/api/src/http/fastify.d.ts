import type { AnyRoute } from '@agent-board/contract';

import type { Principal } from '../auth/index.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    route?: AnyRoute;
    answer?: 'data' | 'page' | 'asset';
  }
  interface FastifyRequest {
    principal: Principal | null;
  }
}
