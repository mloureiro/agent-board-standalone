import { ActionIcon, Checkbox, Group, Paper, Stack, Text, TextInput } from '@mantine/core';
import { useState, type ReactNode } from 'react';

import type { LoadedDocument } from '../../pages/index.js';
import {
  applyTitleRules,
  parseTitleDrafts,
  serializeTitleDrafts,
  titleProblem,
  type TitleRuleDraft,
} from './title-rules-model.js';
import { notOffered } from '../../servers/index.js';
import { RulesFooter } from './RulesFooter.js';
import { useRulesEditor, useRulesLoad, type RulesLoad } from './use-rules-document.js';

export const NO_TITLE_RULES = notOffered('title-rules');
const BLANK: TitleRuleDraft = { pattern: '', ignoreCase: false, title: '', icon: '', labels: '' };
const CODEC = { parse: parseTitleDrafts, serialize: serializeTitleDrafts };

function TryIt(props: { readonly rules: readonly TitleRuleDraft[] }): ReactNode {
  const [sample, setSample] = useState('');
  const outcome = sample === '' ? null : applyTitleRules(sample, props.rules);
  return (
    <Stack gap="xs">
      <TextInput
        label="Try it"
        description="Type a task title."
        value={sample}
        onChange={(event) => setSample(event.currentTarget.value)}
      />
      {sample === '' ? null : outcome === null ? (
        <Text size="sm" c="dimmed">
          No rule matches this title.
        </Text>
      ) : (
        <Text size="sm" role="status">
          Title: {outcome.title ?? 'unchanged'}. Icon: {outcome.icon ?? 'none'}. Labels:{' '}
          {outcome.labels.length === 0 ? 'none' : outcome.labels.join(', ')}.
        </Text>
      )}
    </Stack>
  );
}

function Editor(props: {
  readonly load: RulesLoad & { readonly loaded: LoadedDocument };
}): ReactNode {
  const editor = useRulesEditor('titles', props.load, CODEC);
  const { rules } = editor;
  const problems = rules.map(titleProblem);
  const update = (index: number, change: Partial<TitleRuleDraft>): void =>
    editor.change(rules.map((rule, at) => (at === index ? { ...rule, ...change } : rule)));
  return (
    <Stack gap="sm" maw={720}>
      <Text>
        A title rule sets a title, an icon or labels on a task whose title matches. It only fills in
        what the task does not have yet.
      </Text>
      {rules.length === 0 ? <Text c="dimmed">There are no title rules.</Text> : null}
      {rules.map((rule, index) => (
        <Paper key={index} withBorder p="sm" component="section" aria-label={`Rule ${index + 1}`}>
          <Stack gap="xs">
            <TextInput
              label={`Pattern ${index + 1}`}
              value={rule.pattern}
              error={rule === BLANK ? null : problems[index]}
              onChange={(event) => update(index, { pattern: event.currentTarget.value })}
            />
            <TextInput
              label={`New title ${index + 1}`}
              value={rule.title}
              onChange={(event) => update(index, { title: event.currentTarget.value })}
            />
            <Group grow>
              <TextInput
                label={`Icon ${index + 1}`}
                value={rule.icon}
                onChange={(event) => update(index, { icon: event.currentTarget.value })}
              />
              <TextInput
                label={`Labels ${index + 1}`}
                value={rule.labels}
                onChange={(event) => update(index, { labels: event.currentTarget.value })}
              />
            </Group>
            <Group justify="space-between">
              <Checkbox
                label={`Ignore case ${index + 1}`}
                checked={rule.ignoreCase}
                onChange={(event) => update(index, { ignoreCase: event.currentTarget.checked })}
              />
              <ActionIcon
                variant="default"
                aria-label={`Remove rule ${index + 1}`}
                onClick={() => editor.change(rules.filter((_, at) => at !== index))}
              >
                ×
              </ActionIcon>
            </Group>
          </Stack>
        </Paper>
      ))}
      <RulesFooter
        editor={editor}
        invalid={problems.some((problem) => problem !== null)}
        onAdd={() => editor.change([...rules, BLANK])}
      />
      <TryIt rules={rules} />
    </Stack>
  );
}

export function TitlesPanel(): ReactNode {
  const load = useRulesLoad('titles', 'title-rules');
  if (load.page !== null && !load.offered) return <Text c="dimmed">{NO_TITLE_RULES}</Text>;
  if (load.failed) return <Text c="dimmed">The title rules could not be loaded.</Text>;
  if (load.loaded === undefined) return null;
  return <Editor key={load.loaded.version} load={{ ...load, loaded: load.loaded }} />;
}
