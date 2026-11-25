export interface QuestionOption {
  readonly label: string;
  readonly description: string | null;
  readonly recommended: boolean;
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

export interface Choice {
  readonly picks: readonly string[];
  readonly other: string;
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

function parseOption(value: unknown): QuestionOption | null {
  if (typeof value === 'string') {
    return value === '' ? null : { label: value, description: null, recommended: false };
  }
  const body = record(value);
  const label = text(body.label);
  if (label === null) return null;
  return {
    label,
    description: text(body.description),
    recommended: body.recommended === true,
  };
}

export function parseQuestions(source: string): readonly Question[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(record(parsed).questions)
      ? record(parsed).questions
      : null;
  if (!Array.isArray(list) || list.length === 0) return null;
  const questions: Question[] = [];
  for (const entry of list) {
    const body = record(entry);
    const question = text(body.question);
    if (question === null) return null;
    const options = (Array.isArray(body.options) ? body.options : [])
      .map(parseOption)
      .filter((option): option is QuestionOption => option !== null);
    questions.push({
      header: text(body.header) ?? '',
      question,
      multiSelect: body.multiSelect === true,
      options,
    });
  }
  return questions;
}

export function initialPicks(questions: readonly Question[]): readonly Choice[] {
  return questions.map((question) => {
    const recommended = question.options
      .filter((option) => option.recommended)
      .map((option) => option.label);
    return {
      picks: question.multiSelect ? recommended : recommended.slice(0, 1),
      other: '',
    };
  });
}

export const isAnswered = (pick: Choice): boolean =>
  pick.picks.length > 0 || pick.other.trim() !== '';

export function toAnswers(picks: readonly Choice[]): readonly Answer[] {
  return picks.map((pick) => ({
    picks: pick.picks,
    other: pick.other.trim() === '' ? null : pick.other.trim(),
  }));
}

export function formatAnswers(questions: readonly Question[], answers: readonly Answer[]): string {
  return answers
    .map((answer, index) => {
      const question = questions[index];
      const asked =
        question === undefined
          ? `Question ${index + 1}`
          : `${question.header === '' ? '' : `${question.header}: `}${question.question}`;
      const given =
        [answer.picks.join(', '), answer.other ?? ''].filter((part) => part !== '').join('; ') ||
        '(none)';
      return `- ${asked} → ${given}`;
    })
    .join('\n');
}

export function togglePick(question: Question, current: Choice, label: string): Choice {
  if (question.multiSelect) {
    return {
      ...current,
      picks: current.picks.includes(label)
        ? current.picks.filter((pick) => pick !== label)
        : [...current.picks, label],
    };
  }
  return { ...current, picks: current.picks.includes(label) ? [] : [label] };
}

export function typeOther(question: Question, current: Choice, other: string): Choice {
  const startsTyping = !question.multiSelect && current.other === '' && other !== '';
  return startsTyping ? { picks: [], other } : { ...current, other };
}
