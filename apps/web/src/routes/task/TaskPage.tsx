import { Alert, Button, Group, Paper, Stack, Text, Title } from '@mantine/core';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useParams } from 'react-router';

import { LinkRulesProvider, Markdown, usePageTitle } from '../../components/index.js';
import { ProposalStartDialog } from '../board/ProposalStartDialog.js';
import { useNow } from '../board/clock.js';
import { ActionPanel } from './ActionPanel.js';
import { canEditPrompt, canFork, polishState, type PolishRewrite } from './action-model.js';
import { PullRequests, WatchesList } from './Attachments.js';
import { Configuration, DirectorySection } from './Configuration.js';
import { useTaskActions, useTaskData, type TaskData } from './task-data.js';
import { TaskHeader } from './TaskHeader.js';
import { EditPromptDialog, ForkDialog, PolishDialog } from './PromptDialogs.js';
import { Thread, type PolishSupport } from './Thread.js';
import type { ThreadEntry } from './task-model.js';
import { TranscriptDrawer } from './TranscriptDrawer.js';

const LIVE_STATUSES = ['running', 'waiting'];

const isEditable = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

function TaskBody(props: { readonly id: string; readonly data: TaskData }): ReactNode {
  const { id, data } = props;
  const { view } = data;
  const actions = useTaskActions(data, id);
  const now = useNow();
  const [transcript, setTranscript] = useState(false);
  const [forking, setForking] = useState(false);
  const [editing, setEditing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [polishing, setPolishing] = useState<{ rewrite: PolishRewrite; noteId: string } | null>(
    null,
  );
  usePageTitle(view?.title ?? 'Task');

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Backspace' && !isEditable(event.target)) event.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const polish = useMemo<PolishSupport | null>(
    () =>
      view === undefined
        ? null
        : {
            stateOf: (entry: ThreadEntry) => polishState(view, entry),
            apply: (entry: ThreadEntry, rewrite: PolishRewrite) =>
              setPolishing({ rewrite, noteId: entry.note.id }),
          },
    [view],
  );

  if (data.notFound) {
    return (
      <Alert role="alert" color="red" variant="light" title="Task not found">
        This task does not exist or was removed.
      </Alert>
    );
  }
  if (view === undefined) {
    return data.failure === null ? (
      <Text c="dimmed" size="sm">
        Loading the task…
      </Text>
    ) : (
      <Alert role="alert" color="orange" variant="light">
        Could not load the task. {data.failure}
      </Alert>
    );
  }

  const projectName =
    data.projects.find((project) => project.id === view.task.projectId)?.name ?? null;
  const hasTranscripts = data.features.includes('transcripts');

  return (
    <Stack gap="md" style={{ marginBottom: 'calc(-1 * var(--mantine-spacing-md))' }}>
      <TaskHeader
        view={view}
        projectName={projectName}
        actions={actions}
        extra={
          <Group gap="xs">
            {canEditPrompt(view) ? (
              <Button size="xs" variant="default" onClick={() => setEditing(true)}>
                Edit prompt
              </Button>
            ) : null}
            {canFork(view, data.features) ? (
              <Button size="xs" variant="default" onClick={() => setForking(true)}>
                Fork
              </Button>
            ) : null}
            {hasTranscripts ? (
              <Button size="xs" variant="default" onClick={() => setTranscript(true)}>
                Transcript
              </Button>
            ) : null}
          </Group>
        }
      />
      {data.failure === null ? null : (
        <Alert role="alert" color="orange" variant="light">
          Could not refresh the task. Showing the last version received; retrying.
        </Alert>
      )}
      {view.alerts.map((alert) => (
        <Alert key={alert} role="alert" color="yellow" variant="light">
          {alert}
        </Alert>
      ))}
      <Configuration view={view} actions={actions} projects={data.projects} />
      <DirectorySection view={view} directories={data.directories} actions={actions} />
      <PullRequests prs={view.prs} actions={actions} />
      <WatchesList watches={view.watches} actions={actions} />
      {view.prompt === null ? null : (
        <Paper component="section" aria-label="Prompt" withBorder p="sm" radius="md">
          <Title order={2} size="h4" mb="xs">
            Prompt
          </Title>
          <Markdown>{view.prompt}</Markdown>
        </Paper>
      )}
      <Thread entries={view.thread} now={now} polish={polish} />
      {hasTranscripts ? (
        <TranscriptDrawer
          data={data}
          taskId={id}
          live={LIVE_STATUSES.includes(view.task.status)}
          opened={transcript}
          onClose={() => setTranscript(false)}
        />
      ) : null}
      <ActionPanel
        view={view}
        actions={actions}
        skills={data.skills}
        onStartProposal={() => setStarting(true)}
      />
      <ForkDialog opened={forking} onClose={() => setForking(false)} onFork={actions.fork} />
      {canEditPrompt(view) ? (
        <EditPromptDialog
          opened={editing}
          initial={{ title: view.title, text: view.prompt ?? '' }}
          onClose={() => setEditing(false)}
          onSave={actions.editPrompt}
        />
      ) : null}
      <PolishDialog
        rewrite={polishing?.rewrite ?? null}
        parentTitle={view.parent?.title ?? 'the parent task'}
        onClose={() => setPolishing(null)}
        onApply={(rewrite) =>
          actions.applyPolish({
            polishId: polishing?.noteId ?? '',
            title: rewrite.title,
            text: rewrite.prompt,
          })
        }
      />
      <ProposalStartDialog
        proposal={starting ? { title: view.title, text: view.prompt ?? '' } : null}
        onClose={() => setStarting(false)}
        onStart={(text) => {
          setStarting(false);
          void actions.move('todo', text);
        }}
      />
    </Stack>
  );
}

export function TaskPage(): ReactNode {
  const { id } = useParams();
  const data = useTaskData(id ?? '');
  if (id === undefined || data === null) return null;
  return (
    <LinkRulesProvider rules={data.linkRules}>
      <TaskBody key={id} id={id} data={data} />
    </LinkRulesProvider>
  );
}
