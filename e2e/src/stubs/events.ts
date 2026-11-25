export const SUBAGENT_USAGE_TOKENS = 4_321;
export const DEFAULT_MAIN_USAGE = { input: 10, output: 5 } as const;

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export type StreamEvent = Record<string, unknown>;

export function usageOf(input: number, output = 0): Usage {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

export function addUsage(total: Usage, extra: Usage): Usage {
  return {
    input_tokens: total.input_tokens + extra.input_tokens,
    output_tokens: total.output_tokens + extra.output_tokens,
    cache_creation_input_tokens:
      total.cache_creation_input_tokens + extra.cache_creation_input_tokens,
    cache_read_input_tokens: total.cache_read_input_tokens + extra.cache_read_input_tokens,
  };
}

export function initEvent(sessionId: string): StreamEvent {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model: 'stub',
    tools: [],
    cwd: process.cwd(),
  };
}

export function assistantText(
  sessionId: string,
  text: string,
  usage: Usage,
  parentToolUseId: string | null = null,
): StreamEvent {
  return {
    type: 'assistant',
    session_id: sessionId,
    parent_tool_use_id: parentToolUseId,
    message: { role: 'assistant', content: [{ type: 'text', text }], usage },
  };
}

export function toolUse(
  sessionId: string,
  id: string,
  name: string,
  input: Record<string, unknown>,
): StreamEvent {
  return {
    type: 'assistant',
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id, name, input }],
      usage: usageOf(0),
    },
  };
}

export function toolResult(sessionId: string, id: string, content: string): StreamEvent {
  return {
    type: 'user',
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
  };
}

export function resultEvent(
  sessionId: string,
  outcome: { ok: true; usage: Usage; text: string } | { ok: false; usage: Usage; error: string },
): StreamEvent {
  return {
    type: 'result',
    subtype: outcome.ok ? 'success' : 'error_during_execution',
    is_error: !outcome.ok,
    session_id: sessionId,
    result: outcome.ok ? outcome.text : outcome.error,
    usage: outcome.usage,
  };
}

export function userText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) =>
      typeof block === 'object' &&
      block !== null &&
      'text' in block &&
      typeof block.text === 'string'
        ? block.text
        : '',
    )
    .join('\n');
}

export function messageText(line: string): string {
  try {
    const parsed = JSON.parse(line) as { message?: { content?: unknown }; content?: unknown };
    return userText(parsed.message?.content ?? parsed.content ?? '');
  } catch {
    return line;
  }
}
