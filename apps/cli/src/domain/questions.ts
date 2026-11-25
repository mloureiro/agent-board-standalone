import { UsageError } from '../errors.js';

export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_HEADER_CHARS = 16;

export interface QuestionOption {
  readonly label: string;
  readonly description: string;
  readonly recommended?: true;
}

export interface Question {
  readonly header: string;
  readonly question: string;
  readonly multiSelect: boolean;
  readonly options: readonly QuestionOption[];
}

export interface Answer {
  readonly picks: readonly string[];
  readonly other: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(source: Record<string, unknown>, key: string, what: string, required = true): string {
  const value = source[key];
  if (typeof value !== 'string') throw new UsageError(`${what}.${key} must be a string`);
  if (required && value.trim() === '') throw new UsageError(`${what}.${key} must not be empty`);
  return value.trim();
}

function parseOption(value: unknown, what: string): QuestionOption {
  if (!isRecord(value)) throw new UsageError(`${what} must be an object`);
  const label = text(value, 'label', what);
  const description = text(value, 'description', what, false);
  if ('recommended' in value && typeof value.recommended !== 'boolean') {
    throw new UsageError(`${what}.recommended must be a boolean`);
  }
  return value.recommended === true
    ? { label, description, recommended: true }
    : { label, description };
}

function parseQuestion(value: unknown, what: string): Question {
  if (!isRecord(value)) throw new UsageError(`${what} must be an object`);
  const header = text(value, 'header', what);
  if (header.length > MAX_HEADER_CHARS) {
    throw new UsageError(`${what}.header must be at most ${MAX_HEADER_CHARS} characters`);
  }
  const multiSelect = value.multiSelect ?? false;
  if (typeof multiSelect !== 'boolean')
    throw new UsageError(`${what}.multiSelect must be a boolean`);
  const raw = value.options;
  if (!Array.isArray(raw) || raw.length < MIN_OPTIONS || raw.length > MAX_OPTIONS) {
    throw new UsageError(`${what}.options must hold ${MIN_OPTIONS} to ${MAX_OPTIONS} options`);
  }
  const options = raw.map((option: unknown, index) =>
    parseOption(option, `${what}.options[${index}]`),
  );
  if (new Set(options.map((option) => option.label)).size !== options.length) {
    throw new UsageError(`${what}.options must have different labels`);
  }
  if (options.filter((option) => option.recommended === true).length > 1) {
    throw new UsageError(`${what} may recommend one option at most`);
  }
  return { header, question: text(value, 'question', what), multiSelect, options };
}

export function parseQuestions(value: unknown): Question[] {
  const list = isRecord(value) ? value.questions : value;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_QUESTIONS) {
    throw new UsageError(`the question file: expected 1 to ${MAX_QUESTIONS} questions`);
  }
  return list.map((question: unknown, index) => parseQuestion(question, `questions[${index}]`));
}

export function formatQuestions(questions: readonly Question[]): string {
  return questions
    .map((question) => {
      const options = question.options.map(
        (option) =>
          `  - ${option.label}${option.recommended === true ? ' (recommended)' : ''}${option.description === '' ? '' : `: ${option.description}`}`,
      );
      return [
        `- **${question.header}**: ${question.question}${question.multiSelect ? ' (several)' : ''}`,
        ...options,
      ].join('\n');
    })
    .join('\n');
}

export function formatAnswers(
  questions: readonly Question[] | undefined,
  answers: readonly Answer[],
): string {
  return answers
    .map((answer, index) => {
      const question = questions?.[index];
      const asked = question ? `${question.header}: ${question.question}` : `Question ${index + 1}`;
      const given =
        [answer.picks.join(', '), answer.other ?? ''].filter((part) => part !== '').join('; ') ||
        '(none)';
      return `- ${asked} → ${given}`;
    })
    .join('\n');
}

export function questionsOf(opened: string): Question[] | undefined {
  try {
    const parsed: unknown = JSON.parse(opened);
    return parseQuestions(parsed);
  } catch {
    return undefined;
  }
}

export function answersOf(opened: string): Answer[] | undefined {
  try {
    const parsed: unknown = JSON.parse(opened);
    const list = isRecord(parsed) ? parsed.answers : parsed;
    if (!Array.isArray(list)) return undefined;
    return list.map((item: unknown) => {
      if (!isRecord(item) || !Array.isArray(item.picks)) throw new Error('shape');
      const picks = item.picks.filter((label): label is string => typeof label === 'string');
      return { picks, other: typeof item.other === 'string' ? item.other : null };
    });
  } catch {
    return undefined;
  }
}

export function composeAnswers(
  questions: readonly Question[],
  picks: readonly string[],
  others: readonly string[],
): Answer[] {
  const selected: string[][] = questions.map(() => []);
  for (const pick of picks) {
    const index = questions.findIndex((question) =>
      question.options.some((option) => option.label === pick),
    );
    const chosen = selected[index];
    if (chosen === undefined) {
      const labels = questions.flatMap((question) => question.options.map((o) => o.label));
      throw new UsageError(`"${pick}" is not an option of the open question: ${labels.join(', ')}`);
    }
    chosen.push(pick);
  }
  questions.forEach((question, index) => {
    if (!question.multiSelect && (selected[index]?.length ?? 0) > 1) {
      throw new UsageError(`"${question.header}" takes one option: give one --pick for it`);
    }
  });
  const remaining = [...others];
  const answers = questions.map((question, index): Answer => {
    const chosen = selected[index] ?? [];
    const other = chosen.length === 0 ? (remaining.shift() ?? null) : null;
    return { picks: chosen, other };
  });
  const leftover = remaining.shift();
  if (leftover !== undefined) {
    throw new UsageError('there is no question left without an answer for the extra --other');
  }
  questions.forEach((question, index) => {
    const answer = answers[index];
    if (answer === undefined || (answer.picks.length === 0 && answer.other === null)) {
      throw new UsageError(
        `"${question.header}" has no answer: give a --pick or an --other for it`,
      );
    }
  });
  return answers;
}
