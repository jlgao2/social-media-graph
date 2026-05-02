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
