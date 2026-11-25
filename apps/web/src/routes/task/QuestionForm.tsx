import {
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  Group,
  Kbd,
  Radio,
  Stack,
  Text,
  Textarea,
} from '@mantine/core';
import { useEffect, useRef, useState, type ReactNode } from 'react';

import { useDraftStore } from '../../drafts/index.js';
import {
  isAnswered,
  restoreAnswerDraft,
  serializeAnswerDraft,
  toAnswers,
  togglePick,
  typeOther,
  type Answer,
  type Choice,
  type Question,
} from './question-model.js';

const NUMBER_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) &&
  !(target instanceof HTMLInputElement && ['radio', 'checkbox'].includes(target.type));

const overlayOpen = (): boolean => document.querySelector('[role="dialog"]') !== null;

export interface QuestionFormProps {
  readonly noteId: string;
  readonly questions: readonly Question[];
  readonly source: string;
  readonly draftName: string;
  readonly handover: string;
  readonly focusNote: boolean;
  readonly busy: boolean;
  readonly onSubmit: (
    questions: readonly Question[],
    answers: readonly Answer[],
    note: string,
  ) => void;
  readonly onDismiss: () => void;
}

function Changed(props: {
  readonly onShow: () => void;
  readonly onDismiss: () => void;
  readonly busy: boolean;
}): ReactNode {
  return (
    <Stack>
      <Alert color="red" title="The question changed">
        <Text size="sm">
          The server now serves other questions under the one you were answering. An agent&apos;s
          question is never edited, so the server may be misleading you. Your picks were dropped and
          nothing was sent. Read the changed questions carefully before you answer, or leave the
          task alone.
        </Text>
      </Alert>
      <Group justify="flex-end">
        <Button variant="default" onClick={props.onDismiss} disabled={props.busy}>
          Dismiss
        </Button>
        <Button variant="default" onClick={props.onShow}>
          Show the changed questions
        </Button>
      </Group>
    </Stack>
  );
}

function Fields(props: QuestionFormProps): ReactNode {
  const { questions, busy } = props;
  const drafts = useDraftStore();
  const [restored] = useState(() =>
    restoreAnswerDraft(questions, drafts?.read(props.draftName, props.source) ?? null),
  );
  const [choices, setChoices] = useState<readonly Choice[]>(restored.choices);
  const [note, setNote] = useState(props.handover === '' ? (restored.note ?? '') : props.handover);
  const [active, setActive] = useState(0);
  const noteField = useRef<HTMLTextAreaElement>(null);
  const ready = choices.every(
    (choice, index) => questions[index]?.multiSelect === true || isAnswered(choice),
  );

  useEffect(() => {
    if (props.focusNote) {
      const field = noteField.current;
      field?.focus();
      field?.setSelectionRange(field.value.length, field.value.length);
    }
  }, [props.focusNote]);

  useEffect(() => {
    const serialized = serializeAnswerDraft(choices, note);
    if (serialized === '') drafts?.clear(props.draftName);
    else drafts?.write(props.draftName, serialized, props.source);
  }, [drafts, props.draftName, props.source, choices, note]);

  const update = (index: number, change: (current: Choice) => Choice): void =>
    setChoices((all) => all.map((choice, at) => (at === index ? change(choice) : choice)));

  const pick = (index: number, label: string): void => {
    const question = questions[index];
    if (question === undefined) return;
    setActive(index);
    update(index, (current) => togglePick(question, current, label));
    if (!question.multiSelect && index < questions.length - 1) setActive(index + 1);
  };

  const submit = (): void => {
    if (ready && !busy) props.onSubmit(questions, toAnswers(choices), note);
  };

  const latest = useRef({ pick, submit, active });
  latest.current = { pick, submit, active };
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (overlayOpen() || event.defaultPrevented) return;
      const { pick: choose, submit: send, active: at } = latest.current;
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        send();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      const position = NUMBER_KEYS.indexOf(event.key);
      const option = position === -1 ? undefined : questions[at]?.options[position];
      if (option !== undefined) {
        event.preventDefault();
        choose(at, option.label);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [questions]);

  return (
    <Stack
      component="form"
      aria-label="Question"
      gap="sm"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {questions.map((question, index) => {
        const choice = choices[index] ?? { picks: [], other: '' };
        const Control = question.multiSelect ? Checkbox : Radio;
        return (
          <Box
            key={index}
            component="fieldset"
            m={0}
            p="xs"
            style={{
              border: '1px solid var(--mantine-color-default-border)',
              borderRadius: 'var(--mantine-radius-sm)',
              minWidth: 0,
            }}
            onFocusCapture={() => setActive(index)}
            onPointerDown={() => setActive(index)}
          >
            <Text component="legend" size="sm" fw={600} px={4}>
              {question.question}
            </Text>
            <Stack gap={6}>
              {question.header === '' ? null : (
                <Badge variant="light" tt="none" w="fit-content">
                  {question.header}
                </Badge>
              )}
              {question.options.map((option, at) => (
                <Control
                  key={option.label}
                  name={`question-${index}`}
                  checked={choice.picks.includes(option.label)}
                  onChange={() => pick(index, option.label)}
                  onClick={
                    !question.multiSelect && choice.picks.includes(option.label)
                      ? () => pick(index, option.label)
                      : undefined
                  }
                  label={
                    <>
                      {option.label}
                      {option.recommended ? (
                        <Badge size="xs" color="teal" variant="light" ml={6}>
                          Recommended
                        </Badge>
                      ) : null}
                      {active === index && at < NUMBER_KEYS.length ? (
                        <Kbd size="xs" ml={6}>
                          {at + 1}
                        </Kbd>
                      ) : null}
                      {option.description === null ? null : (
                        <Text size="xs" c="dimmed" component="span" display="block">
                          {option.description}
                        </Text>
                      )}
                    </>
                  }
                />
              ))}
              <Textarea
                aria-label="Other"
                size="xs"
                autosize
                minRows={1}
                placeholder={
                  question.multiSelect || choice.picks.length === 0
                    ? 'Other…'
                    : 'Other… (replaces your choice)'
                }
                value={choice.other}
                onChange={(event) => {
                  const other = event.currentTarget.value;
                  update(index, (current) => typeOther(question, current, other));
                }}
              />
            </Stack>
          </Box>
        );
      })}
      <Textarea
        ref={noteField}
        aria-label="Note"
        autosize
        minRows={2}
        maxRows={8}
        placeholder="Anything else the agent should know (optional)"
        value={note}
        onChange={(event) => setNote(event.currentTarget.value)}
      />
      <Group justify="space-between" wrap="wrap">
        <Text size="xs" c="dimmed">
          Number keys pick an option. <Kbd size="xs">Ctrl</Kbd>+<Kbd size="xs">Enter</Kbd> sends.
        </Text>
        <Group gap="xs">
          <Button type="button" variant="default" onClick={props.onDismiss} disabled={busy}>
            Dismiss
          </Button>
          <Button type="submit" disabled={!ready || busy}>
            Submit answer
          </Button>
        </Group>
      </Group>
    </Stack>
  );
}

export function QuestionForm(props: QuestionFormProps): ReactNode {
  const [shown, setShown] = useState(props.source);
  const [round, setRound] = useState(0);
  if (shown !== props.source) {
    return (
      <Changed
        busy={props.busy}
        onDismiss={props.onDismiss}
        onShow={() => {
          setShown(props.source);
          setRound((current) => current + 1);
        }}
      />
    );
  }
  return <Fields key={round} {...props} />;
}
