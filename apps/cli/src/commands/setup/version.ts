import { CONTRACT, MIN_SERVER } from '@rumo/contract';
import type { Command } from 'commander';

import { readServerFile } from '../../profile/files.js';
import { verdictOf } from '../../transport/compatibility.js';
import { parsePublicVersion, type ServerInfo } from '../../transport/server-info.js';
import { httpDeps } from '../../transport/session.js';
import { sendRequest } from '../../transport/request.js';
import { PART_VERSION } from '../../version.js';
import type { Context } from '../context.js';

export interface VersionReport {
  readonly cli: { readonly version: string; readonly contract: number; readonly minServer: number };
  readonly profile: string;
  readonly server: {
    readonly url: string;
    readonly version: string;
    readonly contract: number;
    readonly minClient: Readonly<Record<string, number>>;
    readonly features: readonly string[];
  } | null;
  readonly verdict: string | null;
  readonly message: string | null;
}

export function cliVersionLine(): string {
  return `rumo ${PART_VERSION} (contract ${CONTRACT})`;
}

export async function buildVersionReport(ctx: Context): Promise<VersionReport> {
  const cli = { version: PART_VERSION, contract: CONTRACT, minServer: MIN_SERVER };
  const configured = readServerFile(ctx.dirs.config);
  if (configured === null) {
    return { cli, profile: ctx.dirs.profile, server: null, verdict: null, message: null };
  }
  const info: ServerInfo = parsePublicVersion(
    await sendRequest(httpDeps(ctx.rt, configured.url), {
      method: 'GET',
      path: '/api/version',
      contractHeaders: false,
    }),
  );
  const { verdict, message } = verdictOf(info);
  return {
    cli,
    profile: ctx.dirs.profile,
    server: {
      url: configured.url,
      version: info.version,
      contract: info.contract,
      minClient: info.minClient,
      features: info.features,
    },
    verdict,
    message,
  };
}

export function renderVersionReport(report: VersionReport): string[] {
  const lines = [
    `rumo ${report.cli.version}`,
    `contract: ${report.cli.contract} (works with servers on contract ${report.cli.minServer} or newer)`,
    `profile: ${report.profile}`,
  ];
  if (report.server === null) {
    lines.push('server: not configured (run `rumo init`)');
    return lines;
  }
  lines.push(
    `server: ${report.server.url}`,
    `  version ${report.server.version}, contract ${report.server.contract}`,
    `  verdict: ${report.verdict}`,
    `  ${report.message}`,
    `  features: ${report.server.features.join(', ')}`,
  );
  return lines;
}

export async function runVersion(ctx: Context, options: { json?: boolean }): Promise<void> {
  const report = await buildVersionReport(ctx);
  if (options.json === true) {
    ctx.out(JSON.stringify(report));
    return;
  }
  for (const line of renderVersionReport(report)) ctx.out(line);
}

export function registerVersion(
  program: Command,
  withContext: (command: Command) => Context,
): void {
  program
    .command('version')
    .description('Print the CLI version, its contract range and the server verdict')
    .option('--json', 'print JSON')
    .action(async (options: { json?: boolean }, command: Command) => {
      await runVersion(withContext(command), options);
    });
}
