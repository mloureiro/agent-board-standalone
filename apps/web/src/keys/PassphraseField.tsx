import { TextInput } from '@mantine/core';
import type { ReactNode } from 'react';

export function PassphraseField(props: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly autoComplete: 'current-password' | 'new-password';
  readonly autoFocus?: boolean;
}): ReactNode {
  return (
    <TextInput
      type="password"
      label={props.label}
      value={props.value}
      onChange={(event) => props.onChange(event.currentTarget.value)}
      autoComplete={props.autoComplete}
      {...(props.autoFocus === true ? { 'data-autofocus': true } : {})}
    />
  );
}
