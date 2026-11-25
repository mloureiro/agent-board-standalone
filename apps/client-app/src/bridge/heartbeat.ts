import { isHomeLabel, type Report } from './routing.js';

export const HEARTBEAT_MS = 5000;

export interface HeartbeatOptions {
  readonly target: Window;
  readonly label: string;
  readonly report: Report;
}

export function installHeartbeat({ target, label, report }: HeartbeatOptions): () => void {
  if (!isHomeLabel(label)) return () => undefined;
  const timer = target.setInterval(() => {
    report('page_heartbeat', {}).catch(() => undefined);
  }, HEARTBEAT_MS);
  return () => target.clearInterval(timer);
}
