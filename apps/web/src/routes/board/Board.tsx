import { Alert, Box, Stack, Text } from '@mantine/core';
import type { TaskStatus } from '@agent-board/contract';
import { useCallback, useMemo, useState, type ReactNode } from 'react';

import { useBoardActions, usePromptOf, type BoardData } from './board-data.js';
import type { CardEditValue } from './CardEditDialog.js';
import {
  cardUid,
  sealIcon,
  sealLabels,
  sealPromptAsUser,
  type BoardCard,
  type OpenedPrompt,
} from './card-model.js';
import { useNow } from './clock.js';
import { canDropOn, groupByStatus, moveFor, type DropTarget, type MoveRequest } from './columns.js';
import { ColumnView } from './ColumnView.js';
import { BoardDnd, selectionReleased } from './drag.js';
import { isMergedOnly } from './badges.js';
import { ProposalStartDialog } from './ProposalStartDialog.js';

export const REFRESH_WARNING =
  'Could not refresh the board. Showing the last cards received; retrying.';

const LAYOUT: readonly (readonly TaskStatus[])[] = [
  ['backlog'],
  ['waiting', 'todo'],
  ['running'],
  ['needs-me'],
  ['done'],
];

interface PendingStart {
  readonly source: BoardData;
  readonly card: BoardCard;
  readonly move: MoveRequest;
  readonly prompt: OpenedPrompt;
}

export function CliBanner(props: { readonly data: BoardData }): ReactNode {
  const names = props.data.machines.filter((machine) => machine.incompatible).map((m) => m.name);
  if (names.length === 0) return null;
  return (
    <Alert role="alert" color="yellow" variant="light" title="CLI no longer accepted">
      The CLI on {names.join(', ')} is no longer accepted by this server. Update it on{' '}
      {names.length === 1 ? 'that machine' : 'those machines'} so it can take tasks again.
    </Alert>
  );
}

export function Board(props: {
  readonly only?: readonly TaskStatus[];
  readonly sources: readonly BoardData[];
  readonly showServers?: boolean;
}): ReactNode {
  const { sources, only } = props;
  const actions = useBoardActions();
  const promptOf = usePromptOf();
  const now = useNow();
  const [pending, setPending] = useState<PendingStart | null>(null);
  const several = props.showServers === true || sources.length > 1;
  const cards = useMemo(() => sources.flatMap((source) => source.cards ?? []), [sources]);
  const groups = useMemo(() => groupByStatus(cards), [cards]);
  const sourceOf = useCallback(
    (card: BoardCard): BoardData | undefined =>
      sources.find((source) => source.serverId === card.serverId) ?? sources[0],
    [sources],
  );

  const projectNameFor = useCallback(
    (card: BoardCard): string | null => {
      const names = sourceOf(card)?.projectNames ?? null;
      return names !== null && names.size > 1 ? (names.get(card.task.projectId) ?? null) : null;
    },
    [sourceOf],
  );
  const serverNameFor = useCallback(
    (card: BoardCard): string | null => (several ? (sourceOf(card)?.serverName ?? null) : null),
    [several, sourceOf],
  );

  const usageHoldFor = useCallback(
    (card: BoardCard): number | null => {
      for (const machine of sourceOf(card)?.machines ?? []) {
        const until = machine.heldUntil.get(card.task.id);
        if (until !== undefined) return until;
      }
      return null;
    },
    [sourceOf],
  );

  const onDrop = useCallback(
    async (activeId: string, target: DropTarget): Promise<void> => {
      const card = cards.find((candidate) => cardUid(candidate) === activeId);
      const source = card === undefined ? undefined : sourceOf(card);
      if (card === undefined || source === undefined || !canDropOn(target.status)) return;
      const sameServer = (other: BoardCard): boolean => other.serverId === card.serverId;
      const requested = moveFor(activeId, target, groups[target.status].filter(sameServer));
      if (requested === null) return;
      const anchor = (uid: string | undefined): string | undefined =>
        cards.find((other) => cardUid(other) === uid && sameServer(other))?.task.id;
      const beforeId = anchor(requested.beforeId);
      const afterId = anchor(requested.afterId);
      const move: MoveRequest = {
        id: card.task.id,
        status: requested.status,
        ...(beforeId === undefined ? {} : { beforeId }),
        ...(afterId === undefined ? {} : { afterId }),
      };
      if (card.task.proposed && card.task.status === 'backlog' && target.status === 'todo') {
        const [prompt] = await Promise.all([promptOf(source, card), selectionReleased()]);
        if (prompt !== null) {
          setPending({ card, move, prompt, source });
          return;
        }
      }
      await actions.move(source, move);
    },
    [cards, groups, sourceOf, actions, promptOf],
  );

  const editCard = useCallback(
    async (card: BoardCard, value: CardEditValue): Promise<void> => {
      const source = sourceOf(card);
      if (source === undefined) return;
      const id = card.task.id;
      await actions.configure(source, {
        id,
        ...(value.icon === undefined
          ? {}
          : { icon: value.icon === null ? null : await sealIcon(source.keys, id, value.icon) }),
        ...(value.labels === undefined
          ? {}
          : {
              labels:
                value.labels === null ? null : await sealLabels(source.keys, id, value.labels),
            }),
      });
    },
    [actions, sourceOf],
  );
  const onEdit = useCallback(
    (card: BoardCard, value: CardEditValue): void => void editCard(card, value),
    [editCard],
  );

  const merged = groups['needs-me'].filter(isMergedOnly);
  const moveMerged = async (): Promise<void> => {
    for (const card of merged) {
      const source = sourceOf(card);
      if (source !== undefined) await actions.done(source, card.task.id);
    }
  };

  const start = async (text: string): Promise<void> => {
    if (pending === null) return;
    const { card, move, prompt, source } = pending;
    setPending(null);
    const startInput = await sealPromptAsUser(source.keys, card.task.id, prompt.shape, text);
    await actions.move(source, { ...move, startInput });
  };

  const columns = LAYOUT.map((stack) =>
    stack.filter((status) => only === undefined || only.includes(status)),
  ).filter((stack) => stack.length > 0);

  return (
    <Stack gap="sm">
      {sources.some((source) => source.refreshFailed) ? (
        <Alert role="alert" color="orange" variant="light">
          {REFRESH_WARNING}
        </Alert>
      ) : null}
      {sources.map((source) => (
        <CliBanner key={source.serverId} data={source} />
      ))}
      {sources.every((source) => source.cards === undefined && !source.refreshFailed) ? (
        <Text c="dimmed" size="sm">
          Loading the board…
        </Text>
      ) : null}
      <BoardDnd onDrop={(id, target) => void onDrop(id, target)}>
        <Box
          tabIndex={0}
          style={{
            display: 'grid',
            gridAutoFlow: 'column',
            gridAutoColumns: 'minmax(240px, 1fr)',
            gap: 'var(--mantine-spacing-sm)',
            overflowX: 'auto',
            alignItems: 'start',
          }}
        >
          {columns.map((stack) => (
            <Stack key={stack.join('+')} gap="sm">
              {stack.map((status) => (
                <ColumnView
                  key={status}
                  status={status}
                  cards={groups[status]}
                  now={now}
                  projectNameFor={projectNameFor}
                  serverNameFor={serverNameFor}
                  usageHoldFor={usageHoldFor}
                  onEdit={onEdit}
                  {...(status === 'needs-me'
                    ? { mergedCount: merged.length, onMoveMerged: () => void moveMerged() }
                    : {})}
                />
              ))}
            </Stack>
          ))}
        </Box>
      </BoardDnd>
      <ProposalStartDialog
        proposal={
          pending === null
            ? null
            : { id: pending.card.task.id, title: pending.card.title, text: pending.prompt.text }
        }
        onClose={() => setPending(null)}
        onStart={(text) => void start(text)}
      />
    </Stack>
  );
}
