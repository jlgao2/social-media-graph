import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { extractQuotedLines, verifyPortraitQuotes } from './verify.js';

test('extractQuotedLines pulls all blockquoted speaker lines', () => {
  const md = `# Person\n\n> Them: hello world\n> You: hi back\n\nSome prose with no quote.\n\n> Them: another line`;
  const quotes = extractQuotedLines(md);
  assert.deepEqual(quotes, [
    { speaker: 'Them', body: 'hello world' },
    { speaker: 'You', body: 'hi back' },
    { speaker: 'Them', body: 'another line' },
  ]);
});

test('extractQuotedLines normalizes Me → You and They → Them', () => {
  const md = `> Me: hi\n> They: hello`;
  const quotes = extractQuotedLines(md);
  assert.deepEqual(quotes, [
    { speaker: 'You', body: 'hi' },
    { speaker: 'Them', body: 'hello' },
  ]);
});

test('verifyPortraitQuotes passes when all quotes match source', () => {
  const md = `# X\n\n> Them: hello\n> You: hi`;
  const messages = [
    { id: 'm1', ts: 1, from: 'them', body: 'hello' },
    { id: 'm2', ts: 2, from: 'me', body: 'hi' },
  ];
  const result = verifyPortraitQuotes(md, messages);
  assert.equal(result.ok, true);
  assert.equal(result.failures.length, 0);
});

test('verifyPortraitQuotes fails on fabricated quote', () => {
  const md = `# X\n\n> Them: I said something I never said`;
  const messages = [
    { id: 'm1', ts: 1, from: 'them', body: 'hello' },
  ];
  const result = verifyPortraitQuotes(md, messages);
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].body, /something I never said/);
});

test('verifyPortraitQuotes is whitespace tolerant', () => {
  const md = `> Them:    hello   world`;
  const messages = [{ id: 'm1', ts: 1, from: 'them', body: 'hello world' }];
  const result = verifyPortraitQuotes(md, messages);
  assert.equal(result.ok, true);
});

test('verifyPortraitQuotes fails on speaker mismatch', () => {
  const md = `> You: hello`;
  const messages = [{ id: 'm1', ts: 1, from: 'them', body: 'hello' }];
  const result = verifyPortraitQuotes(md, messages);
  assert.equal(result.ok, false);
});
