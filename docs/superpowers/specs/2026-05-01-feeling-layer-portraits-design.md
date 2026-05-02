# Feeling Layer — Portraits

**Date:** 2026-05-01
**Status:** Design approved, ready for implementation plan
**Layer:** L1 (Feeling) of a four-layer system. L2 (Remembering), L3 (Bonds Stronger), L4 (Health-Integrated) build on L1's output.

## Problem

The existing analysis pipeline produces structural diagnostics — patterns, architecture, who's doing what for whom. It is good at finding shape and bad at finding texture. Keyword search misses real tenderness. Pattern extraction flattens specific people into roles.

This layer's job: produce per-person *portraits* that capture who each person actually is to the user, in their register, with the specific quotes that prove it. The substrate that L2-L4 read.

## Approach

Three-pass per-person pipeline using time-window chunking and a friend-framing synthesis prompt.

### Pass 1 — Chronological chunk notes (Sonnet)

Split the thread into ~3-month time windows. Sequentially within a person, generate a chunk note (200-400 words) per window:

- The texture of this period
- 2-4 standout moments with quoted lines
- What's shifting from the previous chunk (each chunk receives prior chunk notes as context)
- New vocabulary, in-jokes, registers

Why time-window chunks: relationships shift quarter-to-quarter, not every 5K tokens. Aligns with how the user thinks about "what was 2023 like with her."

Sequential within person; parallel across people.

### Pass 2 — Anchor quote curation (Sonnet)

Reads all chunk notes for one person. Produces a JSON list of 8-15 anchor moments — exact verbatim quotes with `{messageId, ts, sender, body}`. Discipline separation from Pass 1: Pass 1 finds candidates; Pass 2 curates.

### Pass 3 — Friend-frame synthesis (Opus)

Takes the chunk notes + anchor quote allowlist. Produces the portrait via this framing:

> *You are the user's oldest, sharpest friend. They've described this person to you over years. You've now read the field notes from a long conversation. Tell them back who this person is — texture first, structure later. Anchor with the curated quotes. Don't psychoanalyze. Don't list patterns. Be the friend who reminds them of what's true.*

System prompt is explicit: **MAY ONLY use quotes from the allowlist.** No paraphrasing. No composition.

Opus because the synthesis pass is the highest-quality stage and benefits from better social cognition for the friend-framing.

## Portrait template

```markdown
---
name: <Name>
generated: YYYY-MM-DD
sources: [imessage, instagram]
message_count: <N>
date_range: YYYY-MM-DD → YYYY-MM-DD
chunks_synthesized: <N>
anchor_quote_ids: [thread:idx, ...]
user_notes: <accumulated user feedback>
---

# <Name>

*<one-sentence essence — felt, not labelling>*

## Texture
<400-600 words on the music of being in this relationship.>

## Anchor moments
<5-10 dated quoted exchanges in chronological order. Primary source.>

## Recurring threads
<3-5 motifs, not patterns.>

## What care looks like with them
<200-300 words on how care actually shows up between you two.>

## A line for them
<One sentence drawn from the portrait.>
```

## Anchoring discipline (anti-fabrication)

The single biggest reliability risk is hallucinated quotes. Three layers of defense:

1. **Quote allowlist.** Pass 3 may only use quotes from the allowlist produced by Pass 2. Enforced via system prompt.
2. **Post-generation verification.** Deterministic check: for each quoted line in the portrait markdown, look it up in the source data. Verify verbatim match and date correctness. **Hard fail** — regenerate the portrait, don't ship.
3. **Date ground-truth.** Every quote in the portrait carries its real timestamp from source data. Dates injected into prompt with quotes; model assembles, never computes.

The verifier is a hard quality gate. No portrait ships without passing.

## Editability & regeneration

- User reads each portrait
- Optionally adds feedback to `pipeline/output/portraits/notes/<name>.md` (gitignored)
- Notes are prepended to the synthesis prompt on regeneration
- `npm run portrait -- --only "<Name>"` regenerates
- Notes accumulate; portraits become living artifacts

## Cost & scope

- Top 15-25 people by intimacy ranking (default 20)
- Per person ≈ 20 Sonnet chunk calls + 1 Sonnet curation + 1 Opus synthesis ≈ $0.80
- Top 20 ≈ $15-20 total
- Cap with `MAX_PORTRAITS=N` env var

## Integration

```
pipeline/
├── agents/
│   └── portrait/
│       ├── chunk.js       # Pass 1
│       ├── curate.js      # Pass 2
│       ├── synthesize.js  # Pass 3
│       └── verify.js      # Verification gate
├── cli.js                 # adds --portraits flag, MAX_PORTRAITS env
└── output/
    └── portraits/
        ├── <name>.md
        └── notes/<name>.md  # user feedback (gitignored)
```

Standalone CLI: `npm run portrait` — uses cached identity resolution and ranking from prior pipeline runs. Doesn't re-ingest unless caches are missing.

## Why this serves layers above

- **L2 (Remembering):** anchor quotes + chunk notes are the queryable archive. Memory triggers ("5 years ago today...") read from the timestamped chunk notes. The curated allowlist becomes the retrievable corpus.
- **L3 (Bonds Stronger):** *A line for them* is the seed. Reach-out prompts can be generated by reading the portrait + checking time-since-last-contact.
- **L4 (Health-Integrated):** chunk notes are time-windowed, so they align directly with biometric time series. Correlation analysis runs on chunk-level intensity scores against sleep/HRV/mood.

## Out of scope

- L2/L3/L4 themselves (separate specs)
- UI for browsing portraits (markdown is the interface for now)
- Real-time portrait updates as new messages arrive (regeneration is manual)
- Group threads (1-on-1 only; group dynamics need a different methodology)

## Extensibility for future features

The anchor moment schema is designed to be forward-compatible with photo and location data without a v1 rewrite:

```json
{
  "date": "YYYY-MM-DD",
  "context": "...",
  "messages": [{ "id": "...", "ts": ..., "from": "me|them", "body": "..." }],
  "attachments": [{ "type": "photo|video|audio", "path": "...", "caption": "..." }],
  "location": { "lat": ..., "lng": ..., "place": "..." }
}
```

v1 ignores `attachments` and `location`. The chunker already passes full message objects through, so attachment metadata is preserved end-to-end and available to future versions.

Future v2/v3 work (own specs):
- **Photo selection + inline rendering in portraits** (vision model calls, cost-controlled)
- **Apple Photos library ingestion** (GPS metadata, face groupings)
- **Location ingestion** (Apple Significant Locations, Google Timeline, calendar)
- **Place-anchored memory** in L2 ("you've been to Snowbird three times…")
- **Biometric × location correlation** in L4

## Open questions for implementation plan

- Exact chunk size if a 3-month window is too sparse (some relationships have <50 messages/quarter) or too dense (EJ has thousands per month)
- Adaptive chunking: collapse sparse periods, split dense ones
- Concurrency limits to stay within Anthropic API rate limits
- Failure mode for the verifier: how many regeneration attempts before giving up
- Format of notes file (free-form markdown vs structured)

## Approval

- [x] Methodology (chronological reader, multi-pass, friend-framing)
- [x] Portrait template
- [x] Anchoring discipline
- [x] Editability model
- [x] Cost envelope
- [x] Integration with existing pipeline
