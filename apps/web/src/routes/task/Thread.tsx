import { Badge, Box, Button, Group, Paper, Stack, Text } from '@mantine/core';
import { useEffect, useRef, type ReactNode } from 'react';

import { Markdown } from '../../components/index.js';
import { agoText, parseTime } from '../board/format.js';
import type { PolishRewrite, PolishState } from './action-model.js';
import { describeValue, type ThreadEntry } from './task-model.js';

export interface PolishSupport {
  stateOf(entry: ThreadEntry): PolishState;
  apply(entry: ThreadEntry, rewrite: PolishRewrite): void;
}

const AUTHOR_LABELS = { user: 'You', agent: 'Agent', system: 'System', server: 'Server' } as const;
const KIND_LABELS = {
  comment: null,
  question: 'Question',
  answer: 'Answer',
  event: 'Event',
  polish: 'Polish suggestion',
} as const;

const parseJson = (source: string): unknown => {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    return source;
  }
};

function Questions(props: { readonly source: string }): ReactNode {
  const parsed = parseJson(props.source);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return (
    <Stack gap={4}>
      {list.map((entry, index) => {
        const body =
          entry !== null && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
        const question = typeof body.question === 'string' ? body.question : describeValue(entry);
        const options = Array.isArray(body.options) ? body.options : [];
        return (
          <Box key={index}>
            <Text size="sm" fw={600}>
              {typeof body.header === 'string' ? `${body.header}: ` : ''}
              {question}
            </Text>
            {options.length > 0 ? (
              <Box component="ul" m={0} pl="lg">
                {options.map((option: unknown, at) => {
                  const choice =
                    option !== null && typeof option === 'object'
                      ? (option as Record<string, unknown>)
                      : { label: option };
                  return (
                    <li key={at}>
                      <Text size="sm" span>
                        {describeValue(choice.label)}
                        {typeof choice.description === 'string' ? ` — ${choice.description}` : ''}
                      </Text>
                    </li>
                  );
                })}
              </Box>
            ) : null}
          </Box>
        );
      })}
    </Stack>
  );
}

function answersText(source: string): string {
  const parsed = parseJson(source);
  if (!Array.isArray(parsed)) return describeValue(parsed);
  return parsed
    .map((entry: unknown, index) => {
      const body =
        entry !== null && typeof entry === 'object' ? (entry as Record<string, unknown>) : null;
      if (body === null || !Array.isArray(body.picks)) return describeValue(entry);
      const given = [
        body.picks.map(describeValue).join(', '),
        typeof body.other === 'string' ? body.other : '',
      ]
        .filter((part) => part !== '')
        .join('; ');
      return `${index + 1}. ${given === '' ? '(none)' : given}`;
    })
    .join('\n');
}

function deliveryLabel(entry: ThreadEntry): string | null {
  const { note } = entry;
  if (note.author !== 'user') return null;
  if (note.queued === true) return 'Queued';
  if (note.pending === true) return 'Sending';
  if (note.deliveredAt !== undefined) return 'Delivered';
  return null;
}

function PolishBody(props: {
  readonly entry: ThreadEntry;
  readonly polish: PolishSupport;
}): ReactNode {
  const { entry, polish } = props;
  const state = polish.stateOf(entry);
  if (!state.usable) {
    return (
      <Stack gap={4}>
        <Markdown>{entry.body ?? ''}</Markdown>
        <Text size="xs" c="dimmed">
          {state.reason}
        </Text>
      </Stack>
    );
  }
  return (
    <Stack gap="xs">
      <Text size="sm" fw={600}>
        {state.rewrite.title}
      </Text>
      <Markdown>{state.rewrite.prompt}</Markdown>
      <Group>
        <Button size="xs" onClick={() => polish.apply(entry, state.rewrite)}>
          Apply polished prompt
        </Button>
      </Group>
    </Stack>
  );
}

function NoteView(props: {
  readonly entry: ThreadEntry;
  readonly now: number;
  readonly polish: PolishSupport | null;
}): ReactNode {
  const { entry, now, polish } = props;
  const { note } = entry;
  const kind = KIND_LABELS[note.kind];
  const delivery = deliveryLabel(entry);
  const created = parseTime(note.createdAt);
  const event = note.kind === 'event';
  return (
    <Paper
      component="article"
      withBorder={!event}
      p="xs"
      radius="md"
      aria-label={`${AUTHOR_LABELS[note.author]} note`}
      data-author={note.author}
      data-kind={note.kind}
    >
      <Group gap="xs" mb={4}>
        <Text size="xs" fw={600}>
          {note.by ?? AUTHOR_LABELS[note.author]}
        </Text>
        {kind === null ? null : (
          <Badge size="xs" variant="light">
            {kind}
          </Badge>
        )}
        {delivery === null ? null : (
          <Badge size="xs" variant="outline" color="gray">
            {delivery}
          </Badge>
        )}
        {created === null ? null : (
          <Text size="xs" c="dimmed">
            {agoText(created, now)}
          </Text>
        )}
      </Group>
      {entry.body === null ? (
        <Text size="sm" c="dimmed">
          This note could not be read.
        </Text>
      ) : event ? (
        <Text size="sm" c="dimmed">
          {entry.body}
        </Text>
      ) : note.kind === 'polish' && polish !== null ? (
        <PolishBody entry={entry} polish={polish} />
      ) : (
        <Markdown>{entry.body}</Markdown>
      )}
      {entry.questions === null ? null : <Questions source={entry.questions} />}
      {entry.answers === null ? null : (
        <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
          {answersText(entry.answers)}
        </Text>
      )}
    </Paper>
  );
}

export function Thread(props: {
  readonly entries: readonly ThreadEntry[];
  readonly now: number;
  readonly polish?: PolishSupport | null;
}): ReactNode {
  const { entries, now, polish = null } = props;
  const end = useRef<HTMLDivElement>(null);
  const seen = useRef(entries.length);
  useEffect(() => {
    if (entries.length > seen.current) end.current?.scrollIntoView({ block: 'end' });
    seen.current = entries.length;
  }, [entries.length]);
  return (
    <Box component="section" aria-label="Thread">
      <Stack gap="xs">
        {entries.length === 0 ? (
          <Text size="sm" c="dimmed">
            No notes yet.
          </Text>
        ) : null}
        {entries.map((entry) => (
          <NoteView key={entry.note.id} entry={entry} now={now} polish={polish} />
        ))}
        <div ref={end} />
      </Stack>
    </Box>
  );
}
