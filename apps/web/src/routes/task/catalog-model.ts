export interface Skill {
  readonly name: string;
  readonly description: string | null;
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function parseSkills(value: unknown): Skill[] {
  if (!Array.isArray(value)) return [];
  const skills: Skill[] = [];
  for (const entry of value) {
    const { name, description } = record(entry);
    if (typeof name !== 'string' || name === '') continue;
    skills.push({
      name,
      description: typeof description === 'string' && description !== '' ? description : null,
    });
  }
  return skills;
}

export function skillsOf(source: string, directoryPath: string | null): readonly Skill[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return [];
  }
  const catalog = record(parsed);
  const own = directoryPath === null ? [] : parseSkills(record(catalog.dirs)[directoryPath]);
  const merged = new Map<string, Skill>();
  for (const skill of [...parseSkills(catalog.skills), ...own]) merged.set(skill.name, skill);
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function matchSkills(skills: readonly Skill[], query: string): readonly Skill[] {
  const wanted = query.toLowerCase();
  return skills.filter((skill) => skill.name.toLowerCase().startsWith(wanted));
}

export interface SlashToken {
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

export function slashTokenAt(value: string, caret: number): SlashToken | null {
  const before = value.slice(0, caret);
  const match = /(^|\s)\/([^\s/]*)$/.exec(before);
  if (match === null) return null;
  const query = match[2] ?? '';
  return { start: caret - query.length - 1, end: caret, query };
}
