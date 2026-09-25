import { describe, expect, test } from 'vitest';

import { extractMentionEmails } from '../../src/shared/mentions.js';

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
});
