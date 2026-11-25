import { Alert, Box, Stack, Text, Title, VisuallyHidden } from '@mantine/core';
import type { TaskStatus } from '@agent-board/contract';
import { useCallback, useMemo, useState, type ReactNode } from 'react';

import { useBoardActions, useBoardData, type BoardData } from './board-data.js';
import type { CardEditValue } from './CardEditDialog.js';
import {
  openPrompt,
  sealIcon,
  sealLabels,
  sealPromptAsUser,
  type BoardCard,
  type OpenedPrompt,
} from './card-model.js';
import { useNow } from './clock.js';
import { canDropOn, groupByStatus, moveFor, type DropTarget, type MoveRequest } from './columns.js';
import { ColumnView } from './ColumnView.js';
import { BoardDnd } from './drag.js';
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
  readonly data: BoardData;
}): ReactNode {
  const { data, only } = props;
  const actions = useBoardActions(data);
  const now = useNow();
  const [pending, setPending] = useState<PendingStart | null>(null);
  const cards = useMemo(() => data.cards ?? [], [data.cards]);
  const groups = useMemo(() => groupByStatus(cards), [cards]);
  const showProjects = data.projectNames !== null && data.projectNames.size > 1;

  const usageHoldFor = useCallback(
    (card: BoardCard): number | null => {
      for (const machine of data.machines) {
        const until = machine.heldUntil.get(card.task.id);
        if (until !== undefined) return until;
      }
      return null;
    },
    [data.machines],
  );

  const onDrop = useCallback(
    async (activeId: string, target: DropTarget): Promise<void> => {
      const card = cards.find((candidate) => candidate.task.id === activeId);
      if (card === undefined || !canDropOn(target.status)) return;
      const move = moveFor(activeId, target, groups[target.status]);
      if (move === null) return;
      if (card.task.proposed && card.task.status === 'backlog' && target.status === 'todo') {
        const prompt = await openPrompt(data.keys, card.task);
        if (prompt !== null) {
          setPending({ card, move, prompt });
          return;
        }
      }
      await actions.move(move);
    },
    [cards, groups, data.keys, actions],
  );

  const onEdit = useCallback(
    async (card: BoardCard, value: CardEditValue): Promise<void> => {
      const id = card.task.id;
      await actions.configure({
        id,
        ...(value.icon === undefined
          ? {}
          : { icon: value.icon === null ? null : await sealIcon(data.keys, id, value.icon) }),
        ...(value.labels === undefined
          ? {}
          : {
              labels: value.labels === null ? null : await sealLabels(data.keys, id, value.labels),
            }),
      });
    },
    [actions, data.keys],
  );

  const merged = groups['needs-me'].filter(isMergedOnly);
  const moveMerged = async (): Promise<void> => {
    for (const card of merged) await actions.done(card.task.id);
  };

  const start = async (text: string): Promise<void> => {
    if (pending === null) return;
    const { card, move, prompt } = pending;
    setPending(null);
    const startInput = await sealPromptAsUser(data.keys, card.task.id, prompt.shape, text);
    await actions.move({ ...move, startInput });
  };

  const columns = LAYOUT.map((stack) =>
    stack.filter((status) => only === undefined || only.includes(status)),
  ).filter((stack) => stack.length > 0);

  return (
    <Stack gap="sm">
      {data.refreshFailed ? (
        <Alert role="alert" color="orange" variant="light">
          {REFRESH_WARNING}
        </Alert>
      ) : null}
      <CliBanner data={data} />
      {data.cards === undefined && !data.refreshFailed ? (
        <Text c="dimmed" size="sm">
          Loading the board…
        </Text>
      ) : null}
      <BoardDnd onDrop={(id, target) => void onDrop(id, target)}>
        <Box
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
                  projectNames={data.projectNames}
                  showProjects={showProjects}
                  usageHoldFor={usageHoldFor}
                  onEdit={(card, value) => void onEdit(card, value)}
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

export function BoardView(props: {
  readonly heading: string;
  readonly only?: readonly TaskStatus[];
}): ReactNode {
  const data = useBoardData();
  return (
    <>
      <VisuallyHidden>
        <Title order={1}>{props.heading}</Title>
      </VisuallyHidden>
      {data === null ? null : (
        <Board data={data} {...(props.only === undefined ? {} : { only: props.only })} />
      )}
    </>
  );
}
