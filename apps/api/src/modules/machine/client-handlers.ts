import type { HandlerTable } from '../../http/handler.js';
import { announceChange, announceRevoked } from '../events/index.js';
import { ApiError } from '../../errors.js';
import { isoOrNull } from './machine-handlers.js';
import {
  issueMachineToken,
  listCatalogs,
  listFeeds,
  listMachineRows,
  requestFeed,
  revokeMachine,
  setGrant,
} from './machines.js';
import { readDocument, saveDocument } from './shared-documents.js';
import { eventOutput, latestContext, listEvents, listRuns, taskExists } from './transcripts.js';
import { clientStatus } from './versions.js';

const sealedDocument = async (
  read: Promise<{ document: string; version: number; updatedAt: Date } | null>,
) => {
  const stored = await read;
  return stored === null
    ? null
    : {
        document: stored.document,
        version: stored.version,
        updatedAt: stored.updatedAt.toISOString(),
      };
};

export const clientHandlers = (): HandlerTable => ({
  'client.machines.list': ({ principal, context }) =>
    context.services.database.withOwner(principal.owner, async (tx) => ({
      machines: (await listMachineRows(tx)).map(({ clientLevel, ...row }) => ({
        ...row,
        createdAt: row.createdAt.toISOString(),
        lastSeenAt: isoOrNull(row.lastSeenAt),
        revokedAt: isoOrNull(row.revokedAt),
        usageUpdatedAt: isoOrNull(row.usageUpdatedAt),
        clientStatus: clientStatus(
          { clientVersion: row.clientVersion, clientLevel },
          context.config.build.cli,
        ),
      })),
    })),

  'client.machines.catalogs': ({ principal, context }) =>
    context.services.database.withOwner(principal.owner, async (tx) => ({
      catalogs: (await listCatalogs(tx)).map((row) => ({
        ...row,
        catalogUpdatedAt: isoOrNull(row.catalogUpdatedAt),
      })),
    })),

  'client.machines.advertised-cli': ({ context }) => ({ version: context.config.build.cli }),

  'client.machines.issue': async ({ input, principal, context }) => {
    const token = await context.services.database.withOwner(principal.owner, (tx) =>
      issueMachineToken(tx, principal.owner, input.name),
    );
    await announceRevoked(context.services.events, principal.owner, input.name);
    await announceChange(context.services.events, principal.owner);
    return { token };
  },

  'client.machines.revoke': async ({ input, principal, context }) => {
    const found = await context.services.database.withOwner(principal.owner, (tx) =>
      revokeMachine(tx, input.name),
    );
    if (!found) throw new ApiError('not-found', `no machine ${input.name}`);
    await announceRevoked(context.services.events, principal.owner, input.name);
    await announceChange(context.services.events, principal.owner);
    return {};
  },

  'client.machines.set-grant': async ({ input, principal, context }) => {
    await context.services.database.withOwner(principal.owner, (tx) =>
      setGrant(tx, input.name, input.grant),
    );
    await announceChange(context.services.events, principal.owner);
    return {};
  },

  'client.feeds.list': ({ principal, context }) =>
    context.services.database.withOwner(principal.owner, async (tx) => ({
      machines: (await listFeeds(tx)).flatMap((row) =>
        row.feeds === null
          ? []
          : [
              {
                name: row.name,
                lastSeenAt: isoOrNull(row.lastSeenAt),
                feeds: row.feeds,
                feedsUpdatedAt: isoOrNull(row.feedsUpdatedAt),
                feedRequests: row.feedRequests,
              },
            ],
      ),
    })),

  'client.feeds.request': async ({ input, principal, context }) => {
    await context.services.database.withOwner(principal.owner, (tx) =>
      requestFeed(tx, input.machine, input),
    );
    await announceChange(context.services.events, principal.owner);
    return {};
  },

  'client.agents.shared': ({ principal, context }) =>
    context.services.database.withOwner(principal.owner, async (tx) => {
      const stored = await readDocument(tx, 'agents');
      return {
        document:
          stored === null
            ? null
            : {
                document: stored.document,
                version: stored.version,
                pushedAt: stored.updatedAt.toISOString(),
              },
      };
    }),

  'client.links.get': ({ principal, context }) =>
    context.services.database.withOwner(principal.owner, async (tx) => ({
      document: await sealedDocument(readDocument(tx, 'links')),
    })),

  'client.links.set': async ({ input, principal, context }) => {
    await context.services.database.withOwner(principal.owner, (tx) =>
      saveDocument(tx, 'links', input),
    );
    await announceChange(context.services.events, principal.owner);
    return {};
  },

  'client.title-rules.get': ({ principal, context }) =>
    context.services.database.withOwner(principal.owner, async (tx) => ({
      document: await sealedDocument(readDocument(tx, 'titles')),
    })),

  'client.title-rules.set': async ({ input, principal, context }) => {
    await context.services.database.withOwner(principal.owner, (tx) =>
      saveDocument(tx, 'titles', input),
    );
    await announceChange(context.services.events, principal.owner);
    return {};
  },

  'client.transcript.runs': ({ input, principal, context }) =>
    context.services.database.withOwner(principal.owner, async (tx) => {
      await taskExists(tx, input.id);
      return { runs: await listRuns(tx, input.id) };
    }),

  'client.transcript.events': ({ input, principal, context }) =>
    context.services.database.withOwner(principal.owner, async (tx) => ({
      events: await listEvents(tx, input.runId, input.afterSeq ?? -1),
    })),

  'client.transcript.context': ({ input, principal, context }) =>
    context.services.database.withOwner(principal.owner, async (tx) => {
      await taskExists(tx, input.id);
      return { context: await latestContext(tx, input.id) };
    }),

  'client.transcript.output': ({ input, principal, context }) =>
    context.services.database.withOwner(principal.owner, async (tx) => ({
      output: await eventOutput(tx, input.runId, input.seq),
    })),
});
