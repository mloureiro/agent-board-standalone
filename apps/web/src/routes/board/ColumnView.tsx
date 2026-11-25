import { Button, Group, Paper, Stack, Text } from '@mantine/core';
import type { TaskStatus } from '@agent-board/contract';
import type { ReactNode } from 'react';

import { CardView } from './CardView.js';
import type { CardEditValue } from './CardEditDialog.js';
import { cardUid, type BoardCard } from './card-model.js';
import { COLUMN_LABELS, canDropOn } from './columns.js';
import { useColumnDrop } from './drag.js';

export interface ColumnViewProps {
  readonly status: TaskStatus;
  readonly cards: readonly BoardCard[];
  readonly now: number;
  readonly projectNameFor: (card: BoardCard) => string | null;
  readonly serverNameFor: (card: BoardCard) => string | null;
  readonly usageHoldFor: (card: BoardCard) => number | null;
  readonly onEdit: (card: BoardCard, value: CardEditValue) => void;
  readonly mergedCount?: number;
  readonly onMoveMerged?: () => void;
}

export function ColumnView(props: ColumnViewProps): ReactNode {
  const { status, cards, now, projectNameFor, serverNameFor, usageHoldFor, onEdit } = props;
  const drop = useColumnDrop(status, canDropOn(status));
  const label = COLUMN_LABELS[status];
  const idle = status === 'waiting' && cards.length === 0;
  return (
    <Paper
      component="section"
      aria-label={`${label} ${cards.length}`}
      ref={drop.setNodeRef}
      withBorder
      p="xs"
      radius="md"
      data-column={status}
      data-over={drop.isOver ? 'true' : undefined}
      style={{
        minHeight: idle ? 0 : 120,
        opacity: idle ? 0.6 : 1,
        background: drop.isOver ? 'var(--mantine-color-blue-light)' : undefined,
      }}
    >
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap">
          <Text fw={600} size="sm">
            {label}
          </Text>
          <Text size="sm" c="dimmed">
            {cards.length}
          </Text>
        </Group>
        {props.mergedCount === undefined || props.mergedCount === 0 ? null : (
          <Button variant="light" size="compact-xs" onClick={props.onMoveMerged}>
            Move merged to Done ({props.mergedCount})
          </Button>
        )}
        {cards.map((card) => (
          <CardView
            key={cardUid(card)}
            card={card}
            now={now}
            projectName={projectNameFor(card)}
            serverName={serverNameFor(card)}
            usageHoldUntil={usageHoldFor(card)}
            onEdit={(value) => onEdit(card, value)}
          />
        ))}
      </Stack>
    </Paper>
  );
}
