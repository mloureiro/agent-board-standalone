# ADR-0003: API module registry

## Status

Accepted.

## Context

The owner wants every server concern switchable by configuration ("tudo por módulos"): sign-in modes, request
signature, database driver, allowed hosts, events delivery, scheduling, feeds. Sealing and tenancy stay always on.

## Decision

- Each module owns a zod schema over its environment variables and a factory that registers its routes, hooks and
  services on the Fastify instance.
- Start-up parses every module, then runs one cross-module validation pass. Any failure refuses the start with a
  message naming the variables involved.
- Modules: database, sign-in, listen (host, port, allowed hosts), cross-origin, request signature, events, scheduling,
  feeds, web, control, access log, and a conditional tls module.
- Cross-module rules: the `postgres` events driver needs Postgres; no-login refuses login-only settings; no-login
  with a non-loopback bind or allowed host needs the request signature on.
- A disabled scheduling or feeds module answers the contract error `not-enabled` on its routes; scheduling off also
  stops task transitions from creating occurrences.
- Sealing checks and row-level security are not modules and have no switch.

## Consequences

- A new concern is added as a module with its own schema and tests, without touching the others.
- The server app configures the API purely through environment variables.

## Rows affected

api-005, api-007, api-013, api-014, api-015, api-021, api-022, api-023, api-024, api-108 … api-113, api-121 (new),
api-124 (new, conditional).
