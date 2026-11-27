import { CONTRACT_HEADER } from '@rumo/contract';
import type { FastifyRequest } from 'fastify';

export const contractOf = (request: FastifyRequest): number =>
  Number(request.headers[CONTRACT_HEADER]);
