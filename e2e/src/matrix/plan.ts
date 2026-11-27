import { compat, type ClientKind, type CompatKind } from '@rumo/contract';

export type MatrixPart = 'api' | 'cli' | 'web';

export interface MatrixCell {
  readonly id: string;
  readonly older: MatrixPart;
  readonly client: ClientKind;
}

export const MATRIX_CELLS: readonly MatrixCell[] = [
  { id: 'api-n/cli-n-1', older: 'cli', client: 'cli' },
  { id: 'api-n/web-n-1', older: 'web', client: 'web' },
  { id: 'api-n-1/cli-n', older: 'api', client: 'cli' },
  { id: 'api-n-1/web-n', older: 'api', client: 'web' },
];

export interface HeadLevels {
  readonly contract: number;
  readonly minClient: Readonly<Record<ClientKind, number>>;
  readonly minServer: number;
  readonly versions: Readonly<Record<MatrixPart, string>>;
}

export interface PeerLevel {
  readonly version: string;
  readonly contract: number;
  readonly minClient?: Readonly<Record<ClientKind, number>>;
  readonly minServer?: number;
}

export type CellDecision =
  | { readonly kind: 'no-n-1'; readonly cell: MatrixCell; readonly message: string }
  | {
      readonly kind: 'run';
      readonly cell: MatrixCell;
      readonly tag: string;
      readonly message: string;
    }
  | {
      readonly kind: 'refusal';
      readonly cell: MatrixCell;
      readonly tag: string;
      readonly message: string;
      readonly reason: Exclude<CompatKind, 'compatible'>;
    };

export function noN1Message(part: MatrixPart): string {
  return `no N-1 for ${part}`;
}

export function olderParts(): MatrixPart[] {
  return [...new Set(MATRIX_CELLS.map((cell) => cell.older))];
}

export function decideCell(
  cell: MatrixCell,
  tag: string | null,
  level: PeerLevel | null,
  head: HeadLevels,
): CellDecision {
  if (tag === null) return { kind: 'no-n-1', cell, message: noN1Message(cell.older) };
  if (level === null)
    throw new Error(`${cell.id}: ${tag} is built but its contract level is unknown`);
  const server =
    cell.older === 'api'
      ? { version: level.version, contract: level.contract, minClient: level.minClient }
      : {
          version: head.versions.api,
          contract: head.contract,
          minClient: head.minClient,
        };
  const client =
    cell.older === 'api'
      ? {
          version: head.versions[cell.client],
          contract: head.contract,
          minServer: head.minServer,
        }
      : { version: level.version, contract: level.contract, minServer: level.minServer };
  if (server.minClient === undefined) {
    throw new Error(`${cell.id}: ${tag} did not report the minimum client levels it accepts`);
  }
  const result = compat(
    {
      role: 'client',
      kind: cell.client,
      version: client.version,
      contract: client.contract,
      ...(client.minServer === undefined ? {} : { minServer: client.minServer }),
    },
    {
      role: 'server',
      version: server.version,
      contract: server.contract,
      minClient: server.minClient,
      features: [],
    },
  );
  if (result.kind === 'compatible') {
    return { kind: 'run', cell, tag, message: result.message };
  }
  return { kind: 'refusal', cell, tag, message: result.message, reason: result.kind };
}

export function refusalEnvironment(
  decision: Extract<CellDecision, { kind: 'refusal' }>,
  level: PeerLevel,
  head: HeadLevels,
): Record<string, string> {
  const { cell } = decision;
  return {
    E2E_MATRIX_CELL: cell.id,
    E2E_MATRIX_EXPECT: 'refusal',
    E2E_MATRIX_REFUSAL: decision.reason,
    E2E_MATRIX_PEER_VERSION: level.version,
    E2E_MATRIX_PEER_CONTRACT: String(level.contract),
    E2E_MATRIX_HEAD_VERSION: head.versions[cell.older === 'api' ? cell.client : 'api'],
  };
}
