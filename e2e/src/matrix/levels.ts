import type { PeerLevel } from './plan.ts';

function record(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

function level(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${what} is not a contract level`);
  }
  return value;
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`${what} is not a version`);
  return value;
}

export function parseApiLevel(document: unknown): PeerLevel {
  const body = record(document, 'the version answer');
  const server = record(body.server, 'the version answer server');
  const minClient = record(body.minClient, 'the version answer minClient');
  return {
    version: text(server.version, 'the server version'),
    contract: level(body.contract, 'the server contract'),
    minClient: {
      cli: level(minClient.cli, 'minClient.cli'),
      web: level(minClient.web, 'minClient.web'),
    },
  };
}

export function parseCliLevel(document: unknown): PeerLevel {
  const body = record(document, 'the CLI version output');
  const version = text(body.version, 'the CLI version');
  if (typeof body.contract === 'object' && body.contract !== null) {
    const range = record(body.contract, 'the CLI contract range');
    return {
      version,
      contract: level(range.max, 'the CLI contract range max'),
      minServer: level(range.min, 'the CLI contract range min'),
    };
  }
  return {
    version,
    contract: level(body.contract, 'the CLI contract'),
    ...(body.minServer === undefined
      ? {}
      : { minServer: level(body.minServer, 'the CLI minServer') }),
  };
}

export function parseWebLevel(document: unknown): PeerLevel {
  const body = record(document, 'version.json');
  return {
    version: text(body.version, 'the web version'),
    contract: level(body.contract, 'the web contract'),
  };
}
