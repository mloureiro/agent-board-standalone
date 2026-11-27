import type { AnyRoute } from '@rumo/contract';

import type { Principal } from '../auth/index.js';
import type { HoldGate } from '../modules/control/hold-gate.js';
import type { VerifiedSignature } from '../modules/request-signature/verify.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    route?: AnyRoute;
    answer?: 'data' | 'page' | 'asset';
  }
  interface FastifyRequest {
    principal: Principal | null;
    signature: VerifiedSignature | null;
  }
  interface FastifyInstance {
    hold: HoldGate;
  }
}
