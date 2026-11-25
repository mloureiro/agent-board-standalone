import { Alert, Button, Paper, Stack, Text, Title } from '@mantine/core';
import { useState, type ReactNode } from 'react';
import { useParams } from 'react-router';

import { Markdown, usePageTitle } from '../../components/index.js';
import { useNow } from '../board/clock.js';
import { PullRequests, WatchesList } from './Attachments.js';
import { Configuration, DirectorySection } from './Configuration.js';
import { useTaskActions, useTaskData, type TaskData } from './task-data.js';
import { TaskHeader } from './TaskHeader.js';
import { Thread } from './Thread.js';
import { TranscriptDrawer } from './TranscriptDrawer.js';

const LIVE_STATUSES = ['running', 'waiting'];

function TaskBody(props: { readonly id: string; readonly data: TaskData }): ReactNode {
  const { id, data } = props;
  const { view } = data;
  const actions = useTaskActions(data, id);
  const now = useNow();
  const [transcript, setTranscript] = useState(false);
  usePageTitle(view?.title ?? 'Task');

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
    <Stack gap="md">
      <TaskHeader
        view={view}
        projectName={projectName}
        actions={actions}
        extra={
          hasTranscripts ? (
            <Button size="xs" variant="default" onClick={() => setTranscript(true)}>
              Transcript
            </Button>
          ) : null
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
      <Thread entries={view.thread} now={now} />
      {hasTranscripts ? (
        <TranscriptDrawer
          data={data}
          taskId={id}
          live={LIVE_STATUSES.includes(view.task.status)}
          opened={transcript}
          onClose={() => setTranscript(false)}
        />
      ) : null}
    </Stack>
  );
}

export function TaskPage(): ReactNode {
  const { id } = useParams();
  const data = useTaskData(id ?? '');
  if (id === undefined || data === null) return null;
  return <TaskBody key={id} id={id} data={data} />;
}
