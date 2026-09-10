import { describe, expect, test } from 'vitest';

import { extractMentionEmails, splitMentions } from '../../src/shared/mentions.js';

describe('mentions', () => {
  test('extracts @email tokens, lowercased and deduplicated, in order', () => {
    const body = 'Hey @Bob@Example.com and @carol@example.com — @bob@example.com again?';
    expect(extractMentionEmails(body)).toEqual(['bob@example.com', 'carol@example.com']);
  });

  test('a mention must start a word: an @ glued to text is not one', () => {
    expect(extractMentionEmails('mail me at bob@example.com')).toEqual([]);
    expect(extractMentionEmails('weird@@bob@example.com')).toEqual([]);
    expect(extractMentionEmails('(@bob@example.com)')).toEqual(['bob@example.com']);
    expect(extractMentionEmails('@bob@example.com')).toEqual(['bob@example.com']);
  });

  test('trailing punctuation is not part of the address', () => {
    expect(extractMentionEmails('thanks @bob@example.com.')).toEqual(['bob@example.com']);
    expect(extractMentionEmails('ok, @bob@example.com, go')).toEqual(['bob@example.com']);
  });

  test('splitMentions keeps every character and only chips known addresses', () => {
    const known = new Set(['bob@example.com']);
    const body = 'cc @bob@example.com and @nobody@else.org.';
    const segments = splitMentions(body, known);
    expect(segments).toEqual([
      { type: 'text', text: 'cc ' },
      { type: 'mention', email: 'bob@example.com' },
      { type: 'text', text: ' and @nobody@else.org.' },
    ]);
    const rebuilt = segments.map((s) => (s.type === 'text' ? s.text : `@${s.email}`)).join('');
    expect(rebuilt).toBe(body);
  });

  test('splitMentions handles a mention at the very start and end', () => {
    const known = new Set(['bob@example.com']);
    expect(splitMentions('@bob@example.com', known)).toEqual([{ type: 'mention', email: 'bob@example.com' }]);
    expect(splitMentions('hi @bob@example.com', known)).toEqual([
      { type: 'text', text: 'hi ' },
      { type: 'mention', email: 'bob@example.com' },
    ]);
  });
});
