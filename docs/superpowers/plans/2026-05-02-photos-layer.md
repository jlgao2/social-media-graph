# Photos Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the photos layer that ingests Apple Photos library + iMessage attachments + Instagram exports into the existing DuckDB, clusters them into events, and renders one self-contained HTML page per event.

**Architecture:** Three sources, one schema, one DB. Apple Photos via the `osxphotos` Python CLI (metadata-only export to JSON). Message attachments by walking the filesystem. Hash-dedup via SHA-256. Greedy time-location clustering for events. Self-contained HTML pages plus a filterable index.

**Tech Stack:** Node.js (ESM), `@duckdb/node-api`, `osxphotos` (Python CLI shelled out), `node:test`, Nominatim/OSM reverse geocoder via HTTP (rate-limited).

**Spec:** `docs/superpowers/specs/2026-05-02-photos-layer-design.md`

---

## File Structure

**New files:**
- `pipeline/ingest/apple-photos.js` — wraps `osxphotos export --report-json` and parses the result
- `pipeline/ingest/message-attachments.js` — walks `~/Library/Messages/Attachments/` and the Instagram `photos/` directories, hashes contents, links to existing `messages.id`
- `pipeline/ingest/reverse-geocode.js` — GPS → place name via Nominatim, with on-disk + DB cache
- `pipeline/normalize/photo-dedup.js` — pure: SHA-256 hashing, dedup precedence (Apple UUID > hash)
- `pipeline/normalize/photo-dedup.test.js` — unit tests
- `pipeline/normalize/photo-schema.js` — creates `photos`, `photo_faces`, `places`, `events`, `event_photos`, `event_messages` tables idempotently
- `pipeline/analyze/events.js` — pure: greedy time-location clustering function
- `pipeline/analyze/events.test.js` — unit tests
- `pipeline/render/event-page.js` — produces per-event self-contained HTML
- `pipeline/render/event-index.js` — produces `index.html` listing all events with thumbnails and filters
- `pipeline/build-photos.js` — orchestrator entry point

**Modified files:**
- `package.json` — add `build-photos` script
- `.gitignore` — exclude `pipeline/output/events/`

---

## Task 1: Scaffold + scripts + ignores

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`
- Create directories: `pipeline/render/`, `pipeline/output/events/`

- [ ] **Step 1: Create directories**

```bash
mkdir -p pipeline/render pipeline/output/events
```

- [ ] **Step 2: Add npm script**

Open `package.json`, add inside the existing `"scripts"` block:

```json
"build-photos": "node pipeline/build-photos.js"
```

- [ ] **Step 3: Update `.gitignore`**

Add this line (next to the existing `pipeline/output/portraits/notes/` entry):

```
pipeline/output/events/
```

- [ ] **Step 4: Verify osxphotos availability**

Run:

```bash
which osxphotos || echo "MISSING: install with 'pipx install osxphotos' or 'pip3 install osxphotos'"
```

If missing, install:

```bash
pipx install osxphotos
```

Verify:

```bash
osxphotos --version
```

Expected: prints a version like `osxphotos, version 0.69.x`. If installation fails, report BLOCKED with the error.

- [ ] **Step 5: Commit**

```bash
git add package.json .gitignore
git commit -m "chore(photos): scaffold directories, npm script, gitignore"
```

---

## Task 2: Schema setup — photos / photo_faces / places / events tables

**Files:**
- Create: `pipeline/normalize/photo-schema.js`

This is the idempotent schema-creator. Called by `build-photos.js` at the start of every run. Uses `CREATE TABLE IF NOT EXISTS` so it's safe to call against a DB that may or may not already have these tables.

- [ ] **Step 1: Create the file**

`pipeline/normalize/photo-schema.js`:

```javascript
/**
 * Idempotent schema setup for the photos layer.
 *
 * All tables use CREATE TABLE IF NOT EXISTS so this is safe to call multiple
 * times. Called by build-photos.js at the start of every run.
 */

export async function ensurePhotoSchema(conn) {
  await conn.run(`
    CREATE TABLE IF NOT EXISTS photos (
      id              VARCHAR PRIMARY KEY,
      ts              BIGINT NOT NULL,
      ts_iso          VARCHAR,
      source          VARCHAR NOT NULL,
      source_ref      VARCHAR,
      message_id      VARCHAR,
      asset_path      VARCHAR,
      width           INTEGER,
      height          INTEGER,
      hash_sha256     VARCHAR,
      has_named_face  BOOLEAN
    );
    CREATE INDEX IF NOT EXISTS idx_photos_ts          ON photos(ts);
    CREATE INDEX IF NOT EXISTS idx_photos_hash        ON photos(hash_sha256);
    CREATE INDEX IF NOT EXISTS idx_photos_message     ON photos(message_id);

    CREATE TABLE IF NOT EXISTS photo_faces (
      photo_id        VARCHAR NOT NULL,
      canonical_id    VARCHAR NOT NULL,
      face_cluster    VARCHAR,
      PRIMARY KEY (photo_id, canonical_id)
    );
    CREATE INDEX IF NOT EXISTS idx_pf_photo     ON photo_faces(photo_id);
    CREATE INDEX IF NOT EXISTS idx_pf_canonical ON photo_faces(canonical_id);

    CREATE TABLE IF NOT EXISTS places (
      photo_id        VARCHAR PRIMARY KEY,
      lat             DOUBLE,
      lng             DOUBLE,
      place_name      VARCHAR,
      city            VARCHAR,
      region          VARCHAR,
      country         VARCHAR
    );

    CREATE TABLE IF NOT EXISTS events (
      event_id        VARCHAR PRIMARY KEY,
      start_ts        BIGINT NOT NULL,
      end_ts          BIGINT NOT NULL,
      place_name      VARCHAR,
      participants    VARCHAR[],
      n_photos        INTEGER,
      n_messages      INTEGER,
      summary         VARCHAR
    );

    CREATE TABLE IF NOT EXISTS event_photos (
      event_id        VARCHAR NOT NULL,
      photo_id        VARCHAR NOT NULL,
      PRIMARY KEY (event_id, photo_id)
    );

    CREATE TABLE IF NOT EXISTS event_messages (
      event_id        VARCHAR NOT NULL,
      message_id      VARCHAR NOT NULL,
      PRIMARY KEY (event_id, message_id)
    );

    CREATE TABLE IF NOT EXISTS reverse_geocode_cache (
      lat_round       DOUBLE,
      lng_round       DOUBLE,
      place_name      VARCHAR,
      city            VARCHAR,
      region          VARCHAR,
      country         VARCHAR,
      PRIMARY KEY (lat_round, lng_round)
    );
  `);
}
```

- [ ] **Step 2: Quick syntax check**

```bash
node --check pipeline/normalize/photo-schema.js
```

Expected: silent success.

- [ ] **Step 3: Commit**

```bash
git add pipeline/normalize/photo-schema.js
git commit -m "feat(photos): idempotent schema for photos/faces/places/events"
```

---

## Task 3: Photo dedup module (pure function, TDD)

**Files:**
- Create: `pipeline/normalize/photo-dedup.js`
- Test: `pipeline/normalize/photo-dedup.test.js`

Pure functions: SHA-256 hashing, dedup-merge logic. Apple UUID wins as canonical id when present; otherwise SHA-256 hash is the id. Two photos with the same hash from different sources merge into one row with both `source_ref`s recorded.

- [ ] **Step 1: Write the failing test**

`pipeline/normalize/photo-dedup.test.js`:

```javascript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { hashFile, mergeDuplicates, canonicalIdFor } from './photo-dedup.js';

test('hashFile returns deterministic SHA-256 hex', async () => {
  const tmp = path.join(os.tmpdir(), `dedup-test-${Date.now()}.bin`);
  fs.writeFileSync(tmp, Buffer.from('hello world'));
  try {
    const h1 = await hashFile(tmp);
    const h2 = await hashFile(tmp);
    assert.equal(h1, h2);
    assert.equal(h1, 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('canonicalIdFor prefers Apple UUID, falls back to hash', () => {
  assert.equal(
    canonicalIdFor({ apple_uuid: 'AAAA-BBBB', hash_sha256: 'deadbeef' }),
    'AAAA-BBBB',
  );
  assert.equal(
    canonicalIdFor({ apple_uuid: null, hash_sha256: 'deadbeef' }),
    'sha256:deadbeef',
  );
  assert.throws(
    () => canonicalIdFor({ apple_uuid: null, hash_sha256: null }),
    /requires apple_uuid or hash_sha256/,
  );
});

test('mergeDuplicates folds same-hash photos from different sources', () => {
  const photos = [
    { id: 'sha256:h1', hash_sha256: 'h1', source: 'imessage', source_ref: 'imsg:thread1', ts: 100 },
    { id: 'AAAA',      hash_sha256: 'h1', source: 'apple_photos', source_ref: null, ts: 100 },
    { id: 'sha256:h2', hash_sha256: 'h2', source: 'imessage', source_ref: 'imsg:thread2', ts: 200 },
  ];
  const merged = mergeDuplicates(photos);
  // Apple UUID wins as canonical
  assert.equal(merged.length, 2);
  const found = merged.find(m => m.id === 'AAAA');
  assert.ok(found, 'photo with apple uuid should be present');
  // Other source refs preserved as alt_refs
  assert.deepEqual(found.alt_refs.sort(), [{ source: 'imessage', source_ref: 'imsg:thread1' }].sort((a,b)=>a.source.localeCompare(b.source)));
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test pipeline/normalize/photo-dedup.test.js
```

Expected: FAIL with `Cannot find module './photo-dedup.js'`.

- [ ] **Step 3: Implement photo-dedup.js**

`pipeline/normalize/photo-dedup.js`:

```javascript
import crypto from 'crypto';
import fs from 'fs';

/**
 * SHA-256 hash of a file's contents, hex-encoded.
 *
 * @param {string} filepath
 * @returns {Promise<string>}
 */
export function hashFile(filepath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filepath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Canonical photo id: Apple UUID if available, else "sha256:<hash>".
 *
 * @param {{apple_uuid: string|null, hash_sha256: string|null}} input
 * @returns {string}
 */
export function canonicalIdFor({ apple_uuid, hash_sha256 }) {
  if (apple_uuid) return apple_uuid;
  if (hash_sha256) return `sha256:${hash_sha256}`;
  throw new Error('canonicalIdFor requires apple_uuid or hash_sha256');
}

/**
 * Merge same-hash photos from different sources into one row each.
 *
 * Precedence: a row whose source is 'apple_photos' (Apple UUID id) wins as
 * the canonical row. Other rows' source/source_ref/message_id become alt_refs
 * on the winner. ts and asset_path on the winner are kept; other rows'
 * fields are preserved only in alt_refs.
 *
 * @param {Array} photos - rows with hash_sha256, source, source_ref
 * @returns {Array} deduped rows with .alt_refs[]
 */
export function mergeDuplicates(photos) {
  const byHash = new Map();
  for (const p of photos) {
    if (!p.hash_sha256) {
      // No hash — can't dedup. Pass through with empty alt_refs.
      byHash.set(`__nohash__:${p.id}`, { ...p, alt_refs: [] });
      continue;
    }
    if (!byHash.has(p.hash_sha256)) {
      byHash.set(p.hash_sha256, { ...p, alt_refs: [] });
      continue;
    }
    const existing = byHash.get(p.hash_sha256);
    // Decide winner: apple_photos source preferred
    if (p.source === 'apple_photos' && existing.source !== 'apple_photos') {
      // Demote existing to alt_ref, promote p
      const altRef = { source: existing.source, source_ref: existing.source_ref, message_id: existing.message_id };
      const newWinner = { ...p, alt_refs: [...existing.alt_refs, altRef] };
      byHash.set(p.hash_sha256, newWinner);
    } else {
      // Add p as alt_ref to existing
      existing.alt_refs.push({ source: p.source, source_ref: p.source_ref, message_id: p.message_id });
    }
  }
  return [...byHash.values()];
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test pipeline/normalize/photo-dedup.test.js
```

Expected: All 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add pipeline/normalize/photo-dedup.js pipeline/normalize/photo-dedup.test.js
git commit -m "feat(photos): dedup module — hashing + Apple-UUID-wins merge"
```

---

## Task 4: Apple Photos ingest

**Files:**
- Create: `pipeline/ingest/apple-photos.js`

Shells out to `osxphotos` to dump library metadata as JSON. Parses the result, returns rows ready for insertion into `photos`, `photo_faces`, and `places`. Honors a user-curated album named `_exclude_from_analysis`.

- [ ] **Step 1: Implement the ingest module**

`pipeline/ingest/apple-photos.js`:

```javascript
import { execFileSync, execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const EXCLUDE_ALBUM = '_exclude_from_analysis';

/**
 * Run `osxphotos query --json` to get all photo metadata.
 *
 * Returns an array of objects with at least:
 *   uuid, original_filename, path, date, latitude, longitude,
 *   width, height, persons (array of names), albums (array of names)
 *
 * Set --library to override the default Photos library location.
 */
export async function loadAppleLibraryMetadata(opts = {}) {
  const { library = null, includeHidden = false } = opts;

  const args = [
    'query',
    '--json',
    '--only-photos',  // exclude movies for now
  ];
  if (!includeHidden) args.push('--not-hidden');
  if (library) args.push('--library', library);

  let raw;
  try {
    raw = execFileSync('osxphotos', args, {
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024 * 1024, // 1GB — Photos libraries can be huge
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error('osxphotos not found in PATH. Install with: pipx install osxphotos');
    }
    throw new Error(`osxphotos query failed: ${err.message}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`osxphotos returned non-JSON: ${err.message}`);
  }

  // Filter out the user-curated exclude album
  return data.filter(p => !(p.albums || []).includes(EXCLUDE_ALBUM));
}

/**
 * Convert a single osxphotos record into our photos / photo_faces / places shape.
 *
 * Returns: { photo, faces: [...names], place: {lat, lng} | null }
 */
export function normalizeApplePhoto(record) {
  const ts = record.date ? new Date(record.date).getTime() : 0;
  const photo = {
    id: record.uuid,                       // Apple UUID is canonical
    apple_uuid: record.uuid,
    ts,
    ts_iso: ts ? new Date(ts).toISOString() : null,
    source: 'apple_photos',
    source_ref: null,
    message_id: null,
    asset_path: record.path || null,        // null if iCloud-only and not downloaded
    width: record.width || null,
    height: record.height || null,
    hash_sha256: null,                      // filled in later if asset_path exists
    has_named_face: (record.persons || []).filter(n => n && n.trim()).length > 0,
  };
  const faces = (record.persons || []).filter(n => n && n.trim());
  const place = (record.latitude && record.longitude)
    ? { lat: record.latitude, lng: record.longitude }
    : null;
  return { photo, faces, place };
}

/**
 * Match face cluster names against the existing identities table.
 *
 * @param {Array<{photo_id, name}>} faceRows
 * @param {Map<string, string>} nameToCanonical - lowercased display_name → canonical_id
 * @returns {{matched: Array, unmatched: Array<string>}}
 */
export function resolveFaces(faceRows, nameToCanonical) {
  const matched = [];
  const unmatched = new Set();
  for (const { photo_id, name } of faceRows) {
    const canId = nameToCanonical.get(name.toLowerCase());
    if (canId) {
      matched.push({ photo_id, canonical_id: canId, face_cluster: name });
    } else {
      unmatched.add(name);
    }
  }
  return { matched, unmatched: [...unmatched] };
}
```

- [ ] **Step 2: Quick syntax check**

```bash
node --check pipeline/ingest/apple-photos.js
```

Expected: silent success.

- [ ] **Step 3: Smoke test against the user's actual library (read-only)**

Create a tiny manual probe to verify osxphotos works:

```bash
node -e "
import('./pipeline/ingest/apple-photos.js').then(async m => {
  const records = await m.loadAppleLibraryMetadata();
  console.log('records:', records.length);
  if (records.length) {
    const sample = records[0];
    console.log('sample keys:', Object.keys(sample));
    const { photo, faces, place } = m.normalizeApplePhoto(sample);
    console.log('photo:', JSON.stringify(photo).slice(0, 200));
    console.log('faces:', faces);
    console.log('place:', place);
  }
});
"
```

Expected: prints a record count and sample. If osxphotos is slow on a large library this can take 1-2 minutes. If it errors with "not found" or permission denied, report BLOCKED with the message — the user may need to grant Terminal full-disk-access in System Settings → Privacy & Security.

- [ ] **Step 4: Commit**

```bash
git add pipeline/ingest/apple-photos.js
git commit -m "feat(photos): Apple Photos ingest via osxphotos"
```

---

## Task 5: Message attachments ingest

**Files:**
- Create: `pipeline/ingest/message-attachments.js`

Walks two source directories. For each photo found, hashes the file and links it to the relevant `messages.id` row using existing thread context.

- [ ] **Step 1: Implement the module**

`pipeline/ingest/message-attachments.js`:

```javascript
import fs from 'fs';
import path from 'path';
import os from 'os';
import { hashFile } from '../normalize/photo-dedup.js';

const IMAGE_EXT = /\.(jpe?g|png|heic|heif|webp|gif|tiff?)$/i;

/**
 * Walk a directory recursively, return all file paths matching IMAGE_EXT.
 */
function walkImages(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkImages(full));
    else if (IMAGE_EXT.test(e.name)) out.push(full);
  }
  return out;
}

/**
 * iMessage attachments live at ~/Library/Messages/Attachments/
 * Subdirectory structure varies but the basename includes the message GUID.
 *
 * We can't perfectly reverse-link without scanning the chat.db's
 * `attachment` table. For v1 we hash every image, look up by attachment
 * filename in chat.db, and link if found.
 */
export async function loadIMessageAttachments(conn, attachmentsRoot) {
  const root = attachmentsRoot || path.join(os.homedir(), 'Library', 'Messages', 'Attachments');
  const files = walkImages(root);

  // Pull attachment → message linkage from chat.db (already linked into our DB
  // would be ideal but we don't track this yet, so query directly via duckdb_sqlite_scan
  // or via a separate sqlite read). For simplicity we just leave message_id null
  // for now and rely on the Apple Photos "imported via Messages" tag for linking.
  // (See spec — message-attachment linking is best-effort in v1.)

  const results = [];
  for (const fp of files) {
    let h;
    try { h = await hashFile(fp); } catch { continue; }
    results.push({
      photo: {
        id: `sha256:${h}`,
        apple_uuid: null,
        ts: fs.statSync(fp).mtimeMs,
        ts_iso: new Date(fs.statSync(fp).mtimeMs).toISOString(),
        source: 'imessage',
        source_ref: null,
        message_id: null,    // best-effort linkage in a future iteration
        asset_path: fp,
        width: null,
        height: null,
        hash_sha256: h,
        has_named_face: false,
      },
      faces: [],
      place: null,
    });
  }
  return results;
}

/**
 * Instagram exports keep message photos at:
 *   <export_root>/your_instagram_activity/messages/inbox/<thread>/photos/*
 * Each thread is keyed by handle_id matching what the existing parser uses.
 */
export async function loadInstagramAttachments(exportRoot) {
  const inbox = path.join(exportRoot, 'your_instagram_activity', 'messages', 'inbox');
  if (!fs.existsSync(inbox)) return [];

  const results = [];
  const threadDirs = fs.readdirSync(inbox).filter(d =>
    fs.statSync(path.join(inbox, d)).isDirectory()
  );

  for (const dir of threadDirs) {
    const photoDir = path.join(inbox, dir, 'photos');
    if (!fs.existsSync(photoDir)) continue;
    const files = walkImages(photoDir);
    for (const fp of files) {
      let h;
      try { h = await hashFile(fp); } catch { continue; }
      results.push({
        photo: {
          id: `sha256:${h}`,
          apple_uuid: null,
          ts: fs.statSync(fp).mtimeMs,
          ts_iso: new Date(fs.statSync(fp).mtimeMs).toISOString(),
          source: 'instagram',
          source_ref: `ig:${dir}`,
          message_id: null,
          asset_path: fp,
          width: null,
          height: null,
          hash_sha256: h,
          has_named_face: false,
        },
        faces: [],
        place: null,
      });
    }
  }
  return results;
}
```

- [ ] **Step 2: Quick syntax check**

```bash
node --check pipeline/ingest/message-attachments.js
```

Expected: silent success.

- [ ] **Step 3: Quick smoke test on a tiny subset**

```bash
node -e "
import('./pipeline/ingest/message-attachments.js').then(async m => {
  // Find any IG export dir
  const fs = await import('fs');
  const dirs = fs.default.readdirSync('.').filter(d => d.startsWith('instagram-'));
  if (!dirs.length) { console.log('no ig export found'); return; }
  console.log('IG export:', dirs[0]);
  const ig = await m.loadInstagramAttachments(dirs[0]);
  console.log('IG photos:', ig.length);
  if (ig.length) console.log('sample:', JSON.stringify(ig[0].photo).slice(0, 200));
});
"
```

Expected: prints a number of IG photos found. Skip iMessage attachments smoke for now — that's slower and we'll exercise it in Task 11.

- [ ] **Step 4: Commit**

```bash
git add pipeline/ingest/message-attachments.js
git commit -m "feat(photos): message attachments ingest (iMessage + Instagram)"
```

---

## Task 6: Reverse geocoding

**Files:**
- Create: `pipeline/ingest/reverse-geocode.js`

GPS coordinates → place names. Uses Nominatim (OSM) which is free but rate-limited (1 request per second). Caches results in the `reverse_geocode_cache` DuckDB table, rounded to 3 decimal places (~110m precision) so nearby points share cache hits.

- [ ] **Step 1: Implement the module**

`pipeline/ingest/reverse-geocode.js`:

```javascript
const NOMINATIM = 'https://nominatim.openstreetmap.org/reverse';
const RATE_LIMIT_MS = 1100;  // 1 req/sec + 10% headroom

function roundCoord(c) {
  return Math.round(c * 1000) / 1000;
}

/**
 * Reverse-geocode a list of (lat, lng) tuples, using the DuckDB cache to skip
 * coords already resolved. Inserts new resolutions into the cache.
 *
 * @param {Array<{lat, lng}>} coords
 * @param {DuckDBConnection} conn
 * @returns {Promise<Map<string, {place_name, city, region, country}>>}
 *          keyed by "lat_round,lng_round"
 */
export async function reverseGeocodeAll(coords, conn) {
  // Collect unique rounded coords
  const unique = new Map();
  for (const { lat, lng } of coords) {
    if (lat == null || lng == null) continue;
    const key = `${roundCoord(lat)},${roundCoord(lng)}`;
    if (!unique.has(key)) unique.set(key, { lat: roundCoord(lat), lng: roundCoord(lng) });
  }

  // Pull existing cache hits
  const cached = new Map();
  const cacheReader = await conn.runAndReadAll(`SELECT lat_round, lng_round, place_name, city, region, country FROM reverse_geocode_cache`);
  for (const row of cacheReader.getRows()) {
    const [lat, lng, place_name, city, region, country] = row;
    cached.set(`${lat},${lng}`, { place_name, city, region, country });
  }

  // Compute the misses
  const misses = [...unique.entries()].filter(([k, _]) => !cached.has(k));
  console.log(`  ${cached.size} cached, ${misses.length} to fetch`);

  // Fetch misses sequentially with rate limiting
  for (const [key, { lat, lng }] of misses) {
    const url = `${NOMINATIM}?format=json&lat=${lat}&lon=${lng}&zoom=14`;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'social-graph-pipeline/1.0' },
      });
      if (!res.ok) {
        console.error(`  geocode failed for ${key}: ${res.status}`);
        continue;
      }
      const j = await res.json();
      const addr = j.address || {};
      const result = {
        place_name: j.display_name || null,
        city: addr.city || addr.town || addr.village || addr.suburb || null,
        region: addr.state || addr.county || null,
        country: addr.country || null,
      };
      cached.set(key, result);
      // Insert into cache
      await conn.run(`
        INSERT INTO reverse_geocode_cache (lat_round, lng_round, place_name, city, region, country)
        VALUES (${lat}, ${lng}, ${esc(result.place_name)}, ${esc(result.city)}, ${esc(result.region)}, ${esc(result.country)})
      `);
    } catch (err) {
      console.error(`  geocode error for ${key}: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
  }

  return cached;
}

function esc(s) {
  if (s == null) return 'NULL';
  return "'" + String(s).replace(/'/g, "''") + "'";
}
```

- [ ] **Step 2: Quick syntax check**

```bash
node --check pipeline/ingest/reverse-geocode.js
```

Expected: silent success.

- [ ] **Step 3: Commit**

```bash
git add pipeline/ingest/reverse-geocode.js
git commit -m "feat(photos): reverse geocoder via Nominatim with DB cache"
```

---

## Task 7: Event clustering (pure function, TDD)

**Files:**
- Create: `pipeline/analyze/events.js`
- Test: `pipeline/analyze/events.test.js`

Greedy time-and-location clustering, configurable thresholds.

- [ ] **Step 1: Write the failing test**

`pipeline/analyze/events.test.js`:

```javascript
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { clusterEvents, haversineKm } from './events.js';

const ms = (iso) => new Date(iso).getTime();

test('haversineKm computes distance correctly', () => {
  // Sydney to Melbourne ≈ 714km
  const d = haversineKm({ lat: -33.8688, lng: 151.2093 }, { lat: -37.8136, lng: 144.9631 });
  assert.ok(d > 700 && d < 730, `expected ~714km, got ${d}`);
  // Same point = 0
  assert.equal(haversineKm({ lat: 0, lng: 0 }, { lat: 0, lng: 0 }), 0);
});

test('clusterEvents groups photos within time window', () => {
  const photos = [
    { id: 'a', ts: ms('2024-06-01T10:00:00Z'), lat: 40.7, lng: -74.0 },
    { id: 'b', ts: ms('2024-06-01T11:00:00Z'), lat: 40.7, lng: -74.0 },
    { id: 'c', ts: ms('2024-06-01T12:00:00Z'), lat: 40.7, lng: -74.0 },
    { id: 'd', ts: ms('2024-06-15T10:00:00Z'), lat: 40.7, lng: -74.0 },
    { id: 'e', ts: ms('2024-06-15T11:00:00Z'), lat: 40.7, lng: -74.0 },
    { id: 'f', ts: ms('2024-06-15T12:00:00Z'), lat: 40.7, lng: -74.0 },
  ];
  const events = clusterEvents(photos, { timeGapHours: 6, locationKm: 1, minPhotos: 3 });
  assert.equal(events.length, 2);
  assert.equal(events[0].photos.length, 3);
  assert.equal(events[1].photos.length, 3);
});

test('clusterEvents splits clusters when location jumps', () => {
  const photos = [
    { id: 'a', ts: ms('2024-06-01T10:00:00Z'), lat: 40.7, lng: -74.0 }, // NYC
    { id: 'b', ts: ms('2024-06-01T11:30:00Z'), lat: 40.7, lng: -74.0 }, // NYC
    { id: 'c', ts: ms('2024-06-01T13:00:00Z'), lat: 40.7, lng: -74.0 }, // NYC
    { id: 'd', ts: ms('2024-06-01T14:30:00Z'), lat: 51.5, lng: -0.1 },  // London
    { id: 'e', ts: ms('2024-06-01T16:00:00Z'), lat: 51.5, lng: -0.1 },  // London
    { id: 'f', ts: ms('2024-06-01T17:30:00Z'), lat: 51.5, lng: -0.1 },  // London
  ];
  const events = clusterEvents(photos, { timeGapHours: 6, locationKm: 1, minPhotos: 3 });
  assert.equal(events.length, 2);
  assert.deepEqual(events[0].photos.map(p => p.id), ['a', 'b', 'c']);
  assert.deepEqual(events[1].photos.map(p => p.id), ['d', 'e', 'f']);
});

test('clusterEvents drops clusters under minPhotos', () => {
  const photos = [
    { id: 'a', ts: ms('2024-06-01T10:00:00Z'), lat: 40.7, lng: -74.0 },
    { id: 'b', ts: ms('2024-06-15T10:00:00Z'), lat: 40.7, lng: -74.0 },
    { id: 'c', ts: ms('2024-06-15T11:00:00Z'), lat: 40.7, lng: -74.0 },
    { id: 'd', ts: ms('2024-06-15T12:00:00Z'), lat: 40.7, lng: -74.0 },
  ];
  const events = clusterEvents(photos, { timeGapHours: 6, locationKm: 1, minPhotos: 3 });
  assert.equal(events.length, 1);
  assert.equal(events[0].photos.length, 3);
});

test('clusterEvents handles photos with no GPS gracefully', () => {
  const photos = [
    { id: 'a', ts: ms('2024-06-01T10:00:00Z'), lat: null, lng: null },
    { id: 'b', ts: ms('2024-06-01T11:00:00Z'), lat: null, lng: null },
    { id: 'c', ts: ms('2024-06-01T12:00:00Z'), lat: null, lng: null },
  ];
  const events = clusterEvents(photos, { timeGapHours: 6, locationKm: 1, minPhotos: 3 });
  assert.equal(events.length, 1);
  assert.equal(events[0].photos.length, 3);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test pipeline/analyze/events.test.js
```

Expected: FAIL with `Cannot find module './events.js'`.

- [ ] **Step 3: Implement the clusterer**

`pipeline/analyze/events.js`:

```javascript
const HOUR_MS = 3600 * 1000;

/**
 * Haversine distance in km between two {lat, lng} points.
 */
export function haversineKm(a, b) {
  const R = 6371;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x = Math.sin(dLat/2)**2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}

function clusterCenter(photos) {
  const withGps = photos.filter(p => p.lat != null && p.lng != null);
  if (withGps.length === 0) return null;
  const lat = withGps.reduce((s, p) => s + p.lat, 0) / withGps.length;
  const lng = withGps.reduce((s, p) => s + p.lng, 0) / withGps.length;
  return { lat, lng };
}

/**
 * Greedy time-location clustering.
 *
 * @param {Array} photos     - { id, ts, lat?, lng? } sorted by ts asc
 * @param {Object} opts
 * @param {number} opts.timeGapHours  default 6
 * @param {number} opts.locationKm    default 1.0
 * @param {number} opts.minPhotos     default 3
 * @returns {Array<{event_id, start_ts, end_ts, photos}>}
 */
export function clusterEvents(photos, opts = {}) {
  const { timeGapHours = 6, locationKm = 1.0, minPhotos = 3 } = opts;
  const gapMs = timeGapHours * HOUR_MS;
  const sorted = [...photos].sort((a, b) => a.ts - b.ts);
  if (sorted.length === 0) return [];

  const clusters = [];
  let current = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const p = sorted[i];
    const last = current[current.length - 1];
    const timeGap = p.ts - last.ts;

    let split = false;
    if (timeGap > gapMs) {
      split = true;
    } else if (p.lat != null && p.lng != null) {
      const center = clusterCenter(current);
      if (center && haversineKm(p, center) > locationKm && timeGap > HOUR_MS) {
        split = true;
      }
    }

    if (split) {
      clusters.push(current);
      current = [p];
    } else {
      current.push(p);
    }
  }
  clusters.push(current);

  // Filter under minPhotos and assemble result
  return clusters
    .filter(c => c.length >= minPhotos)
    .map(c => ({
      event_id: `evt_${new Date(c[0].ts).toISOString().slice(0, 10)}_${shortHash(c.map(p => p.id).join(''))}`,
      start_ts: c[0].ts,
      end_ts: c[c.length - 1].ts,
      photos: c,
    }));
}

function shortHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36).slice(0, 6);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test pipeline/analyze/events.test.js
```

Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add pipeline/analyze/events.js pipeline/analyze/events.test.js
git commit -m "feat(photos): event clustering — greedy time + location"
```

---

## Task 8: Per-event HTML page renderer

**Files:**
- Create: `pipeline/render/event-page.js`

Self-contained HTML showing photos + interleaved messages for one event.

- [ ] **Step 1: Implement the renderer**

`pipeline/render/event-page.js`:

```javascript
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * @param {Object} event - { event_id, start_ts, end_ts, place_name, participants }
 * @param {Array} photos - sorted by ts: { id, asset_path, ts, place_name? }
 * @param {Array} messages - sorted by ts: { ts, from_me, sender_name, body }
 * @param {Object} idLookup - canonical_id -> display_name map (for participants)
 */
export function renderEventPage({ event, photos, messages, idLookup = {} }) {
  const startISO = new Date(Number(event.start_ts)).toISOString().slice(0, 16).replace('T', ' ');
  const endISO = new Date(Number(event.end_ts)).toISOString().slice(0, 16).replace('T', ' ');
  const participantNames = (event.participants || []).map(id => idLookup[id] || id);

  // Time-merged stream of photos and messages
  const stream = [
    ...photos.map(p => ({ kind: 'photo', ts: Number(p.ts), data: p })),
    ...messages.map(m => ({ kind: 'message', ts: Number(m.ts), data: m })),
  ].sort((a, b) => a.ts - b.ts);

  const items = stream.map(item => {
    const time = new Date(item.ts).toISOString().slice(11, 16);
    if (item.kind === 'photo') {
      const p = item.data;
      const place = p.place_name ? `<div class="caption-place">${escapeHtml(p.place_name)}</div>` : '';
      return `<div class="item photo-item">
        <div class="time">${time}</div>
        <img src="file://${escapeHtml(p.asset_path)}" loading="lazy" />
        ${place}
      </div>`;
    } else {
      const m = item.data;
      const speaker = m.from_me ? 'You' : escapeHtml(m.sender_name || 'them');
      const body = escapeHtml(m.body || '').replace(/\n/g, '<br>');
      return `<div class="item msg-item ${m.from_me ? 'from-me' : 'from-them'}">
        <div class="time">${time}</div>
        <div class="speaker">${speaker}</div>
        <div class="body">${body}</div>
      </div>`;
    }
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(event.event_id)} — ${escapeHtml(event.place_name || '')}</title>
<style>
  :root { --bg:#fafaf7; --fg:#1c1c1c; --muted:#6a6a6a; --rule:#e0ddd5; --quote:#f1ede4; --accent:#5a5044; }
  @media (prefers-color-scheme: dark) { :root { --bg:#14130f; --fg:#e8e6e0; --muted:#a09b8e; --rule:#2a2825; --quote:#1d1b16; --accent:#c8bea8; } }
  body { font-family: 'Iowan Old Style', Georgia, serif; max-width: 760px; margin: 3rem auto; padding: 0 2rem 6rem; background: var(--bg); color: var(--fg); line-height: 1.6; }
  h1 { font-size: 1.6rem; margin: 0 0 0.4rem; }
  .meta { color: var(--muted); font-size: 0.9rem; margin-bottom: 2rem; padding-bottom: 1rem; border-bottom: 1px solid var(--rule); }
  .item { display: grid; grid-template-columns: 5em 1fr; gap: 0.8rem; margin: 0.8rem 0; }
  .time { color: var(--muted); font-family: ui-monospace, monospace; font-size: 0.78rem; padding-top: 0.2rem; }
  .photo-item img { max-width: 100%; border-radius: 4px; display: block; }
  .caption-place { color: var(--muted); font-size: 0.78rem; margin-top: 0.2rem; }
  .msg-item .speaker { font-weight: 600; color: var(--accent); }
  .msg-item .body { padding: 0.4rem 0.8rem; background: var(--quote); border-radius: 4px; margin-top: 0.2rem; }
  .from-me .body { background: #d8e8d8; }
  @media (prefers-color-scheme: dark) { .from-me .body { background: #2a3829; } }
</style>
</head>
<body>
  <h1>${escapeHtml(event.place_name || event.event_id)}</h1>
  <div class="meta">
    ${startISO} → ${endISO}<br>
    ${photos.length} photos · ${messages.length} messages
    ${participantNames.length ? `<br>With: ${participantNames.map(n => escapeHtml(n)).join(', ')}` : ''}
  </div>
  ${items}
</body>
</html>`;
}
```

- [ ] **Step 2: Quick syntax check**

```bash
node --check pipeline/render/event-page.js
```

Expected: silent success.

- [ ] **Step 3: Commit**

```bash
git add pipeline/render/event-page.js
git commit -m "feat(photos): per-event HTML renderer"
```

---

## Task 9: Index page renderer

**Files:**
- Create: `pipeline/render/event-index.js`

Lists all events in `pipeline/output/events/` with thumbnails and client-side filters.

- [ ] **Step 1: Implement the renderer**

`pipeline/render/event-index.js`:

```javascript
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Render the events index page.
 *
 * @param {Array} events - { event_id, start_ts, end_ts, place_name, participants_names, n_photos, n_messages, thumb_path? }
 */
export function renderEventIndex(events) {
  const sorted = [...events].sort((a, b) => Number(b.start_ts) - Number(a.start_ts));
  const dataJson = JSON.stringify(sorted.map(e => ({
    id: e.event_id,
    date: new Date(Number(e.start_ts)).toISOString().slice(0, 10),
    year: new Date(Number(e.start_ts)).getUTCFullYear(),
    place: e.place_name || '',
    participants: e.participants_names || [],
    n_photos: e.n_photos,
    n_messages: e.n_messages,
    thumb: e.thumb_path || null,
  })));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Events</title>
<style>
  :root { --bg:#fafaf7; --fg:#1c1c1c; --muted:#6a6a6a; --rule:#e0ddd5; --accent:#5a5044; }
  @media (prefers-color-scheme: dark) { :root { --bg:#14130f; --fg:#e8e6e0; --muted:#a09b8e; --rule:#2a2825; --accent:#c8bea8; } }
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 1100px; margin: 2rem auto; padding: 0 1.5rem 4rem; background: var(--bg); color: var(--fg); }
  h1 { margin: 0 0 1rem; }
  .filters { display: flex; gap: 0.6rem; margin-bottom: 1.2rem; flex-wrap: wrap; }
  .filters input, .filters select { padding: 0.4rem 0.6rem; border: 1px solid var(--rule); border-radius: 4px; background: var(--bg); color: var(--fg); font-size: 0.9rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 1rem; }
  .card { display: block; padding: 0.8rem; border: 1px solid var(--rule); border-radius: 6px; text-decoration: none; color: var(--fg); transition: background 0.15s; }
  .card:hover { background: rgba(127,127,127,0.06); }
  .card img { width: 100%; aspect-ratio: 4/3; object-fit: cover; border-radius: 4px; background: var(--rule); }
  .card .title { font-weight: 600; margin-top: 0.5rem; font-size: 0.95rem; }
  .card .sub { color: var(--muted); font-size: 0.8rem; margin-top: 0.15rem; }
  .empty { color: var(--muted); padding: 2rem; text-align: center; }
</style>
</head>
<body>
<h1>Events</h1>
<div class="filters">
  <input id="q" type="search" placeholder="Search place or person..." />
  <select id="year">
    <option value="">All years</option>
  </select>
  <select id="person">
    <option value="">All people</option>
  </select>
  <span id="count" class="sub" style="margin-left:auto;align-self:center;color:var(--muted);font-size:0.85rem"></span>
</div>
<div id="grid" class="grid"></div>

<script>
const DATA = ${dataJson};
const grid = document.getElementById('grid');
const $q = document.getElementById('q');
const $year = document.getElementById('year');
const $person = document.getElementById('person');
const $count = document.getElementById('count');

const years = [...new Set(DATA.map(e => e.year))].sort((a,b) => b-a);
for (const y of years) $year.append(new Option(y, y));
const people = [...new Set(DATA.flatMap(e => e.participants))].sort();
for (const p of people) $person.append(new Option(p, p));

function render() {
  const q = $q.value.toLowerCase().trim();
  const year = $year.value;
  const person = $person.value;
  const filtered = DATA.filter(e =>
    (!year || String(e.year) === year) &&
    (!person || e.participants.includes(person)) &&
    (!q || e.place.toLowerCase().includes(q) || e.participants.some(p => p.toLowerCase().includes(q)))
  );
  grid.innerHTML = filtered.map(e => \`
    <a class="card" href="\${e.id}.html">
      \${e.thumb ? \`<img src="file://\${e.thumb}" loading="lazy" />\` : '<div style="width:100%;aspect-ratio:4/3;background:var(--rule);border-radius:4px"></div>'}
      <div class="title">\${e.place || e.id}</div>
      <div class="sub">\${e.date} · \${e.n_photos} photos · \${e.n_messages} msgs</div>
      \${e.participants.length ? \`<div class="sub">\${e.participants.join(', ')}</div>\` : ''}
    </a>
  \`).join('');
  $count.textContent = filtered.length + ' / ' + DATA.length;
  if (filtered.length === 0) grid.innerHTML = '<div class="empty">No events match.</div>';
}
$q.oninput = $year.onchange = $person.onchange = render;
render();
</script>
</body>
</html>`;
}
```

- [ ] **Step 2: Quick syntax check**

```bash
node --check pipeline/render/event-index.js
```

Expected: silent success.

- [ ] **Step 3: Commit**

```bash
git add pipeline/render/event-index.js
git commit -m "feat(photos): event index page with client-side filters"
```

---

## Task 10: Orchestrator (build-photos.js)

**Files:**
- Create: `pipeline/build-photos.js`

End-to-end runner. Reads from sources, dedupes, inserts into DuckDB, clusters events, geocodes places, renders HTML pages.

- [ ] **Step 1: Implement the orchestrator**

`pipeline/build-photos.js`:

```javascript
#!/usr/bin/env node
/**
 * Photos layer orchestrator.
 *
 *   npm run build-photos
 *
 * Reads Apple Photos library (via osxphotos), iMessage attachments, and
 * Instagram exports. Hashes, dedupes, populates photos/photo_faces/places
 * tables. Clusters events. Reverse-geocodes. Renders HTML.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DuckDBInstance } from '@duckdb/node-api';

import { ensurePhotoSchema } from './normalize/photo-schema.js';
import { mergeDuplicates, hashFile, canonicalIdFor } from './normalize/photo-dedup.js';
import { loadAppleLibraryMetadata, normalizeApplePhoto, resolveFaces } from './ingest/apple-photos.js';
import { loadIMessageAttachments, loadInstagramAttachments } from './ingest/message-attachments.js';
import { reverseGeocodeAll } from './ingest/reverse-geocode.js';
import { clusterEvents } from './analyze/events.js';
import { renderEventPage } from './render/event-page.js';
import { renderEventIndex } from './render/event-index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DB_PATH = path.join(__dirname, 'output', 'raw', 'messages.duckdb');
const EVENTS_DIR = path.join(__dirname, 'output', 'events');

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

function esc(s) {
  if (s == null) return 'NULL';
  if (typeof s === 'number' || typeof s === 'bigint' || typeof s === 'boolean') return String(s);
  return "'" + String(s).replace(/'/g, "''") + "'";
}

async function main() {
  ensureDir(EVENTS_DIR);

  if (!fs.existsSync(DB_PATH)) {
    console.error(`DB not found at ${DB_PATH}. Run 'npm run build-db' first.`);
    process.exit(1);
  }

  console.log('Opening DuckDB...');
  const inst = await DuckDBInstance.create(DB_PATH);
  const conn = await inst.connect();
  await ensurePhotoSchema(conn);

  // ─── Stage 1: Apple Photos ───────────────────────────────────────────────
  console.log('\n[1/6] Reading Apple Photos library...');
  let appleRecords = [];
  try {
    appleRecords = await loadAppleLibraryMetadata();
    console.log(`  ${appleRecords.length} records`);
  } catch (err) {
    console.error(`  Apple Photos: ${err.message}`);
  }

  // ─── Stage 2: Message attachments ────────────────────────────────────────
  console.log('\n[2/6] Walking message attachments...');
  let imsgPhotos = await loadIMessageAttachments(conn);
  console.log(`  iMessage: ${imsgPhotos.length}`);

  // Find IG export dir
  const igCandidates = fs.readdirSync(ROOT).filter(d =>
    d.startsWith('instagram-') && fs.statSync(path.join(ROOT, d)).isDirectory()
  );
  let igPhotos = [];
  if (igCandidates.length) {
    igPhotos = await loadInstagramAttachments(path.join(ROOT, igCandidates.sort().reverse()[0]));
    console.log(`  Instagram: ${igPhotos.length}`);
  }

  // ─── Stage 3: Normalize + dedup ──────────────────────────────────────────
  console.log('\n[3/6] Normalizing and deduping...');
  const allRows = [];
  for (const a of appleRecords) {
    const { photo, faces, place } = normalizeApplePhoto(a);
    if (photo.asset_path && fs.existsSync(photo.asset_path)) {
      try { photo.hash_sha256 = await hashFile(photo.asset_path); } catch {}
    }
    allRows.push({ photo, faces, place });
  }
  for (const item of imsgPhotos) allRows.push(item);
  for (const item of igPhotos) allRows.push(item);

  const merged = mergeDuplicates(allRows.map(r => r.photo));
  console.log(`  ${allRows.length} → ${merged.length} after dedup`);

  // Index original rows by id so we can look up faces/place after merging
  const originalById = new Map();
  for (const item of allRows) originalById.set(item.photo.id, item);

  // ─── Stage 4: Insert ──────────────────────────────────────────────────────
  console.log('\n[4/6] Inserting into DuckDB...');
  // Wipe existing photos tables for a clean rebuild — incremental insertion
  // is a future improvement.
  await conn.run(`
    DELETE FROM photos;
    DELETE FROM photo_faces;
    DELETE FROM places;
    DELETE FROM events;
    DELETE FROM event_photos;
    DELETE FROM event_messages;
  `);

  for (const m of merged) {
    await conn.run(`
      INSERT INTO photos (id, ts, ts_iso, source, source_ref, message_id, asset_path, width, height, hash_sha256, has_named_face)
      VALUES (
        ${esc(m.id)}, ${m.ts}, ${esc(m.ts_iso)}, ${esc(m.source)}, ${esc(m.source_ref)},
        ${esc(m.message_id)}, ${esc(m.asset_path)}, ${esc(m.width)}, ${esc(m.height)},
        ${esc(m.hash_sha256)}, ${m.has_named_face}
      )
    `);
  }
  console.log(`  inserted ${merged.length} photos`);

  // Faces
  const idsReader = await conn.runAndReadAll(`SELECT canonical_id, display_name FROM identities WHERE display_name IS NOT NULL`);
  const nameToCanonical = new Map();
  for (const [cid, name] of idsReader.getRows()) {
    nameToCanonical.set(String(name).toLowerCase(), cid);
  }
  const allFaceRows = [];
  for (const item of allRows) {
    for (const name of item.faces) {
      allFaceRows.push({ photo_id: item.photo.id, name });
    }
  }
  const { matched, unmatched } = resolveFaces(allFaceRows, nameToCanonical);
  for (const f of matched) {
    await conn.run(`INSERT OR IGNORE INTO photo_faces VALUES (${esc(f.photo_id)}, ${esc(f.canonical_id)}, ${esc(f.face_cluster)})`);
  }
  console.log(`  faces: ${matched.length} matched, ${unmatched.length} unmatched`);
  if (unmatched.length) {
    console.log(`  unmatched names (${unmatched.length}): ${unmatched.slice(0, 10).join(', ')}${unmatched.length > 10 ? '...' : ''}`);
    console.log(`    → either rename in Photos.app or add as alias in your contacts.vcf and rerun`);
  }

  // Places (lat/lng only at this stage; reverse geocode later)
  for (const item of allRows) {
    if (item.place && item.place.lat != null && item.place.lng != null) {
      await conn.run(`INSERT OR IGNORE INTO places (photo_id, lat, lng) VALUES (${esc(item.photo.id)}, ${item.place.lat}, ${item.place.lng})`);
    }
  }

  // ─── Stage 5: Reverse geocode + cluster events ───────────────────────────
  console.log('\n[5/6] Reverse-geocoding places...');
  const allPlaceCoords = (await conn.runAndReadAll(`SELECT lat, lng FROM places`)).getRows().map(r => ({ lat: r[0], lng: r[1] }));
  const geocoded = await reverseGeocodeAll(allPlaceCoords, conn);
  // Update places with resolved names
  for (const [key, info] of geocoded.entries()) {
    const [lat, lng] = key.split(',').map(Number);
    await conn.run(`
      UPDATE places SET place_name = ${esc(info.place_name)}, city = ${esc(info.city)}, region = ${esc(info.region)}, country = ${esc(info.country)}
      WHERE ABS(lat - ${lat}) < 0.001 AND ABS(lng - ${lng}) < 0.001
    `);
  }

  console.log('\n[6/6] Clustering events and rendering HTML...');
  const photoRows = (await conn.runAndReadAll(`
    SELECT p.id, p.ts, p.asset_path, pl.lat, pl.lng, pl.place_name, pl.city
    FROM photos p
    LEFT JOIN places pl ON pl.photo_id = p.id
    ORDER BY p.ts
  `)).getRows().map(r => ({
    id: r[0], ts: Number(r[1]), asset_path: r[2], lat: r[3], lng: r[4], place_name: r[5] || r[6],
  }));

  const events = clusterEvents(photoRows, {
    timeGapHours: parseFloat(process.env.EVENT_TIME_GAP_H || '6'),
    locationKm: parseFloat(process.env.EVENT_LOCATION_KM || '1'),
    minPhotos: parseInt(process.env.EVENT_MIN_PHOTOS || '3', 10),
  });
  console.log(`  ${events.length} events`);

  // Insert events + render pages
  const messagePadH = parseFloat(process.env.EVENT_MESSAGE_PADDING_H || '12');
  const padMs = messagePadH * 3600 * 1000;

  // Identity map for participant labels
  const idLookup = {};
  const idRows = (await conn.runAndReadAll(`SELECT canonical_id, display_name FROM identities`)).getRows();
  for (const [cid, name] of idRows) idLookup[cid] = name;

  const eventSummaries = [];
  for (const ev of events) {
    // Find faces present in this event's photos
    const photoIds = ev.photos.map(p => `'${p.id.replace(/'/g, "''")}'`).join(',');
    const faceRows = (await conn.runAndReadAll(`SELECT DISTINCT canonical_id FROM photo_faces WHERE photo_id IN (${photoIds})`)).getRows();
    const participants = faceRows.map(r => r[0]);

    // Find messages within the event's time window
    const startPad = ev.start_ts - padMs;
    const endPad = ev.end_ts + padMs;
    const msgs = (await conn.runAndReadAll(`
      SELECT id, ts, from_me, sender_name, body
      FROM messages
      WHERE meaningful AND ts BETWEEN ${startPad} AND ${endPad}
      ORDER BY ts
      LIMIT 200
    `)).getRows().map(r => ({
      id: r[0], ts: Number(r[1]), from_me: r[2], sender_name: r[3], body: r[4],
    }));

    // Place name from majority of cluster's places
    const places = (await conn.runAndReadAll(`
      SELECT place_name, city, COUNT(*) AS n FROM places WHERE photo_id IN (${photoIds})
      GROUP BY place_name, city ORDER BY n DESC LIMIT 1
    `)).getRows();
    const place_name = places.length ? (places[0][1] || places[0][0] || null) : null;

    // Insert event row
    const partsArr = `[${participants.map(p => `'${p}'`).join(',')}]`;
    await conn.run(`
      INSERT INTO events (event_id, start_ts, end_ts, place_name, participants, n_photos, n_messages)
      VALUES (${esc(ev.event_id)}, ${ev.start_ts}, ${ev.end_ts}, ${esc(place_name)}, ${partsArr}, ${ev.photos.length}, ${msgs.length})
    `);
    for (const p of ev.photos) {
      await conn.run(`INSERT OR IGNORE INTO event_photos VALUES (${esc(ev.event_id)}, ${esc(p.id)})`);
    }
    for (const m of msgs) {
      await conn.run(`INSERT OR IGNORE INTO event_messages VALUES (${esc(ev.event_id)}, ${esc(m.id)})`);
    }

    // Render page
    const html = renderEventPage({
      event: { ...ev, place_name, participants },
      photos: ev.photos,
      messages: msgs,
      idLookup,
    });
    fs.writeFileSync(path.join(EVENTS_DIR, `${ev.event_id}.html`), html);

    eventSummaries.push({
      event_id: ev.event_id,
      start_ts: ev.start_ts,
      end_ts: ev.end_ts,
      place_name,
      participants_names: participants.map(p => idLookup[p] || p),
      n_photos: ev.photos.length,
      n_messages: msgs.length,
      thumb_path: ev.photos[0]?.asset_path || null,
    });
  }

  // Render index
  const indexHtml = renderEventIndex(eventSummaries);
  fs.writeFileSync(path.join(EVENTS_DIR, 'index.html'), indexHtml);

  await conn.disconnectSync();
  console.log(`\nDone. Open pipeline/output/events/index.html in a browser.`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
```

- [ ] **Step 2: Quick syntax check**

```bash
node --check pipeline/build-photos.js
```

Expected: silent success.

- [ ] **Step 3: Commit**

```bash
git add pipeline/build-photos.js
git commit -m "feat(photos): orchestrator — ingest, cluster, geocode, render"
```

---

## Task 11: End-to-end smoke test

**Files:**
- (No new files. Run the orchestrator against real data.)

The implementation is complete; this task validates that everything works together against the user's actual library and exports.

- [ ] **Step 1: Ensure prerequisites**

Confirm:
- `osxphotos` is installed and works: `osxphotos --version`
- DuckDB exists: `ls pipeline/output/raw/messages.duckdb`
- Terminal has full-disk access (System Settings → Privacy & Security → Full Disk Access → Terminal). If not, the iMessage attachments scan will silently see nothing.

- [ ] **Step 2: Run the build**

```bash
npm run build-photos
```

Expected stages output:
- Stage 1: "Apple Photos library: NN records"
- Stage 2: "iMessage: NN, Instagram: NN"
- Stage 3: "AAA → BB after dedup"
- Stage 4: insert + face matching report (some unmatched names is normal)
- Stage 5: reverse-geocoding (slow — 1 req/sec; first run can take 10-20 minutes for a heavily-traveled library)
- Stage 6: clustering + page rendering

If reverse-geocoding is too slow on first run, abort with Ctrl-C and re-run with `EVENT_LOCATION_KM=10` to coarsen clusters and reduce unique coords. Subsequent runs hit the cache.

- [ ] **Step 3: Inspect the output**

```bash
ls pipeline/output/events/ | head
open pipeline/output/events/index.html
```

Confirm:
- Index page loads
- Year and person filters populate
- Clicking into an event shows photos with timestamps and the messages from that period

- [ ] **Step 4: Spot-check one event**

Pick an event you remember (e.g., a trip). Open its HTML page. Confirm:
- The right photos are present
- Photos are in chronological order
- Messages from your conversation around that time are interleaved
- Named faces (if you've named any in Photos.app) link to participant labels

- [ ] **Step 5: Test the face-naming workflow**

In Photos.app, name 1-2 face clusters. Re-run `npm run build-photos`. Confirm:
- Console output shows "faces: more matched than before"
- `event.participants` lists now include those names

- [ ] **Step 6: Commit any tweaks**

If the smoke test surfaces real issues you fixed:

```bash
git add -p
git commit -m "fix(photos): <what you changed>"
```

---

## Notes for the implementer

- The orchestrator wipes the photos tables on every run for simplicity. Incremental ingestion (skip already-hashed asset UUIDs) is a future improvement.
- iMessage attachment → message linking is left as `null` in v1. Linking requires querying `chat.db`'s `attachment` table; this is best done as a separate enhancement once the basic pipeline works.
- The reverse geocoder is rate-limited at 1 req/sec to respect Nominatim's terms. First runs on heavily-traveled libraries take a long time; subsequent runs are nearly instant due to caching.
- The HTML pages reference photos via `file://` URLs. They only render correctly on the original machine. If you want shareable pages later, copy assets into `pipeline/output/events/assets/` and use relative paths.
- `clusterEvents` is pure and well-tested; if you want different defaults, override via env vars at orchestrator runtime, don't change the function.
- The face-naming workflow is forward-compatible — re-running ingest after naming new clusters is fast (most stages cache or no-op).
