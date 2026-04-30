import fs from 'fs';
import path from 'path';
import { fixMojibake, isMeaningfulMessage } from '../normalize/schema.js';

/**
 * Parse Instagram inbox export.
 *
 * Expected layout:
 *   inputs/instagram/your_instagram_activity/messages/inbox/<thread_id>/message_*.json
 */

export function parseInstagramThread(threadDir) {
  const files = fs.readdirSync(threadDir)
    .filter(f => /^message_\d+\.json$/.test(f))
    .map(f => path.join(threadDir, f))
    .sort();

  if (files.length === 0) return null;

  const allMessages = [];
  let participants = null;

  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!participants) {
      participants = (data.participants || []).map(p => fixMojibake(p.name || ''));
    }
    for (const m of data.messages || []) {
      allMessages.push(m);
    }
  }

  allMessages.sort((a, b) => a.timestamp_ms - b.timestamp_ms);

  const others = participants.filter(p => p !== 'George Gao');
  const isGroup = others.length > 1;
  const threadId = `ig:${path.basename(threadDir)}`;

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
      source: 'instagram',
      isGroup,
      participants: others,
      attachmentType,
    };
  });

  return {
    threadId,
    isGroup,
    participants: others,
    sources: ['instagram'],
    messages: normalized,
  };
}

export function parseInstagramExport(rootDir) {
  const inboxDir = path.join(rootDir, 'your_instagram_activity', 'messages', 'inbox');
  if (!fs.existsSync(inboxDir)) {
    throw new Error(`Instagram inbox not found at ${inboxDir}`);
  }

  const threads = [];
  for (const dir of fs.readdirSync(inboxDir)) {
    const threadDir = path.join(inboxDir, dir);
    if (!fs.statSync(threadDir).isDirectory()) continue;
    try {
      const thread = parseInstagramThread(threadDir);
      if (thread && thread.messages.length > 0) threads.push(thread);
    } catch (err) {
      console.warn(`Skipping ${dir}: ${err.message}`);
    }
  }

  console.log(`Instagram: parsed ${threads.length} threads`);
  return threads;
}
