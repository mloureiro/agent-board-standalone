import { Checkbox, Group, Paper, Stack, Text, TextInput } from '@mantine/core';
import { useState, type ReactNode } from 'react';

import { linkTargets, parseLinkRules } from '../../components/index.js';
import {
  linkProblem,
  parseLinkDrafts,
  serializeLinkDrafts,
  type LinkRuleDraft,
} from './link-rules-model.js';
import { notOffered } from '../../servers/index.js';
import { RulesFooter } from './RulesFooter.js';
import { useRulesEditor, useRulesLoad, type RulesLoad } from './use-rules-document.js';
import type { LoadedDocument } from '../../pages/index.js';
import { ActionIcon } from '@mantine/core';

export const NO_LINK_RULES = notOffered('link-rules');
const BLANK: LinkRuleDraft = { pattern: '', url: '', ignoreCase: false };
const CODEC = { parse: parseLinkDrafts, serialize: serializeLinkDrafts };

function TryIt(props: { readonly rules: readonly LinkRuleDraft[] }): ReactNode {
  const [sample, setSample] = useState('');
  const valid = parseLinkRules(serializeLinkDrafts(props.rules));
  const targets = sample === '' ? [] : linkTargets(sample, valid);
  return (
    <Stack gap="xs">
      <TextInput
        label="Try it"
        description="Type some text a task might contain."
        value={sample}
        onChange={(event) => setSample(event.currentTarget.value)}
      />
      {sample === '' ? null : targets.length === 0 ? (
        <Text size="sm" c="dimmed">
          No rule matches this text.
        </Text>
      ) : (
        <Stack gap={2} component="ul" aria-label="Matches" p={0} m={0}>
          {targets.map((target, index) => (
            <Text
              component="li"
              size="sm"
              key={`${target.text}-${index}`}
              style={{ listStyle: 'none' }}
            >
              {target.text} → {target.url}
            </Text>
          ))}
        </Stack>
      )}
    </Stack>
  );
}

function Editor(props: {
  readonly load: RulesLoad & { readonly loaded: LoadedDocument };
}): ReactNode {
  const editor = useRulesEditor('links', props.load, CODEC);
  const { rules } = editor;
  const problems = rules.map(linkProblem);
  const update = (index: number, change: Partial<LinkRuleDraft>): void =>
    editor.change(rules.map((rule, at) => (at === index ? { ...rule, ...change } : rule)));
  return (
    <Stack gap="sm" maw={720}>
      <Text>
        A link rule turns text such as a ticket number into a link in task text. The URL may use $1
        to $9, $&lt;name&gt; and $&amp; from the match.
      </Text>
      {rules.length === 0 ? <Text c="dimmed">There are no link rules.</Text> : null}
      {rules.map((rule, index) => (
        <Paper key={index} withBorder p="sm" component="section" aria-label={`Rule ${index + 1}`}>
          <Stack gap="xs">
            <TextInput
              label={`Pattern ${index + 1}`}
              value={rule.pattern}
              error={rule.pattern === '' && rule.url === '' ? null : problems[index]}
              onChange={(event) => update(index, { pattern: event.currentTarget.value })}
            />
            <TextInput
              label={`URL ${index + 1}`}
              value={rule.url}
              onChange={(event) => update(index, { url: event.currentTarget.value })}
            />
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

export function LinksPanel(): ReactNode {
  const load = useRulesLoad('links', 'link-rules');
  if (load.page !== null && !load.offered) return <Text c="dimmed">{NO_LINK_RULES}</Text>;
  if (load.failed) return <Text c="dimmed">The link rules could not be loaded.</Text>;
  if (load.loaded === undefined) return null;
  return <Editor key={load.loaded.version} load={{ ...load, loaded: load.loaded }} />;
}
