import { Alert, Button, Group, Modal, Stack, Text } from '@mantine/core';
import { useState, type ReactNode } from 'react';

import { useNow } from '../board/clock.js';
import { agoText, parseTime } from '../board/format.js';
import {
  canTakeBack,
  currentSuggestion,
  isProposal,
  openQuestionOf,
  panelKind,
} from './action-model.js';
import type { Skill } from './catalog-model.js';
import { PinnedPanel } from './PinnedPanel.js';
import { QuestionForm } from './QuestionForm.js';
import { ReplyBox } from './ReplyBox.js';
import type { TaskActions } from './task-data.js';
import type { TaskView } from './task-model.js';

const PLACEHOLDERS = {
  running:
    'Message the running agent. It gets it at its next tool call, without being interrupted.',
  backlog: 'Add to the thread',
  todo: 'Add to the thread before it starts',
  reply: 'Steer the agent: a follow-up, a correction, a new instruction…',
} as const;

function TakeBack(props: { readonly onConfirm: () => void; readonly machine: string | null }) {
  const [asking, setAsking] = useState(false);
  return (
    <>
      <Button variant="default" color="red" size="xs" onClick={() => setAsking(true)}>
        Take back
      </Button>
      <Modal opened={asking} onClose={() => setAsking(false)} title="Take the task back?">
        <Stack>
          <Text size="sm">
            The agent has been quiet for a while, so {props.machine ?? 'its worker'} may be off. The
            task moves to Needs me. If the worker is still alive, its result is dropped.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setAsking(false)}>
              Cancel
            </Button>
            <Button
              color="red"
              onClick={() => {
                setAsking(false);
                props.onConfirm();
              }}
            >
              Take back
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

export function ActionPanel(props: {
  readonly view: TaskView;
  readonly actions: TaskActions;
  readonly skills: readonly Skill[];
  readonly onStartProposal: () => void;
}): ReactNode {
  const { view, actions, skills } = props;
  const { task } = view;
  const now = useNow(10_000);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [replyFocused, setReplyFocused] = useState(false);
  const [handover, setHandover] = useState<{ text: string; focus: boolean } | null>(null);
  const question = openQuestionOf(view);
  const kind = panelKind(task);
  const proposal = isProposal(task);
  const hasText = message.trim() !== '';

  if (question !== null && message !== '') {
    setHandover({ text: message, focus: replyFocused });
    setMessage('');
  } else if (question === null && handover !== null) {
    setHandover(null);
  }

  const run = async (call: () => Promise<boolean>, clear = false): Promise<void> => {
    setBusy(true);
    try {
      if ((await call()) && clear) setMessage('');
    } finally {
      setBusy(false);
    }
  };

  if (question !== null) {
    return (
      <PinnedPanel label="Task actions">
        {question.questions === null ? (
          <Stack>
            <Alert color="orange" title="The question cannot be read">
              The agent asked something this browser cannot read. Dismissing it drops the question
              without an answer.
            </Alert>
            <Group justify="flex-end">
              <Button
                variant="default"
                disabled={busy}
                onClick={() => void run(() => actions.dismiss(question.noteId))}
              >
                Dismiss
              </Button>
            </Group>
          </Stack>
        ) : (
          <QuestionForm
            key={question.noteId}
            noteId={question.noteId}
            questions={question.questions}
            source={question.source}
            handover={handover?.text ?? ''}
            focusNote={handover?.focus ?? false}
            busy={busy}
            onSubmit={(questions, answers, note) =>
              void run(() => actions.answer(question.noteId, questions, answers, note))
            }
            onDismiss={() => void run(() => actions.dismiss(question.noteId))}
          />
        )}
      </PinnedPanel>
    );
  }

  if (kind === 'closed') {
    return (
      <PinnedPanel label="Task actions">
        <Group justify="space-between">
          <Text size="sm" c="dimmed">
            This task is closed. Workers ignore it.
          </Text>
          <Button
            variant="default"
            disabled={busy}
            onClick={() => void run(() => actions.setClosed(false))}
          >
            Reopen
          </Button>
        </Group>
      </PinnedPanel>
    );
  }

  const notBefore = parseTime(task.notBefore);
  const delayedUntil = kind === 'todo' && notBefore !== null && notBefore > now ? notBefore : null;
  const stoppable = !proposal && kind === 'todo' && task.next === 'resume';
  const quiet = canTakeBack(task, now);
  const suggestion = kind === 'reply' ? currentSuggestion(view) : null;
  const sendLabel = kind === 'running' ? 'Send' : 'Send & continue';

  const comment = (
    <Button
      variant="default"
      disabled={!hasText || busy}
      onClick={() => void run(() => actions.reply(message, false), true)}
    >
      Comment
    </Button>
  );

  const primary = (): void => {
    if (!hasText || busy) return;
    if (kind === 'running') void run(() => actions.send(message), true);
    else if (kind === 'reply' && !proposal) void run(() => actions.reply(message, true), true);
    else void run(() => actions.reply(message, false), true);
  };

  const header = (
    <Stack gap={6}>
      {proposal ? (
        <Alert color="grape" variant="light" title="Proposed by an agent">
          <Group justify="space-between" wrap="wrap">
            <Text size="sm">
              Nothing runs until you start it, which shows you its whole prompt first.
            </Text>
            <Group gap="xs">
              <Button size="xs" color="grape" disabled={busy} onClick={props.onStartProposal}>
                Start
              </Button>
              <Button
                size="xs"
                variant="default"
                disabled={busy}
                onClick={() => void run(() => actions.setClosed(true))}
              >
                Discard
              </Button>
            </Group>
          </Group>
        </Alert>
      ) : null}
      {kind === 'running' ? (
        <Group justify="space-between" wrap="wrap">
          <Text size="sm">
            Running{task.machine === null ? '' : ` on ${task.machine}`}
            {parseTime(task.lastActiveAt) === null
              ? ''
              : `, last active ${agoText(parseTime(task.lastActiveAt) ?? now, now)}`}
            . It reports back here when it is done or has a question.
          </Text>
          {quiet ? (
            <TakeBack machine={task.machine} onConfirm={() => void run(actions.takeBack)} />
          ) : null}
        </Group>
      ) : null}
      {kind === 'backlog' && !proposal ? (
        <Group justify="space-between" wrap="wrap">
          <Text size="sm">Parked. No worker takes it until you move it to Todo.</Text>
          <Button size="xs" disabled={busy} onClick={() => void run(() => actions.move('todo'))}>
            Move to Todo
          </Button>
        </Group>
      ) : null}
      {kind === 'todo' && !proposal ? (
        <Group justify="space-between" wrap="wrap">
          <Text size="sm">
            {delayedUntil !== null
              ? `Delayed until ${new Date(delayedUntil).toLocaleString()}.`
              : task.paused
                ? 'Paused to free its slot.'
                : 'Queued.'}{' '}
            {task.next === 'resume'
              ? `The next run resumes the agent's session${task.machine === null ? '' : ` on ${task.machine}`}.`
              : 'The next free worker starts it.'}
          </Text>
          <Group gap="xs">
            {delayedUntil !== null ? (
              <Button size="xs" disabled={busy} onClick={() => void run(actions.runNow)}>
                Run now
              </Button>
            ) : null}
            {stoppable ? (
              <Button
                size="xs"
                variant="default"
                disabled={busy}
                onClick={() => void run(() => actions.stop())}
              >
                Stop
              </Button>
            ) : null}
          </Group>
        </Group>
      ) : null}
      {task.status === 'waiting' && !proposal ? (
        <Group justify="space-between" wrap="wrap">
          <Text size="sm">
            {task.waitCheck ? 'Waiting for a check to pass' : 'Waiting'}
            {task.wakeAt === null ? '' : `, until ${new Date(task.wakeAt).toLocaleString()}`}. Its
            slot is free. Send &amp; continue ends the wait with your reply.
          </Text>
          <Group gap="xs">
            <Button size="xs" disabled={busy} onClick={() => void run(actions.wakeNow)}>
              Wake now
            </Button>
            <Button
              size="xs"
              variant="default"
              disabled={busy}
              onClick={() => void run(() => actions.stop())}
            >
              Stop
            </Button>
          </Group>
        </Group>
      ) : null}
    </Stack>
  );

  let footer: ReactNode;
  if (kind === 'running') {
    footer = (
      <Group gap="xs" wrap="wrap">
        <Button disabled={!hasText || busy} onClick={primary}>
          Send
        </Button>
        <Button
          variant="default"
          disabled={!hasText || busy}
          onClick={() => void run(() => actions.stop(message), true)}
        >
          Stop &amp; send
        </Button>
        <Button variant="default" disabled={busy} onClick={() => void run(() => actions.stop())}>
          Stop
        </Button>
        {comment}
      </Group>
    );
  } else if (kind === 'reply' && !proposal) {
    footer = (
      <Group gap="xs" wrap="wrap">
        <Button disabled={!hasText || busy} onClick={primary}>
          {sendLabel}
        </Button>
        <Button
          variant="default"
          disabled={task.status === 'done' || busy}
          onClick={() => void run(actions.done)}
        >
          Mark done
        </Button>
        <Button variant="default" disabled={busy} onClick={() => void run(actions.rerun)}>
          Re-run fresh
        </Button>
        {comment}
        <Button
          variant="default"
          disabled={busy}
          onClick={() => void run(() => actions.move('backlog'))}
        >
          Move to Backlog
        </Button>
        <Button
          variant="default"
          color="red"
          disabled={busy}
          onClick={() => void run(() => actions.setClosed(true))}
        >
          Close
        </Button>
      </Group>
    );
  } else {
    footer = <Group gap="xs">{comment}</Group>;
  }

  return (
    <PinnedPanel label="Task actions">
      {header}
      <div onFocus={() => setReplyFocused(true)} onBlur={() => setReplyFocused(false)}>
        <ReplyBox
          value={message}
          onChange={setMessage}
          onSubmit={primary}
          placeholder={PLACEHOLDERS[kind]}
          suggestion={suggestion}
          skills={skills}
          minRows={kind === 'reply' ? 3 : 2}
        />
      </div>
      {footer}
    </PinnedPanel>
  );
}
