import type { AnyRoute, RouteRequest, RouteResponse } from '@rumo/contract';

import { readApiError } from '../session/api-error.js';
import type { ServerClient } from '../transport/client.js';

export async function callRoute<R extends AnyRoute>(
  client: ServerClient,
  route: R,
  input: RouteRequest<R>,
): Promise<RouteResponse<R>> {
  const query = new URLSearchParams(input as Record<string, string>).toString();
  const response =
    route.method === 'GET'
      ? await client.request(query === '' ? route.path : `${route.path}?${query}`)
      : await client.request(route.path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
        });
  if (!response.ok) throw await readApiError(response);
  return route.response.parse(await response.json()) as RouteResponse<R>;
}
