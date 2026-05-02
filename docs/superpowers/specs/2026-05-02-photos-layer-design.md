# Photos Layer

**Date:** 2026-05-02
**Status:** Design approved, ready for implementation plan
**Position:** Horizontal capability across L1-L4. Adds photo + face + place + event data to the existing DuckDB so portraits, memory triggers, and biometric correlations can use them.

## Problem

The pipeline today only reads text. It cannot answer "you and Cellina were at Snowbird in March 2024 with these 30 photos and these 50 messages from that weekend." Photos are an emotional anchor (a face) and a structural anchor (a time + place) that text alone misses.

Apple Photos already contains the user's library and (potentially) face clusters. Message attachments from iMessage and Instagram are already on disk. The work is connecting them into the existing schema and surfacing per-event views.

## Approach

Three ingestion sources, one schema, one DB. Hybrid lean approach (option B): read what Apple Photos already gives us; rely on the user opportunistically naming face clusters in Photos.app for richer person-tagging; do not build face detection from scratch.

### Sources

1. **Apple Photos library.** Read via [`osxphotos`](https://github.com/RhetTbull/osxphotos) — exports per-photo metadata (asset UUID, timestamp, GPS, EXIF, named persons from `ZPERSON`) without copying the binary. Fastest to integrate, richest metadata.
2. **iMessage attachments.** Already linked to a thread (and therefore a person) via existing `messages.id`. Filesystem path inside `~/Library/Messages/Attachments/`. Inherently person-tagged via thread membership.
3. **Instagram exports.** Photos directory inside the IG export already references threads via folder structure. Same person-via-thread linkage as iMessage.

### Dedup

Hash by SHA-256 of file bytes. A photo that's both in Apple Photos and was sent in iMessage gets one `photos` row with both `source_ref`s linked through join tables. The Apple Photos asset UUID (when present) is the canonical id; for message-only photos the SHA-256 hash is the id.

### Face naming workflow

The user names face clusters in Photos.app directly — no new UI. Steps:
1. Photos → People & Pets → click "Add Name" on top clusters
2. Save (data persists in `~/Pictures/Photos Library.photoslibrary/database/Photos.sqlite`)
3. Re-run `npm run build-photos` to ingest the new names

Our ingest reads `ZPERSON` rows and matches the names against the `identities` table by display_name + alias matching (same `resolveIdentities` logic). Unmatched names get listed as a CLI report so the user can either rename in Photos or add the variant as an alias to the contacts file.

The face naming is forward-compatible: re-running ingest after naming more clusters incrementally enriches `photo_faces` without re-doing other work.

## Schema

Added to `pipeline/output/raw/messages.duckdb`:

```sql
CREATE TABLE photos (
  id              VARCHAR PRIMARY KEY,         -- Apple asset UUID, else SHA-256
  ts              BIGINT NOT NULL,              -- capture time (EXIF or message ts)
  ts_iso          VARCHAR,
  source          VARCHAR NOT NULL,             -- 'apple_photos' | 'imessage' | 'instagram'
  source_ref      VARCHAR,                      -- thread_id when message-attached
  message_id      VARCHAR,                      -- FK to messages.id when applicable
  asset_path      VARCHAR,                      -- absolute filesystem path
  width           INTEGER,
  height          INTEGER,
  hash_sha256     VARCHAR,                      -- dedup key
  has_named_face  BOOLEAN
);

CREATE TABLE photo_faces (
  photo_id        VARCHAR NOT NULL,
  canonical_id    VARCHAR NOT NULL,             -- joins to identities.canonical_id
  face_cluster    VARCHAR,                      -- the Apple Photos ZPERSON name
  PRIMARY KEY (photo_id, canonical_id)
);

CREATE TABLE places (
  photo_id        VARCHAR PRIMARY KEY,
  lat             DOUBLE,
  lng             DOUBLE,
  place_name      VARCHAR,                      -- reverse geocoded
  city            VARCHAR,
  region          VARCHAR,
  country         VARCHAR
);

CREATE TABLE events (
  event_id        VARCHAR PRIMARY KEY,
  start_ts        BIGINT NOT NULL,
  end_ts          BIGINT NOT NULL,
  place_name      VARCHAR,                      -- inferred from member photos
  participants    VARCHAR[],                    -- canonical_ids of named faces present
  n_photos        INTEGER,
  n_messages      INTEGER,
  summary         VARCHAR                       -- optional, generated later
);

CREATE TABLE event_photos (
  event_id        VARCHAR NOT NULL,
  photo_id        VARCHAR NOT NULL,
  PRIMARY KEY (event_id, photo_id)
);

CREATE TABLE event_messages (
  event_id        VARCHAR NOT NULL,
  message_id      VARCHAR NOT NULL,
  PRIMARY KEY (event_id, message_id)
);
```

Joins to existing tables:
- `photo_faces.canonical_id` ↔ `identities`
- `photos.message_id` ↔ `messages.id`
- `event_messages.message_id` ↔ `messages.id`

## Event clustering algorithm

Greedy time-and-location clustering. For each photo `P` in chronological order:

```
if no current cluster, OR
   (P.ts - last_in_cluster.ts > EVENT_TIME_GAP_H hours) OR
   (P has GPS AND cluster center has GPS
       AND haversine_km(P, cluster_center) > EVENT_LOCATION_KM
       AND time gap > 1h):
  close current cluster, start new one
else:
  add P to current cluster
  update cluster center (rolling mean of GPS)

After photos pass:
  drop clusters with fewer than EVENT_MIN_PHOTOS
  for each surviving cluster:
    event_id = "evt_" + iso_date_of_start + "_" + short_hash(member_uuids)
    place_name = reverse-geocoded cluster center, when GPS available
    find messages within ±EVENT_MESSAGE_PADDING_H of [start_ts, end_ts]
    participants = union of named faces in cluster's photos
    n_photos = cluster size; n_messages = len(messages)
```

Default thresholds:
- `EVENT_TIME_GAP_H = 6` (close cluster after 6h of no photos)
- `EVENT_LOCATION_KM = 1.0` (close cluster if photo > 1km from center after >1h gap)
- `EVENT_MIN_PHOTOS = 3`
- `EVENT_MESSAGE_PADDING_H = 12`

All overridable via env vars at clustering time.

Filter heuristics:
- Drop "events" that are entirely screenshots (high screenshot ratio inferred from filename / EXIF)
- Drop events that appear to be a single sustained location with no movement and no people (likely WFH days; keep events with named faces or movement)

## HTML output

One self-contained `.html` per event, plus an index.

`pipeline/output/events/<event_id>.html`:
- **Header:** date range, place name, participant names with links to portraits if any exist
- **Timeline strip:** photos in chronological order, each as `<img src="file://<asset_path>">`. Captions: time, GPS sub-label
- **Conversation column:** messages from `event_messages` rendered like the portrait HTML (blockquotes per speaker), interleaved with photos by time
- **Footer:** event_id, n_photos, n_messages, GPS center, participant canonical ids

`pipeline/output/events/index.html`:
- A list of events with thumbnails
- Plain HTML+JS filtering by year, person, place
- No frameworks; same self-contained pattern as the portrait HTML

## File structure

```
pipeline/
├── ingest/
│   ├── apple-photos.js       # osxphotos JSON wrapper, reads ZPERSON, GPS, EXIF
│   ├── message-attachments.js # iMessage attachment table + Instagram export photos
│   └── reverse-geocode.js    # GPS → place name (offline first; online fallback)
├── normalize/
│   └── photo-dedup.js        # SHA-256 hashing, asset UUID precedence, dedup logic
├── analyze/
│   └── events.js             # event clustering algorithm
├── render/
│   ├── event-page.js         # per-event HTML
│   └── event-index.js        # index.html
├── build-photos.js           # one-shot orchestrator
└── output/
    └── events/
        ├── index.html
        └── evt_*.html
```

## Build pipeline

```bash
npm run build-photos
```

Stages:
1. **Apple Photos export.** Spawn `osxphotos` to dump library metadata to a temp JSON. Skip already-ingested asset UUIDs.
2. **Message attachment scan.** Walk iMessage `Attachments/` and Instagram `photos/` folders. Hash each. Look up message_id and thread_id from existing DB.
3. **Dedup.** Merge Apple Photos rows with message-attached rows where SHA-256 matches. Apple UUID wins as canonical id.
4. **Insert into `photos`, `photo_faces`, `places`.**
5. **Cluster.** Build `events`, `event_photos`, `event_messages`.
6. **Reverse geocode.** Resolve unique GPS coords to place names. Cache in DB to avoid repeated lookups.
7. **Render.** Emit per-event HTML and index.html.

Each stage writes intermediate state so a re-run can resume.

## Privacy / scope

- All processing local. No data sent externally except optional reverse geocoding (Nominatim/OSM is the default; can be disabled).
- Photos library is read-only access. Never modifies Photos.app.
- Asset paths stored as absolute paths. The HTML pages reference photos via `file://` URLs — they only render correctly on the original machine. **The output directory is gitignored.**
- A user-curated Photos album named e.g. `_exclude_from_analysis` is honored: any photo with that album tag is excluded from ingest entirely.
- iCloud-only photos (not downloaded locally) are recorded in the schema with `asset_path = NULL` and `has_named_face` etc. populated where possible. They appear in the DB but not in HTML pages.

## Cost / scope

- ~50K photos in a typical Apple Photos library. `osxphotos` metadata dump: ~1-2 minutes.
- Hashing every message attachment: ~10-30 minutes for tens of thousands of attachments (one-time).
- DuckDB inserts: fast, ~30 seconds.
- Event clustering: in-memory, sub-second.
- Reverse geocoding: ~5-10 minutes for unique GPS coords (Nominatim with rate limit).
- HTML generation: ~1 minute per 100 events.
- Total first-run: **30-60 minutes.** Re-runs (incremental): **~2-5 minutes** unless many new photos.
- No Anthropic API costs in this layer. Optional Phase 2 vision-API descriptions would cost extra; not in scope here.

## Out of scope (Phase 2+)

- Vision API descriptions ("what is in this photo") — adds richness but cost; defer until a portrait demands it
- Automatic face clustering from scratch — Apple Photos already does this; we lean on theirs
- iCloud-only photo download — user can run `osxphotos download` themselves; we mark missing assets and skip
- Sensitive/intimate photo filtering beyond the user-curated exclude album
- Live (real-time) ingest as new photos arrive — manual `npm run build-photos` for now
- Cross-event linking ("the trip that started after the conversation about X") — could come in L2
- Mobile UI / standalone app — only the static HTML viewer is in scope
- Group identification (who is in this group photo besides the named primary faces) — relies on face detection which is out of scope

## Acceptance criteria

The Photos layer is "done" when:

1. `npm run build-photos` runs end-to-end on the user's machine without errors
2. The DuckDB has populated `photos`, `photo_faces`, `places`, `events`, `event_photos`, `event_messages` tables
3. At least 100 events are detected from a typical 5+ year photo library (sanity check on clustering)
4. `pipeline/output/events/index.html` opens in a browser and lists every event
5. Clicking into a sample event shows photos + messages from that period, with named faces linking to identities
6. A re-run after the user names additional Photos.app face clusters increases `photo_faces` row count without recomputing other tables
7. The build-photos script honors the `_exclude_from_analysis` album

## Open questions for implementation plan

- Exact `osxphotos` invocation pattern — JSON streaming vs full export
- How to handle Apple Photos "Hidden" album (default exclude or no?)
- Reverse geocoder choice: offline (e.g., a static cities database for low-resolution) vs online Nominatim with caching
- HTML page sizing for events with hundreds of photos (lazy loading? pagination?)
- What thumbnail/preview strategy for index.html (use one representative photo? generate small thumbnails?)
- Whether to insert all photos or only photos that match a "meaningful" filter (e.g., skip pure screenshots)

## Approval

- [x] Architecture (three sources, one DB, hybrid face-naming)
- [x] Schema additions
- [x] Event clustering algorithm
- [x] HTML output (per-event + index)
- [x] Face-naming workflow (no new UI)
- [x] Privacy / scope boundaries
- [x] Out-of-scope explicitly listed (vision API, full face detection, mobile UI)
