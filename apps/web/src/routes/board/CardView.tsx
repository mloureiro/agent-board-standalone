import { ActionIcon, Anchor, Badge, Group, Menu, Paper, Stack, Text } from '@mantine/core';
import { useMediaQuery, useMergedRef } from '@mantine/hooks';
import { memo, useCallback, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';

import { badgesOf, prSummaries, prText } from './badges.js';
import { CardEditDialog, type CardEdit, type CardEditValue } from './CardEditDialog.js';
import { iconLabel } from '../../components/icon-label.js';
import { useServers } from '../../servers/index.js';
import { cardUid, type BoardCard } from './card-model.js';
import { canDragFrom, canDropOn } from './columns.js';
import { useCardDrag } from './drag.js';
import { agoText, parseTime } from './format.js';
import { ContextLine } from './ContextLine.js';

export const COARSE_QUERY = '(pointer: coarse)';

export interface CardViewProps {
  readonly card: BoardCard;
  readonly now: number;
  readonly projectName: string | null;
  readonly serverName: string | null;
  readonly usageHoldUntil: number | null;
  readonly onEdit: (card: BoardCard, value: CardEditValue) => void;
}

function CardViewBase(props: CardViewProps): ReactNode {
  const { card, now, projectName, serverName, usageHoldUntil, onEdit } = props;
  const { active, select } = useServers();
  const { task } = card;
  const drag = useCardDrag(
    cardUid(card),
    task.status,
    canDragFrom(task.status),
    canDropOn(task.status),
  );
  const hoverRef = useRef<HTMLElement | null>(null);
  const ref = useMergedRef(drag.setNodeRef, hoverRef);
  const coarse = useMediaQuery(COARSE_QUERY, false, { getInitialValueInEffect: false }) ?? false;
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [editing, setEditing] = useState<CardEdit | null>(null);

  const save = useCallback((value: CardEditValue) => onEdit(card, value), [onEdit, card]);

  const badges = badgesOf(card, { now, usageHoldUntil });
  const prs = prSummaries(card);
  const activeAt = parseTime(task.lastActiveAt);
  const liveness =
    task.status !== 'running'
      ? null
      : task.stopRequested === true
        ? 'Stopping'
        : activeAt === null
          ? 'No activity yet'
          : `Active ${agoText(activeAt, now)}`;

  return (
    <>
      <Paper
        component="article"
        ref={ref}
        withBorder
        p="xs"
        radius="sm"
        data-open-question={task.openQuestion ? 'true' : undefined}
        style={{
          ...drag.style,
          borderColor: task.openQuestion ? 'var(--mantine-color-orange-6)' : undefined,
          borderWidth: task.openQuestion ? 2 : undefined,
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocusCapture={() => setFocused(true)}
        onBlurCapture={() => setFocused(false)}
        {...drag.listeners}
      >
        <Stack gap={4}>
          <Group gap="xs" wrap="nowrap" align="flex-start" justify="space-between">
            <Group gap="xs" wrap="nowrap" align="flex-start" style={{ minWidth: 0 }}>
              {card.icon === null ? null : (
                <span role="img" aria-label={iconLabel(card.icon)}>
                  {card.icon}
                </span>
              )}
              <Anchor
                component={Link}
                to={`/tasks/${task.id}`}
                draggable={false}
                fw={600}
                size="sm"
                lh={1.3}
                onClick={() => {
                  if (card.serverId !== undefined && card.serverId !== active?.id)
                    select(card.serverId);
                }}
              >
                {card.title}
              </Anchor>
            </Group>
            {coarse ? (
              <Menu position="bottom-end" withinPortal>
                <Menu.Target>
                  <ActionIcon variant="subtle" size="sm" aria-label="Card actions">
                    ⋯
                  </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown>
                  <Menu.Item onClick={() => setEditing('icon')}>Change icon</Menu.Item>
                  <Menu.Item onClick={() => setEditing('labels')}>Change labels</Menu.Item>
                </Menu.Dropdown>
              </Menu>
            ) : (
              <Group
                gap={2}
                wrap="nowrap"
                data-shown={hovered || focused ? 'true' : 'false'}
                style={{ opacity: hovered || focused ? 1 : 0 }}
              >
                <ActionIcon
                  variant="subtle"
                  size="sm"
                  aria-label="Change icon"
                  onClick={() => setEditing('icon')}
                >
                  ☺
                </ActionIcon>
                <ActionIcon
                  variant="subtle"
                  size="sm"
                  aria-label="Change labels"
                  onClick={() => setEditing('labels')}
                >
                  #
                </ActionIcon>
              </Group>
            )}
          </Group>
          {prs.length === 0 ? null : (
            <Group gap={6}>
              {prs.map((summary) => (
                <Text key={summary.state} size="xs" c="dimmed" data-pr-state={summary.state}>
                  {prText(summary)}
                </Text>
              ))}
            </Group>
          )}
          {badges.length === 0 ? null : (
            <Group gap={4}>
              {badges.map((badge) => (
                <Badge
                  key={`${badge.kind}:${badge.label}`}
                  size="sm"
                  variant="light"
                  color={badge.color}
                  tt="none"
                  title={badge.title}
                  data-badge={badge.kind}
                >
                  {badge.label}
                </Badge>
              ))}
            </Group>
          )}
          {liveness === null ? null : (
            <Text size="xs" c="dimmed">
              {liveness}
            </Text>
          )}
          {card.context === null ? null : <ContextLine usage={card.context} />}
          {card.note === null ? null : (
            <Text size="xs" c="dimmed" lineClamp={1}>
              {card.note}
            </Text>
          )}
          {projectName === null ? null : (
            <Text size="xs" c="dimmed">
              {projectName}
            </Text>
          )}
          {serverName === null ? null : (
            <Text size="xs" c="dimmed">
              {serverName}
            </Text>
          )}
        </Stack>
      </Paper>
      <CardEditDialog card={card} edit={editing} onClose={() => setEditing(null)} onSave={save} />
    </>
  );
}

export const CardView = memo(CardViewBase);
