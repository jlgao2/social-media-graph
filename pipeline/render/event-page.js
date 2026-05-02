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
