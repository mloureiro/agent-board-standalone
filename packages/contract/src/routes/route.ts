import type { z } from 'zod';

import type { ErrorCode } from '../errors.js';
import type { Feature } from '../features.js';

export type AuthKind = 'public' | 'client' | 'machine';
export type HttpMethod = 'GET' | 'POST';
export type Module = 'scheduling' | 'feeds' | 'request-signature';

export interface Route<Req extends z.ZodType, Res extends z.ZodType> {
  name: string;
  method: HttpMethod;
  path: string;
  auth: AuthKind;
  request: Req;
  response: Res;
  errors: readonly ErrorCode[];
  feature?: Feature;
  module?: Module;
  issuesCredential?: true;
  stream?: true;
  bodyLimit?: number;
  bodyType?: 'json' | 'form';
}

export type AnyRoute = Route<z.ZodType, z.ZodType>;

export type RouteRequest<R extends AnyRoute> = z.input<R['request']>;
export type RouteResponse<R extends AnyRoute> = z.output<R['response']>;

export const defineRoute = <Req extends z.ZodType, Res extends z.ZodType>(
  route: Route<Req, Res>,
): Route<Req, Res> => route;

export type MachineCommandSpec<Req extends z.ZodType, Res extends z.ZodType> = Pick<
  Route<Req, Res>,
  'request' | 'response'
> &
  Partial<
    Pick<Route<Req, Res>, 'errors' | 'feature' | 'module' | 'bodyLimit' | 'issuesCredential'>
  >;

export type MachineRoute<C extends string, Req extends z.ZodType, Res extends z.ZodType> = Route<
  Req,
  Res
> & {
  name: `machine.${C}`;
  method: 'POST';
  path: `/api/machine/${C}`;
  auth: 'machine';
};

export const machineCommand = <C extends string, Req extends z.ZodType, Res extends z.ZodType>(
  command: C,
  spec: MachineCommandSpec<Req, Res>,
): MachineRoute<C, Req, Res> => ({
  ...spec,
  errors: spec.errors ?? [],
  name: `machine.${command}`,
  method: 'POST',
  path: `/api/machine/${command}`,
  auth: 'machine',
});

type Dotted<P extends string> = P extends `${infer Group}/${infer Action}`
  ? `${Group}.${Action}`
  : P;

export type ClientRoute<
  M extends HttpMethod,
  P extends string,
  Req extends z.ZodType,
  Res extends z.ZodType,
> = Route<Req, Res> & {
  name: `client.${Dotted<P>}`;
  method: M;
  path: `/api/client/${P}`;
  auth: 'client';
};

const clientRoute =
  <M extends 'GET' | 'POST'>(method: M) =>
  <P extends string, Req extends z.ZodType, Res extends z.ZodType>(
    path: P,
    spec: MachineCommandSpec<Req, Res>,
  ): ClientRoute<M, P, Req, Res> => ({
    ...spec,
    errors: spec.errors ?? [],
    name: `client.${path.replace('/', '.')}` as `client.${Dotted<P>}`,
    method,
    path: `/api/client/${path}`,
    auth: 'client',
  });

export const clientQuery = clientRoute('GET');
export const clientCommand = clientRoute('POST');
