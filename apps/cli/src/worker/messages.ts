export const SHUTDOWN_NOTICE =
  'The machine is shutting down. Pause now: finish the step you are on and end your turn; this task resumes later.';

export const LANE_PAUSE_NOTICE =
  'This task is asked to pause: its lane needs the slot for other work. Post a short status with `rumo comment`, then finish the step you are on and end your turn. The task resumes later.';

export function userMessage(text: string): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`;
}

export function inboxMessageText(text: string): string {
  return `The user sent you a message while you work:\n\n${text}`;
}

export function lanePauseReport(machine: string, lane: string): string {
  return `Paused on ${machine}: its ${lane} lane needed the slot for its own work. Resumes next, on ${machine}.`;
}

export const SHUTDOWN_PAUSE_REPORT = 'rumo: paused because the machine shut down; it resumes later';

export const BOARD_RULES = [
  'You run unattended inside rumo, a task board.',
  'Report to the board with the `rumo` command (see `rumo --help`): `rumo ask` to ask the user a question, `rumo comment` to leave a note.',
  'Messages that start with "rumo:" or that the user sends while you work come from the board; follow them.',
].join('\n');
