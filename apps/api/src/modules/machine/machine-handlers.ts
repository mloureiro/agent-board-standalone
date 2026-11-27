import {
  CLIENT_HEADER,
  CONTRACT,
  CONTRACT_HEADER,
  MIN_CLIENT,
  MIN_SERVER,
  parseClientHeader,
} from '@rumo/contract';

import type { HandlerTable } from '../../http/handler.js';
import { announceChange, announceRevoked, announceTaskChange } from '../events/index.js';
import { featuresServed } from '../../http/version.js';
import {
  ackFeedRequests,
  listActiveMachines,
  machineState,
  recordSighting,
  revokeMachine,
  storeDocument,
} from './machines.js';
import { agentsVersion, readDocument, saveDocument } from './shared-documents.js';
import { applyTitleRule } from './title-rule.js';
import { appendTranscript } from './transcripts.js';

export const isoOrNull = (value: Date | null): string | null =>
  value === null ? null : value.toISOString();

const reportedClient = (
  headers: Record<string, string | string[] | undefined>,
): { version: string | null; level: number | null } => {
  const declared = parseClientHeader(String(headers[CLIENT_HEADER] ?? ''));
  const level = Number(headers[CONTRACT_HEADER]);
  return {
    version: declared?.kind === 'cli' ? declared.version : null,
    level: declared?.kind === 'cli' && Number.isInteger(level) ? level : null,
  };
};

export const machineHandlers = (): HandlerTable => ({
  'machine.version': ({ principal, request, context }) =>
    context.services.database.withOwner(principal.owner, async (tx) => {
      await recordSighting(tx, principal.machineId, reportedClient(request.headers));
      const state = await machineState(tx, principal.owner, principal.machineId);
      return {
        contract: CONTRACT,
        minClient: { ...MIN_CLIENT },
        minServer: MIN_SERVER,
        features: featuresServed(context.config),
        server: { version: context.config.build.version, commit: context.config.build.commit },
        owner: principal.owner,
        keyId: state.keyId,
        machine: principal.machineId,
        cli: context.config.build.cli,
        catalogIndex: state.catalogIndex,
        usageIndex: state.usageIndex,
        feedsIndex: state.feedsIndex,
        feedRequests: state.feedRequests,
        agentsVersion: await agentsVersion(tx),
        legacyDirs: state.legacyDirs,
        grant: state.actsAsOwner,
        requestSignature: context.config.requestSignature,
      };
    }),

  'machine.revoke-token': async ({ principal, context }) => {
    await context.services.database.withOwner(principal.owner, (tx) =>
      revokeMachine(tx, principal.machineId),
    );
    await announceRevoked(context.services.events, principal.owner, principal.machineId);
    await announceChange(context.services.events, principal.owner);
    return {};
  },

  'machine.set-catalog': async ({ input, principal, context }) => {
    await context.services.database.withOwner(principal.owner, (tx) =>
      storeDocument(tx, principal.machineId, 'catalog', {
        document: input.catalog,
        index: input.index,
      }),
    );
    await announceChange(context.services.events, principal.owner);
    return {};
  },

  'machine.set-usage': async ({ input, principal, context }) => {
    await context.services.database.withOwner(principal.owner, (tx) =>
      storeDocument(tx, principal.machineId, 'usage', {
        document: input.usage,
        index: input.index,
      }),
    );
    await announceChange(context.services.events, principal.owner);
    return {};
  },

  'machine.set-feeds': async ({ input, principal, context }) => {
    await context.services.database.withOwner(principal.owner, (tx) =>
      storeDocument(tx, principal.machineId, 'feeds', {
        document: input.feeds,
        index: input.index,
      }),
    );
    await announceChange(context.services.events, principal.owner);
    return {};
  },

  'machine.ack-feed-requests': async ({ input, principal, context }) => {
    await context.services.database.withOwner(principal.owner, (tx) =>
      ackFeedRequests(tx, principal.machineId, input.requests),
    );
    await announceChange(context.services.events, principal.owner);
    return {};
  },

  'machine.list-machines': ({ principal, context }) =>
    context.services.database.withOwner(principal.owner, async (tx) => ({
      machines: (await listActiveMachines(tx)).map((row) => ({
        name: row.name,
        lastSeenAt: isoOrNull(row.lastSeenAt),
        current: row.name === principal.machineId,
      })),
    })),

  'machine.get-agents': ({ principal, context }) =>
    context.services.database.withOwner(principal.owner, async (tx) => {
      const stored = await readDocument(tx, 'agents');
      return {
        agents: stored === null ? null : { version: stored.version, document: stored.document },
      };
    }),

  'machine.set-agents': async ({ input, principal, context }) => {
    await context.services.database.withOwner(principal.owner, (tx) =>
      saveDocument(tx, 'agents', input),
    );
    await announceChange(context.services.events, principal.owner);
    return {};
  },

  'machine.get-title-rules': ({ principal, context }) =>
    context.services.database.withOwner(principal.owner, async (tx) => {
      const stored = await readDocument(tx, 'titles');
      return {
        titleRules: stored === null ? null : { version: stored.version, document: stored.document },
      };
    }),

  'machine.apply-title-rule': async ({ input, principal, context }) => {
    const applied = await context.services.database.withOwner(principal.owner, (tx) =>
      applyTitleRule(tx, input),
    );
    await announceTaskChange(context.services.events, principal.owner);
    return applied;
  },

  'machine.transcript': async ({ input, principal, context }) => {
    const appended = await context.services.database.withOwner(principal.owner, (tx) =>
      appendTranscript(tx, principal.machineId, {
        taskId: input.id,
        runId: input.runId,
        startedAt: input.startedAt,
        sessionId: input.sessionId,
        resumed: input.resumed,
        events: input.events,
      }),
    );
    if (appended.contextProjectId !== null)
      await announceTaskChange(context.services.events, principal.owner, appended.contextProjectId);
    return {};
  },
});
