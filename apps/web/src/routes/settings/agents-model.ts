export interface SharedAgent {
  readonly name: string;
  readonly description: string | null;
  readonly details: readonly string[];
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const detailsOf = (agent: Record<string, unknown>): string[] => {
  const details: string[] = [];
  if (typeof agent.model === 'string' && agent.model !== '') details.push(`Model ${agent.model}`);
  if (Array.isArray(agent.tools)) {
    const tools = agent.tools.filter((tool): tool is string => typeof tool === 'string');
    if (tools.length > 0) details.push(`Tools ${tools.join(', ')}`);
  }
  return details;
};

const agentOf = (name: unknown, value: unknown): SharedAgent | null => {
  const agent = record(value);
  const label = typeof name === 'string' ? name : agent.name;
  if (typeof label !== 'string' || label === '') return null;
  const description = agent.description;
  return {
    name: label,
    description: typeof description === 'string' && description !== '' ? description : null,
    details: detailsOf(agent),
  };
};

export const parseSharedAgents = (text: string | null): readonly SharedAgent[] => {
  if (text === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const holder = record(parsed);
  const list = Array.isArray(parsed) ? parsed : (holder.agents ?? holder);
  const entries: [unknown, unknown][] = Array.isArray(list)
    ? list.map((entry): [unknown, unknown] => [undefined, entry])
    : Object.entries(record(list));
  return entries.flatMap(([name, value]) => agentOf(name, value) ?? []);
};
