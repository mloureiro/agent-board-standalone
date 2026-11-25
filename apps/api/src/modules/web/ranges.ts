import { randomBytes } from 'node:crypto';

export interface Span {
  start: number;
  length: number;
}

export type Selection =
  | { kind: 'whole' }
  | { kind: 'spans'; spans: Span[] }
  | { kind: 'invalid' }
  | { kind: 'no-overlap' };

export const MAX_RANGE_ITEMS = 200;

const UNIT = 'bytes=';
const BLANK = /^[ \t\r\n]+|[ \t\r\n]+$/g;
const INT64_MAX = 2n ** 63n - 1n;
const INT64_MIN = -(2n ** 63n);
const WHOLE: Selection = { kind: 'whole' };
const INVALID: Selection = { kind: 'invalid' };

const parseInt64 = (text: string): bigint | null => {
  if (!/^[+-]?\d+$/.test(text)) return null;
  const value = BigInt(text);
  return value >= INT64_MIN && value <= INT64_MAX ? value : null;
};

const absolute = (value: bigint): bigint => (value < 0n ? -value : value);
const smaller = (a: bigint, b: bigint): bigint => (a < b ? a : b);

export const selectRanges = (header: string, size: number): Selection => {
  if (header === '') return WHOLE;
  if (!header.startsWith(UNIT)) return INVALID;
  const items = header.slice(UNIT.length).split(',');
  if (items.length > MAX_RANGE_ITEMS) return WHOLE;
  const wanted = BigInt(size);
  const spans: Span[] = [];
  let beyondTheEnd = false;
  for (const raw of items) {
    const item = raw.replace(BLANK, '');
    if (item === '') continue;
    const dash = item.indexOf('-');
    if (dash < 0) return INVALID;
    const first = item.slice(0, dash).replace(BLANK, '');
    const last = item.slice(dash + 1).replace(BLANK, '');
    if (first === '') {
      const tail = last.startsWith('-') ? null : parseInt64(last);
      if (tail === null) return INVALID;
      if (size === 0) {
        beyondTheEnd = true;
        continue;
      }
      const length = smaller(absolute(tail), wanted);
      spans.push({ start: Number(wanted - length), length: Number(length) });
      continue;
    }
    const parsedStart = parseInt64(first);
    if (parsedStart === null) return INVALID;
    const start = absolute(parsedStart);
    if (start >= wanted) {
      beyondTheEnd = true;
      continue;
    }
    let length: bigint;
    if (last === '') {
      length = wanted - start;
    } else {
      const end = parseInt64(last);
      if (end === null || parsedStart > end) return INVALID;
      length = smaller(absolute(end), wanted - 1n) - start + 1n;
    }
    spans.push({ start: Number(start), length: Number(length) });
  }
  const total = spans.reduce((sum, span) => sum + span.length, 0);
  if (spans.length === 0) return beyondTheEnd ? { kind: 'no-overlap' } : WHOLE;
  return total > size ? WHOLE : { kind: 'spans', spans };
};

export const contentRange = (span: Span, size: number): string =>
  `bytes ${span.start}-${span.start + span.length - 1}/${size}`;

export const newBoundary = (): string => randomBytes(30).toString('hex');

export const multipartBody = (
  boundary: string,
  spans: readonly Span[],
  size: number,
  contentType: string,
  content: Buffer,
): Buffer => {
  const parts: Buffer[] = [];
  spans.forEach((span, index) => {
    const lead = index === 0 ? '' : '\r\n';
    parts.push(
      Buffer.from(
        `${lead}--${boundary}\r\nContent-Range: ${contentRange(span, size)}\r\nContent-Type: ${contentType}\r\n\r\n`,
      ),
      content.subarray(span.start, span.start + span.length),
    );
  });
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return Buffer.concat(parts);
};
