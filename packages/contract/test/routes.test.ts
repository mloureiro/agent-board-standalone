import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ERROR_CODES,
  FEATURES,
  routeByName,
  routes,
  machineRoutes,
  clientRoutes,
  publicRoutes,
} from '../src/index.js';

const objectIssues = (schema: z.core.$ZodType, path: string, seen: Set<unknown>): string[] => {
  if (seen.has(schema)) return [];
  seen.add(schema);
  const def = schema._zod.def as unknown as Record<string, unknown> & { type: string };
  const child = (next: unknown, label: string) =>
    objectIssues(next as z.core.$ZodType, `${path}.${label}`, seen);
  switch (def.type) {
    case 'object': {
      const catchall = def.catchall as z.core.$ZodType | undefined;
      const issues = catchall?._zod.def.type === 'never' ? [] : [`${path} is not strict`];
      const shape = def.shape as Record<string, unknown>;
      return [...issues, ...Object.entries(shape).flatMap(([key, value]) => child(value, key))];
    }
    case 'array':
      return child(def.element, '[]');
    case 'union':
      return (def.options as unknown[]).flatMap((option, index) => child(option, `|${index}`));
    case 'optional':
    case 'nullable':
    case 'default':
    case 'readonly':
      return child(def.innerType, '?');
    case 'pipe':
      return child(def.in, 'in');
    case 'record':
      return child(def.valueType, '{}');
    case 'tuple':
      return (def.items as unknown[]).flatMap((item, index) => child(item, `${index}`));
    default:
      return [];
  }
};

describe('route table', () => {
  it('[contract-003] route names are unique', () => {
    const names = routes.map((route) => route.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('[contract-003] method and path pairs are unique', () => {
    const pairs = routes.map((route) => `${route.method} ${route.path}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('[contract-003] every auth kind is public, client or machine', () => {
    for (const route of routes) expect(['public', 'client', 'machine']).toContain(route.auth);
    expect(machineRoutes.length + clientRoutes.length + publicRoutes.length).toBe(routes.length);
  });

  it('[contract-003] every machine route is under /api/machine/ with auth machine and POST unless it streams', () => {
    for (const route of machineRoutes) {
      expect(route.path.startsWith('/api/machine/')).toBe(true);
      expect(route.name).toBe(`machine.${route.path.slice('/api/machine/'.length)}`);
      expect(route.path).toMatch(/^\/api\/machine\/[a-z]+(-[a-z]+)*$/);
      if (!route.stream) expect(route.method).toBe('POST');
    }
  });

  it('[contract-003] this iteration registers the 24 machine commands', () => {
    expect(machineRoutes.map((route) => route.name.slice('machine.'.length)).sort()).toEqual(
      [
        'list-tasks',
        'get-task',
        'attach-session',
        'add-task',
        'update-task',
        'configure-task',
        'edit-prompt',
        'claim-task',
        'add-note',
        'read-notes',
        'ask',
        'add-pr',
        'remove-pr',
        'set-pr-states',
        'set-watches',
        'ack-watch-stops',
        'heartbeat',
        'pause',
        'fail',
        'stopped',
        'run-inbox',
        'ack-messages',
        'wait',
        'wake',
      ].sort(),
    );
    expect(machineRoutes).toHaveLength(24);
  });

  it('[contract-003] every request and response schema is strict', () => {
    for (const route of routes) {
      expect(objectIssues(route.request, `${route.name}.request`, new Set())).toEqual([]);
      expect(objectIssues(route.response, `${route.name}.response`, new Set())).toEqual([]);
    }
  });

  it('[contract-003] the strictness walk flags loose objects inside arrays, unions and optionals', () => {
    const loose = z.object({ a: z.string() });
    const strict = z.object({ a: z.string() }).strict();
    expect(objectIssues(strict, 'x', new Set())).toEqual([]);
    expect(objectIssues(loose, 'x', new Set())).toHaveLength(1);
    expect(objectIssues(z.array(loose).optional(), 'x', new Set())).toHaveLength(1);
    expect(objectIssues(z.union([strict, loose]), 'x', new Set())).toHaveLength(1);
    expect(objectIssues(z.object({ n: loose.nullable() }).strict(), 'x', new Set())).toHaveLength(
      1,
    );
  });

  it('[contract-003] every declared error code and feature is known', () => {
    for (const route of routes) {
      for (const code of route.errors) expect(ERROR_CODES).toContain(code);
      expect(new Set(route.errors).size).toBe(route.errors.length);
      if (route.feature) expect(FEATURES).toContain(route.feature);
    }
  });

  it('[contract-003] every command that takes an id may answer not-found', () => {
    for (const route of routes) {
      const shape = (route.request as z.ZodObject).shape as Record<string, unknown> | undefined;
      if (shape && 'id' in shape) expect(route.errors).toContain('not-found');
    }
  });

  it('[contract-003] watch and run-inbox commands carry their feature', () => {
    for (const command of ['set-watches', 'ack-watch-stops'] as const) {
      expect(routeByName(`machine.${command}`).feature).toBe('watches');
    }
    for (const command of ['run-inbox', 'ack-messages'] as const) {
      expect(routeByName(`machine.${command}`).feature).toBe('run-inbox');
    }
  });

  it('[contract-003] routeByName finds a route and refuses an unknown name', () => {
    expect(routeByName('machine.add-task').path).toBe('/api/machine/add-task');
    expect(() => routeByName('machine.nope' as 'machine.add-task')).toThrow();
  });
});
