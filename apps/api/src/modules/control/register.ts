import type { FastifyInstance, FastifyRequest } from 'fastify';

import { ApiError } from '../../errors.js';
import { createHoldGate } from './hold-gate.js';

const HEALTH_ROUTE = 'public.healthz';

export const registerHoldGate = (app: FastifyInstance): void => {
  const gate = createHoldGate();
  app.decorate('hold', gate);
  const counted = new WeakSet<FastifyRequest>();

  app.addHook('onRequest', async (request) => {
    if (gate.isHeld()) {
      if (request.routeOptions.config.route?.name === HEALTH_ROUTE) return;
      throw new ApiError('unavailable', 'the board is on hold: try again in a moment');
    }
    counted.add(request);
    gate.enter();
  });

  const leave = async (request: FastifyRequest): Promise<void> => {
    if (counted.delete(request)) gate.leave();
  };
  app.addHook('onResponse', leave);
  app.addHook('onRequestAbort', leave);
};
