#!/usr/bin/env node
/**
 * Build a DuckDB index of all parsed messages, threads, and identities.
 *
 *   node pipeline/build-db.js
 *
 * Reads from the same sources as cli.js (auto-detects exports). Writes to
 * pipeline/output/raw/messages.duckdb. Idempotent — wipes and rebuilds the file.
 *
 * Schema:
 *   messages        — every meaningful message across all sources
 *   threads         — one row per thread (1-on-1 or group)
 *   identities      — canonical people, with aliases as a list
 *   thread_identity — link from thread → canonical person (for 1-on-1 only)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DuckDBInstance } from '@duckdb/node-api';

import { parseInstagramExport } from './ingest/instagram.js';
import { parseImessageExport } from './ingest/imessage.js';
import { parseWhatsappExport } from './ingest/whatsapp.js';
import { parseMessengerExport } from './ingest/messenger.js';
import { parseVcf } from './ingest/contacts.js';
import { loadIcsBirthdays } from './ingest/birthdays-ics.js';
import { resolveIdentities } from './normalize/identity.js';
import { isMeaningfulMessage } from './normalize/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const INPUTS = path.join(ROOT, 'inputs');
const OUTPUT = path.join(__dirname, 'output');
const RAW = path.join(OUTPUT, 'raw');
const DB_PATH = path.join(RAW, 'messages.duckdb');

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

function loadAllThreads() {
  const allThreads = [];

  let igRoot = path.join(INPUTS, 'instagram');
  if (!fs.existsSync(igRoot)) {
    const candidates = fs.readdirSync(ROOT).filter(d => d.startsWith('instagram-') && fs.statSync(path.join(ROOT, d)).isDirectory());
    igRoot = candidates.length ? path.join(ROOT, candidates.sort().reverse()[0]) : null;
  }
  if (igRoot && fs.existsSync(igRoot)) allThreads.push(...parseInstagramExport(igRoot));

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

  let contactsPath = path.join(INPUTS, 'contacts.vcf');
  if (!fs.existsSync(contactsPath)) {
    const cd = path.join(ROOT, 'contacts');
    if (fs.existsSync(cd)) {
      const vcfs = fs.readdirSync(cd).filter(f => f.endsWith('.vcf'));
      if (vcfs.length) contactsPath = path.join(cd, vcfs[0]);
    }
  }
  const contacts = parseVcf(contactsPath);

  // Load any .ics birthday files (e.g., from fb2cal) — optional.
  const icsDir = path.join(INPUTS, 'birthdays');
  const icsBirthdays = loadIcsBirthdays(icsDir);
  if (icsBirthdays.length) {
    console.log(`Birthdays (ICS): ${icsBirthdays.length} from ${path.relative(ROOT, icsDir)}`);
  }

  // Dedupe by lowercase name + month + day (vCard wins over ICS for the same person)
  const seen = new Set();
  const allBirthdays = [];
  for (const b of (contacts.birthdays || [])) {
    const key = `${(b.name || '').toLowerCase()}|${b.month}|${b.day}`;
    if (seen.has(key)) continue;
    seen.add(key);
    allBirthdays.push({ ...b, source: 'vcard' });
  }
  for (const b of icsBirthdays) {
    const key = `${(b.name || '').toLowerCase()}|${b.month}|${b.day}`;
    if (seen.has(key)) continue;
    seen.add(key);
    allBirthdays.push({ ...b, source: 'ics' });
  }

  const { identities } = resolveIdentities(allThreads, contacts);
  return { threads: allThreads, identities, birthdays: allBirthdays };
}

function escapeSql(s) {
  if (s == null) return 'NULL';
  return "'" + String(s).replace(/'/g, "''") + "'";
}

async function main() {
  ensureDir(RAW);

  if (fs.existsSync(DB_PATH)) {
    fs.unlinkSync(DB_PATH);
    console.log(`Removed existing ${path.relative(ROOT, DB_PATH)}`);
  }

  console.log('Loading and parsing all sources...');
  const { threads, identities, birthdays } = loadAllThreads();
  console.log(`  ${threads.length} threads, ${identities.length} identities`);

  const totalMsgs = threads.reduce((s, t) => s + t.messages.length, 0);
  console.log(`  ${totalMsgs.toLocaleString()} total raw messages`);

  console.log('\nOpening DuckDB...');
  const instance = await DuckDBInstance.create(DB_PATH);
  const conn = await instance.connect();

  // Schema
  await conn.run(`
    CREATE TABLE messages (
      id          VARCHAR PRIMARY KEY,
      ts          BIGINT NOT NULL,
      ts_iso      VARCHAR,
      source      VARCHAR NOT NULL,
      thread_id   VARCHAR NOT NULL,
      from_me     BOOLEAN NOT NULL,
      sender_name VARCHAR,
      body        VARCHAR,
      body_lower  VARCHAR,
      meaningful  BOOLEAN NOT NULL,
      attachment_type VARCHAR
    );
    CREATE INDEX idx_messages_thread ON messages(thread_id);
    CREATE INDEX idx_messages_ts     ON messages(ts);

    CREATE TABLE threads (
      thread_id    VARCHAR PRIMARY KEY,
      source       VARCHAR NOT NULL,
      is_group     BOOLEAN NOT NULL,
      participants VARCHAR[]
    );

    CREATE TABLE identities (
      canonical_id VARCHAR PRIMARY KEY,
      display_name VARCHAR,
      aliases      VARCHAR[],
      sources      VARCHAR[]
    );

    CREATE TABLE thread_identity (
      thread_id    VARCHAR NOT NULL,
      canonical_id VARCHAR NOT NULL,
      PRIMARY KEY (thread_id, canonical_id)
    );

    CREATE TABLE birthdays (
      canonical_id VARCHAR,
      name         VARCHAR NOT NULL,
      month        INTEGER NOT NULL,
      day          INTEGER NOT NULL,
      year         INTEGER,
      year_known   BOOLEAN NOT NULL,
      source       VARCHAR NOT NULL
    );
    CREATE INDEX idx_birthdays_canonical ON birthdays(canonical_id);
    CREATE INDEX idx_birthdays_md ON birthdays(month, day);
  `);
  console.log('Schema created.');

  // Bulk insert messages via VALUES batches.
  console.log('Inserting messages...');
  const BATCH = 1000;
  let inserted = 0;
  let buffer = [];

  const flush = async () => {
    if (buffer.length === 0) return;
    const sql = `INSERT INTO messages VALUES ${buffer.join(',')}`;
    await conn.run(sql);
    inserted += buffer.length;
    buffer = [];
    process.stdout.write(`\r  inserted ${inserted.toLocaleString()} / ${totalMsgs.toLocaleString()}`);
  };

  for (const thread of threads) {
    for (const m of thread.messages) {
      const body = m.body || '';
      const meaningful = isMeaningfulMessage(m);
      const tsIso = new Date(m.ts).toISOString();
      const row = `(
        ${escapeSql(m.id)},
        ${m.ts},
        ${escapeSql(tsIso)},
        ${escapeSql(m.source)},
        ${escapeSql(m.threadId)},
        ${m.from === 'me'},
        ${escapeSql(m.senderName)},
        ${escapeSql(body)},
        ${escapeSql(body.toLowerCase())},
        ${meaningful},
        ${escapeSql(m.attachmentType)}
      )`;
      buffer.push(row);
      if (buffer.length >= BATCH) await flush();
    }
  }
  await flush();
  console.log(`\n  done — ${inserted.toLocaleString()} messages`);

  // Threads
  console.log('Inserting threads...');
  for (const t of threads) {
    const parts = `[${(t.participants || []).map(escapeSql).join(',')}]`;
    await conn.run(`INSERT INTO threads VALUES (${escapeSql(t.threadId)}, ${escapeSql(t.sources[0])}, ${t.isGroup}, ${parts})`);
  }
  console.log(`  done — ${threads.length}`);

  // Identities
  console.log('Inserting identities...');
  for (const id of identities) {
    const aliases = `[${(id.aliases || []).map(escapeSql).join(',')}]`;
    const sources = `[${(id.sources || []).map(escapeSql).join(',')}]`;
    await conn.run(`INSERT INTO identities VALUES (${escapeSql(id.canonicalId)}, ${escapeSql(id.displayName)}, ${aliases}, ${sources})`);
  }
  console.log(`  done — ${identities.length}`);

  // thread_identity links (only 1-on-1 threads have an "other" identity)
  console.log('Inserting thread→identity links...');
  let links = 0;
  for (const t of threads) {
    if (t.isGroup || !t.other) continue;
    await conn.run(`INSERT INTO thread_identity VALUES (${escapeSql(t.threadId)}, ${escapeSql(t.other.canonicalId)})`);
    links++;
  }
  console.log(`  done — ${links}`);

  // Birthdays (vCard-derived). Best-effort canonical_id resolution by name.
  console.log('Inserting birthdays...');
  // Build a name→canonical_id index from identities
  const nameToCanonical = new Map();
  for (const id of identities) {
    if (id.displayName) nameToCanonical.set(id.displayName.toLowerCase(), id.canonicalId);
    for (const alias of (id.aliases || [])) {
      if (alias) nameToCanonical.set(String(alias).toLowerCase(), id.canonicalId);
    }
  }
  let bdayCount = 0, bdayResolved = 0;
  for (const b of birthdays) {
    const canId = nameToCanonical.get(b.name.toLowerCase()) || null;
    if (canId) bdayResolved++;
    await conn.run(`
      INSERT INTO birthdays (canonical_id, name, month, day, year, year_known, source)
      VALUES (${escapeSql(canId)}, ${escapeSql(b.name)}, ${b.month}, ${b.day}, ${b.year ?? 'NULL'}, ${b.year_known}, ${escapeSql(b.source || 'vcard')})
    `);
    bdayCount++;
  }
  console.log(`  done — ${bdayCount} birthdays, ${bdayResolved} resolved to a canonical identity`);

  // Quick stats
  const showStat = async (label, sql) => {
    const reader = await conn.runAndReadAll(sql);
    const rows = reader.getRows();
    console.log(`  ${label.padEnd(30)} ${rows[0][0]}`);
  };

  console.log('\nSummary:');
  await showStat('messages (total)', 'SELECT COUNT(*) FROM messages');
  await showStat('messages (meaningful)', 'SELECT COUNT(*) FROM messages WHERE meaningful');
  await showStat('messages from me', 'SELECT COUNT(*) FROM messages WHERE from_me');
  await showStat('messages from them', 'SELECT COUNT(*) FROM messages WHERE NOT from_me');
  await showStat('threads (1-on-1)', 'SELECT COUNT(*) FROM threads WHERE NOT is_group');
  await showStat('threads (group)', 'SELECT COUNT(*) FROM threads WHERE is_group');
  await showStat('identities', 'SELECT COUNT(*) FROM identities');
  await showStat('birthdays', 'SELECT COUNT(*) FROM birthdays');
  await showStat('birthdays w/ canonical', 'SELECT COUNT(*) FROM birthdays WHERE canonical_id IS NOT NULL');

  await conn.disconnectSync();

  const sizeMB = (fs.statSync(DB_PATH).size / 1024 / 1024).toFixed(1);
  console.log(`\nWrote ${path.relative(ROOT, DB_PATH)} (${sizeMB} MB)`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
