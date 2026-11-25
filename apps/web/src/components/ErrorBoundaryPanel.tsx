import { Alert, Button, Stack } from '@mantine/core';
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  readonly onReload: () => void;
  readonly resetKey?: string;
  readonly children: ReactNode;
}

interface State {
  readonly failed: boolean;
  readonly resetKey: string | undefined;
}

export class ErrorBoundaryPanel extends Component<Props, State> {
  override state: State = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: Props, state: State): State | null {
    return props.resetKey === state.resetKey ? null : { failed: false, resetKey: props.resetKey };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <Stack p="md" maw={520}>
        <Alert color="red" title="Something went wrong">
          This page stopped working. Reloading usually fixes it.
        </Alert>
        <Button onClick={this.props.onReload}>Reload</Button>
      </Stack>
    );
  }
}
