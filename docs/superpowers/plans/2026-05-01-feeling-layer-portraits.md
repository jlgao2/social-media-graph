# L1 Feeling Layer — Portraits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a per-person portrait generator that reads each significant relationship's full message history and produces a markdown portrait capturing texture, anchor quotes, and recurring threads — with hard anti-fabrication guarantees.

**Architecture:** Three-pass per-person pipeline. (1) Chronological chunk reader (Sonnet) generates time-window field notes, sequential within a person. (2) Curator (Sonnet) extracts an anchor quote allowlist. (3) Synthesizer (Opus, friend-framed) writes the portrait using only allowlisted quotes. A deterministic verifier hard-fails any portrait with quotes not appearing verbatim in the source.

**Tech Stack:** Node.js (ESM), Anthropic SDK, `node:test` for unit tests, the existing pipeline's parsed message data as input.

**Spec:** `docs/superpowers/specs/2026-05-01-feeling-layer-portraits-design.md`

---

## File Structure

**New files:**
- `pipeline/agents/portrait/chunks.js` — pure function: messages → time-window chunks
- `pipeline/agents/portrait/chunk.js` — Pass 1: LLM chunk-note generation
- `pipeline/agents/portrait/curate.js` — Pass 2: anchor quote allowlist extraction
- `pipeline/agents/portrait/synthesize.js` — Pass 3: friend-frame portrait synthesis
- `pipeline/agents/portrait/verify.js` — deterministic quote verifier
- `pipeline/agents/portrait/index.js` — per-person orchestrator
- `pipeline/cli-portrait.js` — CLI entry point
- `pipeline/agents/portrait/chunks.test.js` — unit tests for chunker
- `pipeline/agents/portrait/verify.test.js` — unit tests for verifier

**Modified files:**
- `package.json` — add `npm run portrait` script
- `.gitignore` — add `pipeline/output/portraits/notes/`

---

## Task 1: Setup directory + scripts + ignores

**Files:**
- Create directory: `pipeline/agents/portrait/`, `pipeline/output/portraits/notes/`
- Modify: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Create the directories**

```bash
mkdir -p pipeline/agents/portrait pipeline/output/portraits/notes
```

- [ ] **Step 2: Update `package.json` scripts**

Open `package.json`, add inside the `"scripts"` object:

```json
"portrait": "node pipeline/cli-portrait.js",
"portrait:test": "node --test pipeline/agents/portrait/*.test.js"
```

- [ ] **Step 3: Update `.gitignore`**

Add this line (under the existing `pipeline/output/` entry, or anywhere in the personal-data block):

```
pipeline/output/portraits/notes/
```

- [ ] **Step 4: Commit**

```bash
git add package.json .gitignore
git commit -m "chore(portrait): scaffold directory and scripts"
```

---

## Task 2: Time-window chunker (pure function)

**Files:**
- Create: `pipeline/agents/portrait/chunks.js`
- Test: `pipeline/agents/portrait/chunks.test.js`

The chunker splits messages into ~3-month windows, with adaptive splitting: if a window has more than `maxPerChunk` messages (default 600), split into sub-chunks. If a window has fewer than `minPerChunk` (default 5), merge with the previous chunk.

- [ ] **Step 1: Write the failing test**

`pipeline/agents/portrait/chunks.test.js`:

```javascript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { chunkByTimeWindow } from './chunks.js';

const ms = (iso) => new Date(iso).getTime();

test('splits one year into ~four quarter chunks', () => {
  const messages = [];
  for (let i = 0; i < 100; i++) {
    const month = (i % 12) + 1;
    messages.push({ id: `m${i}`, ts: ms(`2024-${String(month).padStart(2, '0')}-15T12:00:00Z`), body: `msg ${i}` });
  }
  messages.sort((a, b) => a.ts - b.ts);
  const chunks = chunkByTimeWindow(messages, { windowDays: 90, maxPerChunk: 600, minPerChunk: 5 });
  assert.ok(chunks.length >= 3 && chunks.length <= 5, `expected ~4 chunks, got ${chunks.length}`);
  const total = chunks.reduce((s, c) => s + c.messages.length, 0);
  assert.equal(total, 100);
  for (let i = 1; i < chunks.length; i++) {
    assert.ok(chunks[i].startTs >= chunks[i - 1].endTs - 1);
  }
});

test('splits dense window into sub-chunks when over maxPerChunk', () => {
  const messages = [];
  for (let i = 0; i < 1500; i++) {
    messages.push({ id: `m${i}`, ts: ms(`2024-06-15T12:00:00Z`) + i * 1000, body: `msg ${i}` });
  }
  const chunks = chunkByTimeWindow(messages, { windowDays: 90, maxPerChunk: 600, minPerChunk: 5 });
  assert.ok(chunks.length >= 3, `expected at least 3 sub-chunks for 1500 messages, got ${chunks.length}`);
  for (const c of chunks) assert.ok(c.messages.length <= 600, `chunk has ${c.messages.length} > 600`);
});

test('merges sparse periods into one chunk', () => {
  const messages = [];
  for (const m of [3, 6, 9, 12]) {
    messages.push({ id: `m${m}a`, ts: ms(`2024-${String(m).padStart(2, '0')}-15T12:00:00Z`), body: 'a' });
    messages.push({ id: `m${m}b`, ts: ms(`2024-${String(m).padStart(2, '0')}-16T12:00:00Z`), body: 'b' });
  }
  const chunks = chunkByTimeWindow(messages, { windowDays: 90, maxPerChunk: 600, minPerChunk: 5 });
  assert.ok(chunks.length <= 2, `expected merged into 1-2 chunks, got ${chunks.length}`);
});

test('handles empty input', () => {
  const chunks = chunkByTimeWindow([], { windowDays: 90, maxPerChunk: 600, minPerChunk: 5 });
  assert.deepEqual(chunks, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test pipeline/agents/portrait/chunks.test.js
```

Expected: FAIL with `Cannot find module './chunks.js'`.

- [ ] **Step 3: Implement chunker**

`pipeline/agents/portrait/chunks.js`:

```javascript
const ONE_DAY_MS = 86400 * 1000;

/**
 * Split messages into time-window chunks.
 *
 * @param {Array} messages - Sorted by ts ascending.
 * @param {Object} opts
 * @param {number} opts.windowDays - Target window size (default 90 = ~3 months).
 * @param {number} opts.maxPerChunk - If a window has more, split it (default 600).
 * @param {number} opts.minPerChunk - If fewer, merge with previous (default 5).
 * @returns {Array<{startTs: number, endTs: number, messages: Array}>}
 */
export function chunkByTimeWindow(messages, opts = {}) {
  const { windowDays = 90, maxPerChunk = 600, minPerChunk = 5 } = opts;
  if (messages.length === 0) return [];

  const windowMs = windowDays * ONE_DAY_MS;

  // 1) Bucket by fixed time windows aligned to first message
  const start = messages[0].ts;
  const buckets = [];
  for (const m of messages) {
    const idx = Math.floor((m.ts - start) / windowMs);
    while (buckets.length <= idx) {
      const ws = start + buckets.length * windowMs;
      buckets.push({ startTs: ws, endTs: ws + windowMs, messages: [] });
    }
    buckets[idx].messages.push(m);
  }

  // 2) Split dense buckets that exceed maxPerChunk
  const split = [];
  for (const b of buckets) {
    if (b.messages.length === 0) continue;
    if (b.messages.length <= maxPerChunk) {
      split.push(b);
      continue;
    }
    const parts = Math.ceil(b.messages.length / maxPerChunk);
    const partSize = Math.ceil(b.messages.length / parts);
    for (let i = 0; i < parts; i++) {
      const sub = b.messages.slice(i * partSize, (i + 1) * partSize);
      if (sub.length === 0) continue;
      split.push({
        startTs: sub[0].ts,
        endTs: sub[sub.length - 1].ts + 1,
        messages: sub,
      });
    }
  }

  // 3) Merge sparse chunks (where the *previous* chunk has fewer than minPerChunk)
  const merged = [];
  for (const b of split) {
    if (merged.length > 0 && merged[merged.length - 1].messages.length < minPerChunk) {
      const prev = merged[merged.length - 1];
      prev.messages.push(...b.messages);
      prev.endTs = b.endTs;
    } else {
      merged.push({ ...b, messages: [...b.messages] });
    }
  }

  return merged;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test pipeline/agents/portrait/chunks.test.js
```

Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add pipeline/agents/portrait/chunks.js pipeline/agents/portrait/chunks.test.js
git commit -m "feat(portrait): time-window chunker with adaptive splitting"
```

---

## Task 3: Pass 1 — Chunk reader

**Files:**
- Create: `pipeline/agents/portrait/chunk.js`

This stage consumes one chunk + previous chunk notes, producing a chunk note via Sonnet. Sequential within a person; the orchestrator runs people in parallel.

- [ ] **Step 1: Implement Pass 1**

`pipeline/agents/portrait/chunk.js`:

```javascript
import { isMeaningfulMessage } from '../../normalize/schema.js';

const SYSTEM = `You are reading one chunk of an extended conversation between a user and one specific person in their life. Chunks are time-windowed (~3 months) and you receive prior chunk notes for context.

Your job: write a "chunk note" — 200-400 words capturing what this period of the relationship felt like.

Cover:
- Texture of this period: register, temperature, what kind of presence each person has in the other's life now.
- 2-4 specific moments that stand out, with verbatim quoted lines. Date each.
- What's shifting from prior chunks (if priors exist): new vocabulary, tone, in-jokes forming, things falling away.

You are a close reader. Not psychologizing. Describing texture, citing primary source. Write in the second person ("you" = the user).

Do not summarize messages. Do not list events. Capture what it FELT like to be in this conversation during this period, anchored in real quotes.`;

function formatMessage(m) {
  const date = new Date(m.ts).toISOString().slice(0, 10);
  const who = m.from === 'me' ? 'You' : 'Them';
  return `${date} ${who}: ${m.body.slice(0, 280).replace(/\n/g, ' ')}`;
}

/**
 * @param {Anthropic} client - Anthropic SDK instance
 * @param {{startTs: number, endTs: number, messages: Array}} chunk
 * @param {string[]} priorNotes - chunk notes from earlier chunks (chronological)
 * @returns {Promise<string>} the chunk note
 */
export async function generateChunkNote(client, chunk, priorNotes = []) {
  const meaningful = chunk.messages.filter(isMeaningfulMessage);
  if (meaningful.length === 0) return '';

  const fromUser = meaningful.filter(m => m.from === 'me').length;
  const fromThem = meaningful.length - fromUser;
  const periodFrom = new Date(chunk.startTs).toISOString().slice(0, 10);
  const periodTo = new Date(chunk.endTs).toISOString().slice(0, 10);

  // Cap input size: sample evenly if over 400 messages
  const sample = meaningful.length <= 400
    ? meaningful
    : Array.from({ length: 400 }, (_, i) => meaningful[Math.floor(i * meaningful.length / 400)]);

  const messageBlock = sample.map(formatMessage).join('\n');

  const priorBlock = priorNotes.length === 0
    ? '(this is the first chunk; no prior context)'
    : priorNotes.slice(-3)
        .map((n, i) => {
          const idx = priorNotes.length - Math.min(3, priorNotes.length) + i + 1;
          return `--- Prior chunk ${idx} ---\n${n}`;
        })
        .join('\n\n');

  const userMessage = `Period: ${periodFrom} → ${periodTo}
Messages this chunk: ${meaningful.length} (${fromUser} from you, ${fromThem} from them)

# Prior chunk notes
${priorBlock}

# Messages this chunk
${messageBlock}

# Output
Write the chunk note. Format:

Period: ${periodFrom} → ${periodTo}
Messages: ${meaningful.length} (${fromUser} from you, ${fromThem} from them)

Texture
<your description>

Standout moments
- YYYY-MM-DD — Them: "<exact line>" → You: "<exact line>" — <one-line context>

Shift from prior period
<one paragraph; or "first chunk" if no priors>`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    system: SYSTEM,
    messages: [{ role: 'user', content: userMessage }],
  });

  return response.content[0].text.trim();
}
```

- [ ] **Step 2: Commit**

```bash
git add pipeline/agents/portrait/chunk.js
git commit -m "feat(portrait): Pass 1 — chronological chunk reader"
```

---

## Task 4: Pass 2 — Curator

**Files:**
- Create: `pipeline/agents/portrait/curate.js`

Reads all chunk notes for one person, plus the source message log, and produces an anchor quote allowlist as JSON. Each anchor cites real message IDs.

- [ ] **Step 1: Implement curator**

`pipeline/agents/portrait/curate.js`:

```javascript
import { isMeaningfulMessage } from '../../normalize/schema.js';

const SYSTEM = `You are curating an anchor-quote allowlist for a relationship portrait. You have:
- All chunk notes for one relationship (chronological).
- A sampled source message log (each line tagged with an ID and date).

Your job: pick 8-15 anchor moments that capture the most resonant quotes — the ones that reveal who this person is, how they care, what makes the relationship specific. Spread chronologically (don't cluster all in one period).

Each anchor moment may contain 1-2 messages (a quote + its reply, or just one decisive line). Use ONLY messages from the source log — verbatim, with their real IDs. The schema is forward-compatible with photos and location data; for now, only the messages field is required.

Return JSON only, no markdown fences. Schema:

{
  "anchors": [
    {
      "date": "YYYY-MM-DD",
      "context": "one-line context — what was happening",
      "messages": [
        { "id": "<exact id from source>", "ts": <unix-ms>, "from": "me|them", "body": "<verbatim>" }
      ]
    }
  ]
}

Rules:
- Prefer quotes that surprise or reveal. Avoid generic banter.
- Spread across years/seasons.
- Verbatim only — no paraphrasing, no edits.
- IDs must come from the source log. Do not invent.`;

function formatLogLine(m) {
  const date = new Date(m.ts).toISOString().slice(0, 10);
  const who = m.from === 'me' ? 'YOU' : 'THEM';
  return `[${m.id}] ${date} ${who}: ${m.body.slice(0, 280).replace(/\n/g, ' ')}`;
}

/**
 * @param {Anthropic} client
 * @param {Array<{startTs, endTs, messages}>} chunks
 * @param {string[]} chunkNotes - notes from Pass 1
 * @returns {Promise<{anchors: Array}>}
 */
export async function curateAnchorQuotes(client, chunks, chunkNotes) {
  const allMessages = chunks.flatMap(c => c.messages).filter(isMeaningfulMessage);

  // Cap source log to ~600 lines for context budget; sample evenly
  const sampleSize = Math.min(allMessages.length, 600);
  const step = allMessages.length / sampleSize;
  const sampled = Array.from({ length: sampleSize }, (_, i) => allMessages[Math.floor(i * step)]);
  const sourceLog = sampled.map(formatLogLine).join('\n');

  const notesBlock = chunkNotes.map((n, i) => `--- Chunk ${i + 1} ---\n${n}`).join('\n\n');

  const userMessage = `# Chunk notes (${chunkNotes.length})
${notesBlock}

# Source message log (sampled, ${sampled.length} of ${allMessages.length})
${sourceLog}

# Output
Return the anchor allowlist as JSON.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    system: SYSTEM,
    messages: [{ role: 'user', content: userMessage }],
  });

  const text = response.content[0].text.trim();
  const cleaned = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Curator returned non-JSON: ${err.message}\nRaw: ${text.slice(0, 200)}`);
  }
  if (!parsed.anchors || !Array.isArray(parsed.anchors)) {
    throw new Error('Curator JSON missing anchors array');
  }
  return parsed;
}
```

- [ ] **Step 2: Commit**

```bash
git add pipeline/agents/portrait/curate.js
git commit -m "feat(portrait): Pass 2 — anchor quote curator"
```

---

## Task 5: Quote verifier (deterministic)

**Files:**
- Create: `pipeline/agents/portrait/verify.js`
- Test: `pipeline/agents/portrait/verify.test.js`

Checks every quoted line in the portrait Markdown against an exact-match index of source messages. Hard fail on any mismatch. Whitespace-tolerant; not paraphrase-tolerant.

- [ ] **Step 1: Write the failing test**

`pipeline/agents/portrait/verify.test.js`:

```javascript
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test pipeline/agents/portrait/verify.test.js
```

Expected: FAIL with `Cannot find module './verify.js'`.

- [ ] **Step 3: Implement verifier**

`pipeline/agents/portrait/verify.js`:

```javascript
const QUOTE_RE = /^>\s*(Them|You|They|Me)\s*:\s*(.*)$/i;

export function extractQuotedLines(markdown) {
  const out = [];
  for (const line of markdown.split(/\r?\n/)) {
    const m = QUOTE_RE.exec(line);
    if (!m) continue;
    let speaker = m[1];
    if (/^Me$/i.test(speaker)) speaker = 'You';
    else if (/^They$/i.test(speaker)) speaker = 'Them';
    else speaker = speaker[0].toUpperCase() + speaker.slice(1).toLowerCase();
    out.push({ speaker, body: m[2].trim() });
  }
  return out;
}

function normalize(s) {
  return (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Verify every quoted line in the portrait markdown appears verbatim
 * (whitespace-normalized) in the source messages, with the correct speaker.
 *
 * @param {string} markdown
 * @param {Array<{id: string, ts: number, from: 'me'|'them', body: string}>} messages
 * @returns {{ok: boolean, failures: Array<{speaker: string, body: string}>}}
 */
export function verifyPortraitQuotes(markdown, messages) {
  const meIndex = new Set();
  const themIndex = new Set();
  for (const m of messages) {
    const k = normalize(m.body);
    if (m.from === 'me') meIndex.add(k);
    else themIndex.add(k);
  }
  const quotes = extractQuotedLines(markdown);
  const failures = [];
  for (const q of quotes) {
    const k = normalize(q.body);
    if (!k) continue;
    const idx = q.speaker === 'You' ? meIndex : themIndex;
    if (!idx.has(k)) failures.push(q);
  }
  return { ok: failures.length === 0, failures };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test pipeline/agents/portrait/verify.test.js
```

Expected: All 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add pipeline/agents/portrait/verify.js pipeline/agents/portrait/verify.test.js
git commit -m "feat(portrait): deterministic quote verifier"
```

---

## Task 6: Pass 3 — Synthesizer

**Files:**
- Create: `pipeline/agents/portrait/synthesize.js`

Friend-frame Opus call. Receives chunk notes + anchor allowlist + person metadata, produces the portrait Markdown.

- [ ] **Step 1: Implement synthesizer**

`pipeline/agents/portrait/synthesize.js`:

```javascript
const SYSTEM = `You are the user's oldest, sharpest friend. They've described this person to you over years. You've now read field notes from a long conversation between them. Your job is to tell them back who this person is.

Texture first, structure later. Be the friend who reminds them of what's true. Don't psychoanalyze. Don't list patterns. Don't summarize the chat.

You may ONLY use quotes from the anchor allowlist provided. Do not paraphrase. Do not compose new quotes. If a quote isn't in the allowlist, do not use it.

Quotes appear in the portrait formatted as:
> Them: <exact body from allowlist>
> You: <exact body from allowlist>

Output strictly the markdown portrait, no preamble or commentary.`;

function formatAnchor(a) {
  const lines = a.messages.map(m => {
    const speaker = m.from === 'me' ? 'You' : 'Them';
    return `> ${speaker}: ${m.body}`;
  }).join('\n');
  return `**${a.date}** — ${a.context}\n${lines}`;
}

/**
 * @param {Anthropic} client
 * @param {Object} args
 * @param {string} args.name
 * @param {string[]} args.sources
 * @param {number} args.messageCount
 * @param {string} args.dateRange - "YYYY-MM-DD → YYYY-MM-DD"
 * @param {string[]} args.chunkNotes
 * @param {{anchors: Array}} args.allowlist
 * @param {string} args.userNotes
 * @returns {Promise<string>} the portrait markdown
 */
export async function synthesizePortrait(client, args) {
  const { name, sources, messageCount, dateRange, chunkNotes, allowlist, userNotes } = args;

  const anchorBlock = allowlist.anchors.map(formatAnchor).join('\n\n');
  const notesBlock = chunkNotes.map((n, i) => `--- Chunk ${i + 1} ---\n${n}`).join('\n\n');
  const userNotesBlock = (userNotes || '').trim()
    ? `\n# User feedback to incorporate this round\n${userNotes.trim()}\n`
    : '';

  const today = new Date().toISOString().slice(0, 10);
  const anchorIds = allowlist.anchors.flatMap(a => a.messages.map(m => m.id));
  const anchorIdsYaml = '[' + anchorIds.map(id => `"${id}"`).join(', ') + ']';

  const frontmatter = `---
name: ${name}
generated: ${today}
sources: ${JSON.stringify(sources)}
message_count: ${messageCount}
date_range: ${dateRange}
chunks_synthesized: ${chunkNotes.length}
anchor_quote_ids: ${anchorIdsYaml}
user_notes: ${JSON.stringify((userNotes || '').slice(0, 500))}
---`;

  const userMessage = `# Person
${name}

# Anchor allowlist (the ONLY quotes you may use, verbatim)
${anchorBlock}

# Chunk notes
${notesBlock}
${userNotesBlock}

# Output
Produce the portrait markdown. Begin with this frontmatter exactly:

${frontmatter}

Then render these sections in order:

# ${name}
*<one-sentence essence — felt, not labelling>*

## Texture
<400-600 words on the music of being in this relationship — how they talk, what they care about, the temperature. Not how they function in your life — the quality.>

## Anchor moments
<5-10 dated quoted exchanges in chronological order. Each formatted as:

**YYYY-MM-DD**
> Them: <exact verbatim from allowlist>
> You: <exact verbatim from allowlist>
<one-line context if needed>

You may use only quotes from the allowlist. Pick the most resonant 5-10 from the list.>

## Recurring threads
<3-5 motifs (not patterns). E.g. "you've been talking about X since YEAR.">

## What care looks like with them
<200-300 words on the grammar of how care actually shows up between you two, specifically.>

## A line for them
<One sentence drawn from the portrait — recognizable, not invented.>`;

  const response = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 4096,
    system: SYSTEM,
    messages: [{ role: 'user', content: userMessage }],
  });

  return response.content[0].text.trim();
}
```

- [ ] **Step 2: Commit**

```bash
git add pipeline/agents/portrait/synthesize.js
git commit -m "feat(portrait): Pass 3 — friend-frame synthesizer"
```

---

## Task 7: Per-person orchestrator

**Files:**
- Create: `pipeline/agents/portrait/index.js`

Combines the three passes plus verification for one person. On verification failure, regenerates with a feedback note explicitly listing the unverified quotes (up to MAX_VERIFY_ATTEMPTS = 3).

- [ ] **Step 1: Implement orchestrator**

`pipeline/agents/portrait/index.js`:

```javascript
import { chunkByTimeWindow } from './chunks.js';
import { generateChunkNote } from './chunk.js';
import { curateAnchorQuotes } from './curate.js';
import { synthesizePortrait } from './synthesize.js';
import { verifyPortraitQuotes } from './verify.js';

const MAX_VERIFY_ATTEMPTS = 3;

/**
 * @param {Anthropic} client
 * @param {Object} args
 * @param {{displayName: string, sources: string[]}} args.identity
 * @param {Array} args.messages - all messages for this person, chronological
 * @param {string} args.userNotes
 * @returns {Promise<{markdown: string, chunkNotes: string[], allowlist: Object, attempts: number, verified: boolean}>}
 */
export async function buildPortrait(client, args) {
  const { identity, messages, userNotes = '' } = args;
  const name = identity.displayName;

  // 1) Chunk
  const chunks = chunkByTimeWindow(messages, { windowDays: 90, maxPerChunk: 600, minPerChunk: 5 });
  if (chunks.length === 0) throw new Error(`No messages for ${name}`);

  // 2) Pass 1: chunk notes (sequential, each sees priors)
  const chunkNotes = [];
  for (let i = 0; i < chunks.length; i++) {
    process.stdout.write(`    chunk ${i + 1}/${chunks.length}...`);
    const note = await generateChunkNote(client, chunks[i], chunkNotes);
    chunkNotes.push(note);
    process.stdout.write(' ✓\n');
  }

  // 3) Pass 2: anchor allowlist
  process.stdout.write('    curating anchors... ');
  const allowlist = await curateAnchorQuotes(client, chunks, chunkNotes);
  process.stdout.write(`${allowlist.anchors.length} anchors\n`);

  // 4) Pass 3 + verify (with retry)
  const allMessages = chunks.flatMap(c => c.messages);
  const dateRange = `${new Date(messages[0].ts).toISOString().slice(0, 10)} → ${new Date(messages[messages.length - 1].ts).toISOString().slice(0, 10)}`;

  let markdown = '';
  let verified = false;
  let attempts = 0;
  let feedback = userNotes;

  while (!verified && attempts < MAX_VERIFY_ATTEMPTS) {
    attempts++;
    process.stdout.write(`    synthesis attempt ${attempts}... `);
    markdown = await synthesizePortrait(client, {
      name,
      sources: identity.sources || [],
      messageCount: messages.length,
      dateRange,
      chunkNotes,
      allowlist,
      userNotes: feedback,
    });
    const result = verifyPortraitQuotes(markdown, allMessages);
    if (result.ok) {
      verified = true;
      process.stdout.write('verified ✓\n');
    } else {
      process.stdout.write(`${result.failures.length} unverified quotes\n`);
      const failedList = result.failures.map(f => `  - ${f.speaker}: "${f.body}"`).join('\n');
      feedback = `${userNotes}\n\nPRIOR ATTEMPT used quotes that do not exist in the source messages. DO NOT use these — they were fabricated:\n${failedList}\n\nUse only quotes from the allowlist, verbatim.`;
    }
  }

  if (!verified) {
    throw new Error(`Verification failed after ${attempts} attempts for ${name}`);
  }

  return { markdown, chunkNotes, allowlist, attempts, verified };
}
```

- [ ] **Step 2: Commit**

```bash
git add pipeline/agents/portrait/index.js
git commit -m "feat(portrait): orchestrator with verification retry loop"
```

---

## Task 8: CLI entry point

**Files:**
- Create: `pipeline/cli-portrait.js`

Standalone runner. Parses inputs the same way as `pipeline/cli.js`. Generates portraits for top N (default 20) or a specific person via `--only`. Reads `pipeline/output/portraits/notes/<name>.md` if present and prepends as user feedback.

- [ ] **Step 1: Implement CLI**

`pipeline/cli-portrait.js`:

```javascript
#!/usr/bin/env node
/**
 * Portrait CLI.
 *
 *   npm run portrait                       # top N (MAX_PORTRAITS, default 20)
 *   npm run portrait -- --only "Becca"     # single person
 *   MAX_PORTRAITS=5 npm run portrait
 *
 * Requires ANTHROPIC_API_KEY in env. Auto-detects exports the same way cli.js does.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';

import { parseInstagramExport } from './ingest/instagram.js';
import { parseImessageExport } from './ingest/imessage.js';
import { parseWhatsappExport } from './ingest/whatsapp.js';
import { parseMessengerExport } from './ingest/messenger.js';
import { parseVcf } from './ingest/contacts.js';
import { resolveIdentities, mergeThreadsByIdentity } from './normalize/identity.js';
import { rankRelationships } from './analyze/network.js';
import { buildPortrait } from './agents/portrait/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const INPUTS = path.join(ROOT, 'inputs');
const OUTPUT = path.join(__dirname, 'output');
const PORTRAITS_DIR = path.join(OUTPUT, 'portraits');
const NOTES_DIR = path.join(PORTRAITS_DIR, 'notes');

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
function safeFilename(name) { return name.replace(/[^\w\-]+/g, '_'); }

function parseArgs(argv) {
  const args = { only: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--only') args.only = argv[++i];
  }
  return args;
}

function readNotesFor(name) {
  const p = path.join(NOTES_DIR, `${safeFilename(name)}.md`);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
}

function loadAllThreads() {
  const allThreads = [];

  // Instagram autodetect
  let igRoot = path.join(INPUTS, 'instagram');
  if (!fs.existsSync(igRoot)) {
    const candidates = fs.readdirSync(ROOT).filter(d => d.startsWith('instagram-') && fs.statSync(path.join(ROOT, d)).isDirectory());
    igRoot = candidates.length ? path.join(ROOT, candidates.sort().reverse()[0]) : null;
  }
  if (igRoot && fs.existsSync(igRoot)) allThreads.push(...parseInstagramExport(igRoot));

  // iMessage autodetect
  let imsgDir = path.join(INPUTS, 'imessage');
  if (!fs.existsSync(imsgDir) && fs.existsSync(path.join(ROOT, 'imessage-export'))) {
    imsgDir = path.join(ROOT, 'imessage-export');
  }
  if (fs.existsSync(imsgDir)) allThreads.push(...parseImessageExport(imsgDir));

  if (fs.existsSync(path.join(INPUTS, 'whatsapp'))) allThreads.push(...parseWhatsappExport(path.join(INPUTS, 'whatsapp')));

  let fbDir = path.join(INPUTS, 'messenger');
  if (!fs.existsSync(fbDir)) {
    const candidates = fs.readdirSync(ROOT).filter(d => /^(facebook-|messenger$)/i.test(d) && fs.statSync(path.join(ROOT, d)).isDirectory());
    if (candidates.length) fbDir = path.join(ROOT, candidates[0]);
  }
  if (fs.existsSync(fbDir)) allThreads.push(...parseMessengerExport(fbDir));

  // Contacts autodetect
  let contactsPath = path.join(INPUTS, 'contacts.vcf');
  if (!fs.existsSync(contactsPath)) {
    const cd = path.join(ROOT, 'contacts');
    if (fs.existsSync(cd)) {
      const vcfs = fs.readdirSync(cd).filter(f => f.endsWith('.vcf'));
      if (vcfs.length) contactsPath = path.join(cd, vcfs[0]);
    }
  }
  const contacts = parseVcf(contactsPath);

  resolveIdentities(allThreads, contacts);
  return mergeThreadsByIdentity(allThreads);
}

async function main() {
  ensureDir(PORTRAITS_DIR);
  ensureDir(NOTES_DIR);

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set.');
    process.exit(1);
  }

  const args = parseArgs(process.argv);
  const max = parseInt(process.env.MAX_PORTRAITS || '20', 10);

  console.log('Loading messages and resolving identities...');
  const byIdentity = loadAllThreads();
  const ranked = rankRelationships(byIdentity, 200);

  let targets;
  if (args.only) {
    const match = ranked.find(r => r.displayName.toLowerCase() === args.only.toLowerCase());
    if (!match) {
      console.error(`No relationship matching "${args.only}".`);
      console.error('Top 10 names:');
      for (const r of ranked.slice(0, 10)) console.error(`  - ${r.displayName}`);
      process.exit(1);
    }
    targets = [match];
  } else {
    targets = ranked.slice(0, max);
  }

  console.log(`Generating portraits for ${targets.length} ${targets.length === 1 ? 'person' : 'people'}.`);
  const client = new Anthropic();

  for (const t of targets) {
    const entry = byIdentity.get(t.canonicalId);
    console.log(`\n→ ${t.displayName} (${t.messages.toLocaleString()} messages)`);
    try {
      const userNotes = readNotesFor(t.displayName);
      const result = await buildPortrait(client, {
        identity: { displayName: t.displayName, sources: t.sources },
        messages: entry.allMessages,
        userNotes,
      });
      const outPath = path.join(PORTRAITS_DIR, `${safeFilename(t.displayName)}.md`);
      fs.writeFileSync(outPath, result.markdown);
      console.log(`  wrote ${path.relative(ROOT, outPath)} (${result.attempts} attempt${result.attempts > 1 ? 's' : ''})`);
    } catch (err) {
      console.error(`  failed: ${err.message}`);
    }
  }

  console.log('\nDone.');
}

main().catch(err => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Commit**

```bash
git add pipeline/cli-portrait.js
git commit -m "feat(portrait): CLI entry point with --only and notes support"
```

---

## Task 9: End-to-end smoke test

**Files:**
- (No new files. Run the CLI on a small target to verify end-to-end.)

The goal: prove the orchestrator works against real data on a low-volume person before scaling to top-N.

- [ ] **Step 1: Pick a low-volume target**

If `pipeline/output/network.md` doesn't already exist, run:

```bash
SKIP_AGENTS=1 npm run pipeline
```

Look at the ranked list. Pick a person with 200-1000 messages — small enough to run quickly, large enough to be a real test. Note their `displayName` exactly.

- [ ] **Step 2: Run portrait for that one person**

```bash
export ANTHROPIC_API_KEY=sk-ant-...
node pipeline/cli-portrait.js --only "<exact displayName>"
```

Expected: chunk-by-chunk progress, anchor count, "verified ✓" on synthesis attempt 1 (or retry up to attempt 3), file written to `pipeline/output/portraits/<name>.md`.

- [ ] **Step 3: Inspect the output**

```bash
cat "pipeline/output/portraits/<safe_name>.md"
```

Confirm:
- YAML frontmatter present with all fields
- Six sections: essence line, Texture, Anchor moments, Recurring threads, What care looks like with them, A line for them
- Quoted lines look real, dated, in chronological order
- "A line for them" reads recognizable, not invented

- [ ] **Step 4: Hand-verify one quote**

Pick one quote from the portrait. Find it in the source data (`grep "exact line" imessage-export/` or in the relevant Instagram thread JSON). Confirm it appears verbatim with the same speaker. This validates the verification path on a real run.

- [ ] **Step 5: Test the notes loop**

Create `pipeline/output/portraits/notes/<safe_name>.md` with one line of feedback (e.g., "the texture section misses how dry her humor is — add that"). Re-run:

```bash
node pipeline/cli-portrait.js --only "<exact displayName>"
```

Confirm the regenerated portrait reflects the note (the texture section should change).

- [ ] **Step 6: Commit any tweaks**

If you made tweaks during smoke-testing, commit them:

```bash
git add -p
git commit -m "fix(portrait): <what you changed>"
```

---

## Notes for the implementer

- The pipeline's existing `cli.js` already does ingest + identity resolution + ranking. The portrait CLI duplicates a small slice of that loading code to be standalone. If this becomes annoying, factor into a shared `pipeline/load.js` — but only if it actually starts to drift.
- Default chunker settings (90-day window, 600 max, 5 min) come from the spec. Tune at the orchestrator's call site if portraits feel uneven.
- The verifier is whitespace-tolerant but not paraphrase-tolerant. That's intentional. If verification rejects too aggressively in practice, surface the rejected quotes (already done) and tighten the synthesizer's prompt — don't loosen the verifier.
- `MAX_VERIFY_ATTEMPTS = 3`. After that, the portrait throws. A portrait with fabricated quotes is worse than no portrait.
- The anchor schema has reserved fields for `attachments` and `location` per the spec's extensibility section. v1 ignores them; v2/v3 will populate them.
