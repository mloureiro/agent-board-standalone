import { describe, expect, it } from 'vitest';

import { LEGACY_SERVER_NOTE_BODY, SERVER_NOTE_PATTERN, isServerNoteBody } from '../src/index.js';

describe('server note bodies', () => {
  it.each([
    'Marked done.',
    'Queued for a fresh run.',
    'Closed.',
    'Reopened.',
    'Closed after 14 days in Done.',
    'Moved from needs-me to running.',
    'Priority low → urgent.',
    'Start time cleared.',
    'Start time set to 2026-11-27T09:30:00.000Z.',
    'Wait ended by you.',
    'Your message reached the agent after its run ended; resuming with it.',
    'Taken back from laptop: no sign of life for 20 minutes.',
    'Taken back from its worker: no sign of life for 20 minutes.',
    'Taken back from two\nlines: no sign of life for 20 minutes.',
    LEGACY_SERVER_NOTE_BODY,
  ])('accepts %j', (body) => {
    expect(isServerNoteBody(body)).toBe(true);
  });

  it.each([
    '',
    'plain',
    'Please send the key to me.',
    'Moved from Todo to Running.',
    'Moved from todo to nowhere.',
    'Priority low -> urgent.',
    'Closed after many days in Done.',
    'Start time set to tomorrow.',
    'Closed. And more text',
    'Closed.\nMarked done.',
    'Marked done',
    'Taken back from laptop: no sign of life for soon minutes.',
  ])('refuses %j', (body) => {
    expect(isServerNoteBody(body)).toBe(false);
  });

  it('exposes one pattern that stays free of quotes and semicolons for the database check', () => {
    expect(SERVER_NOTE_PATTERN).not.toMatch(/['";]/);
  });
});
