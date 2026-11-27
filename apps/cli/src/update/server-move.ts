import { listMachinesRoute } from '@rumo/contract';

import type { Context } from '../commands/context.js';
import { normalizeServerUrl } from '../commands/setup/init.js';
import { CliError, UsageError } from '../errors.js';
import { loadCredentials } from '../profile/credentials.js';
import { readServerFile, writeServerFile } from '../profile/files.js';
import { loadSigner } from '../profile/signing-key.js';
import { now } from '../transport/clock.js';
import { ApiError } from '../transport/errors.js';
import { handshake } from '../transport/handshake.js';
import { httpDeps, machineCaller, openSession } from '../transport/session.js';
import { PART_VERSION } from '../version.js';
import { createBackup, pruneBackups } from './backups.js';
import { withUpdateLock } from './lock.js';
import { readPendingMigration } from './migrations.js';

const ACTIVE_WITHIN_MS = 15 * 60_000;

const IMPORT_FIRST =
  'import your board export there first (Settings, Your data), then run this again';

function targetUrl(raw: string): string {
  try {
    return normalizeServerUrl(raw);
  } catch (error) {
    if (error instanceof UsageError) {
      throw new UsageError(error.message.replace('--url', '--server'));
    }
    throw error;
  }
}

async function activeElsewhere(ctx: Context): Promise<{ names: string[] } | { unknown: string }> {
  try {
    const s = await openSession({ rt: ctx.rt, dirs: ctx.dirs, dryRun: false });
    const { machines } = await s.query(listMachinesRoute, {});
    const at = now(ctx.rt.env);
    return {
      names: machines
        .filter(
          (machine) =>
            !machine.current &&
            machine.lastSeenAt !== null &&
            at - Date.parse(machine.lastSeenAt) <= ACTIVE_WITHIN_MS,
        )
        .map((machine) => machine.name),
    };
  } catch (error) {
    return { unknown: error instanceof Error ? error.message : String(error) };
  }
}

async function sourceOwner(ctx: Context): Promise<{ owner: string } | { problem: string }> {
  try {
    const s = await openSession({ rt: ctx.rt, dirs: ctx.dirs, dryRun: false });
    return { owner: s.info.owner ?? '' };
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
}

export async function moveServer(ctx: Context, rawUrl: string): Promise<void> {
  const { rt, dirs } = ctx;
  const target = targetUrl(rawUrl);
  const source = readServerFile(dirs.config);
  if (source === null) {
    throw new CliError(`profile "${dirs.profile}" has no server: run \`rumo init\` first`);
  }
  const current = normalizeServerUrl(source.url);
  if (current === target) {
    ctx.out(`this machine already uses ${target}`);
    return;
  }
  if (readPendingMigration(dirs.state) !== null) {
    throw new CliError(
      'a migration is pending; run `rumo self-update --resume` or `rumo self-update --rollback` first',
    );
  }

  const credentials = await loadCredentials(rt, dirs);
  const signer = await loadSigner(dirs.config);
  const origin = await sourceOwner(ctx);

  let info;
  try {
    info = await handshake(
      machineCaller(httpDeps(rt, target), credentials.token, signer),
      credentials.dataKey,
    );
  } catch (error) {
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      const wanted =
        'owner' in origin && origin.owner !== ''
          ? ` (owner ${origin.owner}, and the key id of this machine's data key)`
          : '';
      throw new CliError(
        `${target} does not accept this machine's token: the board there must hold this machine with the same owner and key id${wanted}; ${IMPORT_FIRST}; nothing was changed`,
      );
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new CliError(`${target} cannot be used (${reason}); nothing was changed`);
  }
  if ('owner' in origin && origin.owner !== '' && info.owner !== origin.owner) {
    throw new CliError(
      `${target} belongs to owner ${info.owner ?? 'unknown'} but the board at ${current} belongs to owner ${origin.owner}; nothing was changed`,
    );
  }
  ctx.out(
    `checked ${target}: it accepts this machine's token and holds the board of ${info.owner ?? 'its owner'} (key id ${info.keyId ?? 'unknown'})`,
  );

  const others = await activeElsewhere(ctx);
  if ('names' in others && others.names.length > 0) {
    ctx.out(
      `${current} still lists ${others.names.length} other machine(s) seen in the last 15 minutes: ${others.names.join(', ')}; they keep claiming tasks there until each runs "rumo self-update --server ${target}"`,
    );
  } else if ('unknown' in others) {
    ctx.out(
      `cannot tell whether other machines still use ${current} (${others.unknown}); run "rumo self-update --server ${target}" on each of them`,
    );
  }

  if (ctx.dryRun) {
    ctx.out(`DRY write server.json to ${target}`);
    return;
  }
  await withUpdateLock(dirs.state, () => {
    const backup = createBackup({
      dirs,
      kind: 'server',
      from: PART_VERSION,
      to: PART_VERSION,
      at: new Date(now(rt.env)),
      binary: null,
    });
    writeServerFile(dirs.config, { url: target });
    pruneBackups(dirs.state);
    ctx.out(`this machine now points at ${target}; the backup is ${backup.name}`);
    return Promise.resolve();
  });
  ctx.out(
    `${current} is unchanged; restart the units with \`rumo restart\` so they talk to ${target}`,
  );
  ctx.out(`to go back: rumo self-update --server ${current}, or rumo self-update --rollback`);
}
