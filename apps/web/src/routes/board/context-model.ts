import type { UiRunContext } from '@rumo/contract';
import { bindings, open, type Keys } from '@rumo/sealing';

export const CONTEXT_FEATURE = 'context-usage';
export const AUTO_COMPACT_PERCENT = 80;

export interface ContextUsage {
  readonly used: number;
  readonly window: number;
  readonly percent: number;
}

const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

export async function readContext(
  keys: Keys,
  taskId: string,
  context: UiRunContext | null,
): Promise<ContextUsage | null> {
  if (context === null) return null;
  try {
    const text = await open(
      keys,
      bindings.transcript({ field: 'tr.data', taskId, runId: context.runId, seq: context.seq }),
      context.data,
    );
    const body: unknown = JSON.parse(text);
    if (body === null || typeof body !== 'object') return null;
    const { used, window } = body as { used?: unknown; window?: unknown };
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || !positive(window))
      return null;
    return { used, window, percent: Math.min(100, Math.round((used / window) * 1000) / 10) };
  } catch {
    return null;
  }
}

export const tokensText = (tokens: number): string =>
  tokens >= 1000 ? `${Math.round(tokens / 100) / 10}k`.replace('.0k', 'k') : String(tokens);
