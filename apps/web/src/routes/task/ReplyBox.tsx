import { Box, Kbd, Text, Textarea, UnstyledButton } from '@mantine/core';
import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

import { matchSkills, slashTokenAt, type Skill } from './catalog-model.js';

export interface ReplyBoxProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly placeholder: string;
  readonly suggestion: string | null;
  readonly skills: readonly Skill[];
  readonly minRows?: number;
}

const isSubmitKey = (event: KeyboardEvent): boolean =>
  event.key === 'Enter' && (event.metaKey || event.ctrlKey);

export function ReplyBox(props: ReplyBoxProps): ReactNode {
  const { value, onChange, onSubmit, placeholder, suggestion, skills } = props;
  const field = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);

  const token = slashTokenAt(value, caret);
  const matches = token === null ? [] : matchSkills(skills, token.query);
  const listed = token !== null && matches.length > 0 && dismissed !== `${token.start}:${value}`;
  const selected = Math.min(active, Math.max(0, matches.length - 1));
  const ghost = value === '' && suggestion !== null;

  const choose = (skill: Skill): void => {
    if (token === null) return;
    const inserted = `/${skill.name} `;
    const next = `${value.slice(0, token.start)}${inserted}${value.slice(token.end)}`;
    const position = token.start + inserted.length;
    onChange(next);
    setCaret(position);
    requestAnimationFrame(() => field.current?.setSelectionRange(position, position));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (isSubmitKey(event)) {
      event.preventDefault();
      onSubmit();
      return;
    }
    if (listed) {
      const picked = matches[selected];
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : matches.length - 1;
        setActive((selected + step) % matches.length);
        return;
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && picked !== undefined) {
        event.preventDefault();
        choose(picked);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setDismissed(`${token.start}:${value}`);
        return;
      }
    }
    if (event.key === 'Tab' && !event.shiftKey && ghost) {
      event.preventDefault();
      onChange(suggestion);
    }
  };

  return (
    <Box>
      {listed ? (
        <Box
          role="listbox"
          aria-label="Skills"
          mb={4}
          style={{
            maxHeight: '30dvh',
            overflowY: 'auto',
            border: '1px solid var(--mantine-color-default-border)',
            borderRadius: 'var(--mantine-radius-sm)',
            background: 'var(--mantine-color-body)',
          }}
        >
          {matches.map((skill, index) => (
            <UnstyledButton
              key={skill.name}
              role="option"
              aria-selected={index === selected}
              tabIndex={-1}
              w="100%"
              px="xs"
              py={4}
              style={
                index === selected
                  ? { background: 'var(--mantine-primary-color-light)' }
                  : undefined
              }
              onMouseDown={(event) => {
                event.preventDefault();
                choose(skill);
              }}
            >
              <Text size="sm" fw={500} span>
                /{skill.name}
              </Text>
              {skill.description === null ? null : (
                <Text size="xs" c="dimmed" span ml="xs">
                  {skill.description}
                </Text>
              )}
            </UnstyledButton>
          ))}
        </Box>
      ) : null}
      <Textarea
        ref={field}
        aria-label="Reply"
        autosize
        minRows={props.minRows ?? 2}
        maxRows={10}
        value={value}
        placeholder={ghost ? suggestion : placeholder}
        onChange={(event) => {
          onChange(event.currentTarget.value);
          setCaret(event.currentTarget.selectionStart);
          setActive(0);
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
      />
      {ghost ? (
        <Text size="xs" c="dimmed" mt={2}>
          <Kbd size="xs">Tab</Kbd> accepts the agent&apos;s suggested reply
        </Text>
      ) : null}
    </Box>
  );
}
