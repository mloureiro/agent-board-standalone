import {
  clientTranscriptEventsRoute,
  clientTranscriptOutputRoute,
  clientTranscriptRunsRoute,
  type WireTranscriptRun,
} from '@rumo/contract';
import { bindings, open } from '@rumo/sealing';
import { Box, Code, Drawer, Stack, Text, UnstyledButton } from '@mantine/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { callRoute } from '../../auth/api.js';
import { Markdown } from '../../components/index.js';
import { useServers } from '../../servers/index.js';
import { boardKey } from '../board/board-data.js';
import type { TaskData } from './task-data.js';
import {
  UNREADABLE_EVENT,
  buildItems,
  decodeEvent,
  mergeEvents,
  type DecodedEvent,
  type ToolItem,
  type TranscriptItem,
} from './transcript-model.js';

export const TRANSCRIPT_POLL_MS = 3_000;

const runLabel = (run: WireTranscriptRun): string =>
  `${new Date(run.startedAt).toLocaleString()} on ${run.machine}, ${run.eventCount} events${run.resumed ? ', resumed' : ''}`;

function useRunEvents(data: TaskData, taskId: string, run: string | null, live: boolean) {
  const { clientOf } = useServers();
  const queryClient = useQueryClient();
  const key = [...boardKey(data.serverId, data.keys.keyId), 'transcript', taskId, run ?? ''];
  return useQuery({
    queryKey: key,
    enabled: run !== null,
    refetchInterval: live ? TRANSCRIPT_POLL_MS : false,
    queryFn: async (): Promise<DecodedEvent[]> => {
      const client = clientOf(data.serverId);
      if (client === null || run === null) return [];
      let known = queryClient.getQueryData<DecodedEvent[]>(key) ?? [];
      for (;;) {
        const last = known.at(-1);
        const answer = await callRoute(
          client,
          clientTranscriptEventsRoute,
          last === undefined ? { runId: run } : { runId: run, afterSeq: String(last.seq) },
        );
        const fresh = answer.events.filter((event) => last === undefined || event.seq > last.seq);
        if (fresh.length === 0) return known;
        const decoded = await Promise.all(
          fresh.map((event) => decodeEvent(data.keys, taskId, run, event)),
        );
        known = mergeEvents(known, decoded);
        queryClient.setQueryData(key, known);
      }
    },
  });
}

function ToolOutput(props: {
  readonly data: TaskData;
  readonly taskId: string;
  readonly runId: string;
  readonly seq: number;
}): ReactNode {
  const { data, taskId, runId, seq } = props;
  const { clientOf } = useServers();
  const output = useQuery({
    queryKey: [...boardKey(data.serverId, data.keys.keyId), 'output', taskId, runId, seq],
    queryFn: async (): Promise<string | null> => {
      const client = clientOf(data.serverId);
      if (client === null) return null;
      const answer = await callRoute(client, clientTranscriptOutputRoute, {
        runId,
        seq: String(seq),
      });
      if (answer.output === null) return null;
      try {
        return await open(
          data.keys,
          bindings.transcript({ field: 'tr.output', taskId, runId, seq }),
          answer.output,
        );
      } catch {
        return UNREADABLE_EVENT;
      }
    },
  });
  if (output.isPending) return <Text size="xs">Loading output…</Text>;
  if (output.isError) return <Text size="xs">The output could not be loaded.</Text>;
  if (output.data === null) return <Text size="xs">No output was recorded.</Text>;
  return <Code block>{output.data}</Code>;
}

const inputLine = (input: unknown): string => {
  if (input === null || typeof input !== 'object' || Object.keys(input).length === 0) return '';
  const line = JSON.stringify(input);
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
};

function ToolCall(props: {
  readonly tool: ToolItem;
  readonly data: TaskData;
  readonly taskId: string;
  readonly runId: string;
}): ReactNode {
  const { tool, data, taskId, runId } = props;
  const [opened, setOpened] = useState(false);
  const summary = inputLine(tool.input);
  return (
    <Stack gap={4}>
      <UnstyledButton
        onClick={() => setOpened((current) => !current)}
        aria-expanded={opened}
        fz="sm"
        ff="monospace"
      >
        {opened ? '▾' : '▸'} {tool.name}
        {summary === '' ? '' : ` ${summary}`}
        {tool.result?.failed === true ? ' (failed)' : ''}
      </UnstyledButton>
      {opened ? (
        <Box ml="md">
          <Code block>{JSON.stringify(tool.input, null, 2)}</Code>
          {tool.result?.hasOutput === true ? (
            <ToolOutput data={data} taskId={taskId} runId={runId} seq={tool.result.seq} />
          ) : (
            <Text size="xs">No output was recorded.</Text>
          )}
        </Box>
      ) : null}
    </Stack>
  );
}

function Items(props: {
  readonly items: readonly TranscriptItem[];
  readonly data: TaskData;
  readonly taskId: string;
  readonly runId: string;
}): ReactNode {
  const { items, data, taskId, runId } = props;
  return (
    <Stack gap="xs">
      {items.map((item) => {
        if (item.type === 'text') {
          return (
            <Box key={item.seq} data-kind={item.kind}>
              {item.kind === 'thinking' ? (
                <Text size="sm" c="dimmed" fs="italic">
                  {item.text}
                </Text>
              ) : (
                <Markdown>{item.text}</Markdown>
              )}
            </Box>
          );
        }
        if (item.subagent) {
          const label = item.description ?? item.name;
          return (
            <Box
              key={item.seq}
              role="group"
              aria-label={`Subagent: ${label}`}
              pl="sm"
              style={{ borderLeft: '2px solid var(--mantine-color-default-border)' }}
            >
              <Text size="xs" c="dimmed">
                Subagent: {label}
              </Text>
              <Items items={item.children} data={data} taskId={taskId} runId={runId} />
            </Box>
          );
        }
        return <ToolCall key={item.seq} tool={item} data={data} taskId={taskId} runId={runId} />;
      })}
    </Stack>
  );
}

function Events(props: {
  readonly data: TaskData;
  readonly taskId: string;
  readonly runId: string;
  readonly live: boolean;
}): ReactNode {
  const { data, taskId, runId, live } = props;
  const events = useRunEvents(data, taskId, runId, live);
  if (events.isPending) return <Text size="sm">Loading the run…</Text>;
  if (events.isError) return <Text size="sm">The run could not be loaded.</Text>;
  const items = buildItems(events.data);
  if (items.length === 0) return <Text size="sm">This run has no events yet.</Text>;
  return <Items items={items} data={data} taskId={taskId} runId={runId} />;
}

export function TranscriptDrawer(props: {
  readonly data: TaskData;
  readonly taskId: string;
  readonly live: boolean;
  readonly opened: boolean;
  readonly onClose: () => void;
}): ReactNode {
  const { data, taskId, live, opened, onClose } = props;
  const { clientOf } = useServers();
  const [chosen, setChosen] = useState<string | null>(null);
  const runs = useQuery({
    queryKey: [...boardKey(data.serverId, data.keys.keyId), 'runs', taskId],
    enabled: opened,
    refetchInterval: live ? TRANSCRIPT_POLL_MS : false,
    queryFn: async (): Promise<readonly WireTranscriptRun[]> => {
      const client = clientOf(data.serverId);
      if (client === null) return [];
      return (await callRoute(client, clientTranscriptRunsRoute, { id: taskId })).runs;
    },
  });
  const list = useMemo(
    () => [...(runs.data ?? [])].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt)),
    [runs.data],
  );
  const known = chosen !== null && list.some((run) => run.id === chosen);
  const selected = known ? chosen : (list.at(-1)?.id ?? null);

  useEffect(() => {
    if (!opened) setChosen(null);
  }, [opened]);

  return (
    <Drawer opened={opened} onClose={onClose} position="right" size="lg" title="Transcript">
      <Stack gap="md">
        {runs.isError ? <Text size="sm">The runs could not be loaded.</Text> : null}
        {runs.isSuccess && list.length === 0 ? (
          <Text size="sm">This task has no recorded runs.</Text>
        ) : null}
        {list.length > 0 ? (
          <Box component="ul" aria-label="Runs" m={0} p={0} style={{ listStyle: 'none' }}>
            {list.map((run) => (
              <li key={run.id}>
                <UnstyledButton
                  w="100%"
                  p="xs"
                  fz="sm"
                  aria-current={run.id === selected ? 'true' : undefined}
                  fw={run.id === selected ? 700 : 400}
                  onClick={() => setChosen(run.id)}
                >
                  {runLabel(run)}
                </UnstyledButton>
              </li>
            ))}
          </Box>
        ) : null}
        {selected === null ? null : (
          <Events
            key={selected}
            data={data}
            taskId={taskId}
            runId={selected}
            live={live && selected === list.at(-1)?.id}
          />
        )}
      </Stack>
    </Drawer>
  );
}
