export const STREAM_MAX_EVENTS = 50;
export const STREAM_MAX_BYTES = 20 * 1024;
export const STREAM_WINDOW_MS = 10 * 60_000;

interface Reported {
  readonly at: number;
  readonly bytes: number;
}

export class StreamBudget {
  private reported: Reported[] = [];

  record(atMs: number, bytes: number): 'ok' | 'exceeded' {
    this.reported = this.reported.filter((entry) => atMs - entry.at < STREAM_WINDOW_MS);
    this.reported.push({ at: atMs, bytes });
    const total = this.reported.reduce((sum, entry) => sum + entry.bytes, 0);
    return this.reported.length > STREAM_MAX_EVENTS || total > STREAM_MAX_BYTES ? 'exceeded' : 'ok';
  }
}
