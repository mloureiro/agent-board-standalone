import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { FEATURES, type DoctorResult } from '@rumo/contract';

import { appliedVersion, ASIDE_DIR } from '../agents/shared.js';
import type { Context } from '../commands/context.js';
import { loadCredentials } from '../profile/credentials.js';
import { readServerFile } from '../profile/files.js';
import { loadSigner } from '../profile/signing-key.js';
import { UPGRADE_HINT, verdictOf } from '../transport/compatibility.js';
import { handshake } from '../transport/handshake.js';
import { sendRequest } from '../transport/request.js';
import { parsePublicVersion, type ServerInfo } from '../transport/server-info.js';
import { httpDeps, machineCaller } from '../transport/session.js';
import { pass, problem } from './results.js';
import { signingKeyCheck } from './local.js';

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function serverChecks(
  ctx: Context,
  credentialsLoaded: boolean,
): Promise<DoctorResult[]> {
  const configured = readServerFileQuietly(ctx);
  if (configured === null) return [];
  const results: DoctorResult[] = [];
  let advertised: ServerInfo;
  try {
    advertised = parsePublicVersion(
      await sendRequest(httpDeps(ctx.rt, configured), {
        method: 'GET',
        path: '/api/version',
        contractHeaders: false,
      }),
    );
  } catch (error) {
    return [problem('server', 'fail', reason(error), 'check the URL and that the board is up')];
  }
  const { verdict, message } = verdictOf(advertised);
  results.push(
    verdict === 'compatible'
      ? pass('server', `${configured}: ${message}`)
      : problem(
          'server',
          'fail',
          message,
          verdict === 'client-too-old'
            ? UPGRADE_HINT
            : "update the board server to this CLI's contract",
        ),
  );
  const missing = FEATURES.filter((feature) => !advertised.features.includes(feature));
  results.push(
    missing.length === 0
      ? pass('server features', 'the server has every feature this CLI knows')
      : problem(
          'server features',
          'warn',
          `the server lacks: ${missing.join(', ')}`,
          'commands that need these features refuse until the server is updated',
        ),
  );
  results.push(signingKeyCheck(ctx, advertised.requestSignature));
  if (!credentialsLoaded) return results;
  return [...results, ...(await machineChecks(ctx, configured))];
}

function readServerFileQuietly(ctx: Context): string | null {
  try {
    return readServerFile(ctx.dirs.config)?.url ?? null;
  } catch {
    return null;
  }
}

async function machineChecks(ctx: Context, url: string): Promise<DoctorResult[]> {
  let info: ServerInfo;
  try {
    const credentials = await loadCredentials(ctx.rt, ctx.dirs);
    const signer = await loadSigner(ctx.dirs.config);
    info = await handshake(
      machineCaller(httpDeps(ctx.rt, url), credentials.token, signer),
      credentials.dataKey,
    );
  } catch (error) {
    return [
      problem(
        'board key',
        'fail',
        reason(error),
        'check the token and the data key; run `rumo init --force` with fresh ones',
      ),
    ];
  }
  const results = [
    pass(
      'board key',
      `the board accepts this machine (${info.machine ?? 'unnamed'}) and the data key matches`,
    ),
  ];
  results.push(
    info.legacyDirs
      ? problem(
          'legacy-dirs',
          'warn',
          'the board holds a legacy directory document that is not converted yet',
          'run `rumo dirs` to convert it',
        )
      : pass('legacy-dirs', 'no legacy directories waiting'),
  );
  if (info.features.includes('shared-agents') && info.agentsVersion !== null) {
    const applied = appliedVersion(ctx.dirs);
    results.push(
      applied >= info.agentsVersion
        ? pass("board's agents", `this machine applied version ${applied}`)
        : problem(
            "board's agents",
            'warn',
            `the board holds agents version ${info.agentsVersion}, this machine applied ${applied === 0 ? 'none' : applied}`,
            'the next dispatch tick applies them',
          ),
    );
  }
  return results;
}

export function replacedAgentsCheck(ctx: Context): DoctorResult {
  const aside = path.join(ctx.dirs.config, ASIDE_DIR);
  const kept = existsSync(aside) ? readdirSync(aside) : [];
  if (kept.length === 0) return pass('agents.replaced', 'no local agent was replaced by the board');
  return problem(
    'agents.replaced',
    'warn',
    `the board's agents replaced ${kept.length} local definition(s), kept in ${aside}`,
    'delete them once you do not need them',
  );
}
