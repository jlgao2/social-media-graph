import fs from 'fs';
import path from 'path';
import { fixMojibake } from '../normalize/schema.js';

/**
 * Parse Facebook Messenger JSON export.
 *
 * Same shape as Instagram (Meta uses the same exporter):
 *   inputs/messenger/messages/inbox/<thread_id>/message_*.json
 */

export function parseMessengerThread(threadDir) {
  const files = fs.readdirSync(threadDir)
    .filter(f => /^message_\d+\.json$/.test(f))
    .sort()
    .map(f => path.join(threadDir, f));

  if (files.length === 0) return null;

  const allMessages = [];
  let participants = null;

  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!participants) participants = (data.participants || []).map(p => fixMojibake(p.name || ''));
    for (const m of data.messages || []) allMessages.push(m);
  }

  allMessages.sort((a, b) => a.timestamp_ms - b.timestamp_ms);

  const others = participants.filter(p => p !== 'George Gao');
  const isGroup = others.length > 1;
  const threadId = `fb:${path.basename(threadDir)}`;

  const normalized = allMessages.map((m, idx) => {
    const senderName = fixMojibake(m.sender_name || '');
    const body = fixMojibake(m.content || '');
    let attachmentType = null;
    if (m.photos) attachmentType = 'image';
    else if (m.videos) attachmentType = 'video';
    else if (m.audio_files) attachmentType = 'audio';

    return {
      id: `${threadId}#${idx}`,
      ts: m.timestamp_ms,
      from: senderName === 'George Gao' ? 'me' : 'them',
      senderName,
      body,
      threadId,
      source: 'messenger',
      isGroup,
      participants: others,
      attachmentType,
    };
  });

  return {
    threadId,
    isGroup,
    participants: others,
    sources: ['messenger'],
    messages: normalized,
  };
}

export function parseMessengerExport(rootDir) {
  const inboxDir = path.join(rootDir, 'messages', 'inbox');
  if (!fs.existsSync(inboxDir)) {
    console.log(`Messenger: no inbox at ${inboxDir}, skipping`);
    return [];
  }
  const threads = [];
  for (const dir of fs.readdirSync(inboxDir)) {
    const threadDir = path.join(inboxDir, dir);
    if (!fs.statSync(threadDir).isDirectory()) continue;
    try {
      const t = parseMessengerThread(threadDir);
      if (t && t.messages.length > 0) threads.push(t);
    } catch (err) {
      console.warn(`Messenger: skipping ${dir}: ${err.message}`);
    }
  }
  console.log(`Messenger: parsed ${threads.length} threads`);
  return threads;
}
