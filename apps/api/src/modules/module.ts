import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';

import type { ServerContext } from '../context.js';

export interface ApiModule<Name extends string, Schema extends z.ZodType> {
  readonly name: Name;
  readonly schema: Schema;
  readonly register?: (app: FastifyInstance, context: ServerContext) => void | Promise<void>;
}

export const defineModule = <const Name extends string, Schema extends z.ZodType>(
  module: ApiModule<Name, Schema>,
): ApiModule<Name, Schema> => module;
