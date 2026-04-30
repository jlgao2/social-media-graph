import fs from 'fs';

/**
 * Parse a vCard (.vcf) file and produce a phone/email -> name map.
 *
 * Apple's vCard exports include phone numbers in TEL: fields, sometimes in
 * NOTE: text, sometimes with item1.TEL: prefixes for non-default labels, and
 * occasionally with directional unicode marks. This parser handles those.
 */

function stripControlChars(s) {
  return [...s].filter(c => c.codePointAt(0) >= 0x20 || c === '\n' || c === '\r' || c === '\t').join('');
}

function digitsOnly(s) {
  return s.replace(/\D/g, '');
}

export function parseVcf(filePath) {
  if (!fs.existsSync(filePath)) {
    console.warn(`Contacts: file not found at ${filePath}, name resolution will be limited`);
    return { phones: {}, emails: {} };
  }

  const raw = stripControlChars(fs.readFileSync(filePath, 'utf-8'));
  const cards = raw.split('BEGIN:VCARD');

  const phones = {};
  const emails = {};

  for (const card of cards) {
    const fnMatch = /^FN[^:]*:(.+)$/m.exec(card);
    const nMatch = /^N[^:]*:(.+)$/m.exec(card);
    const name = (fnMatch && fnMatch[1].trim())
      || (nMatch && nMatch[1].split(';').filter(Boolean).join(' ').trim())
      || null;
    if (!name) continue;

    // TEL fields
    for (const m of card.matchAll(/TEL[^:]*:([^\r\n]+)/g)) {
      const d = digitsOnly(m[1]);
      if (d.length >= 7) {
        const key = '+' + d;
        if (!phones[key]) phones[key] = name;
      }
    }
    // Phone numbers in NOTE
    for (const m of card.matchAll(/NOTE[^:]*:([^\r\n]+)/g)) {
      for (const phone of m[1].matchAll(/\+?[\d\s\-()]{8,}/g)) {
        const d = digitsOnly(phone[0]);
        if (d.length >= 8) {
          const key = '+' + d;
          if (!phones[key]) phones[key] = name;
        }
      }
    }
    // EMAIL fields
    for (const m of card.matchAll(/EMAIL[^:]*:([^\r\n]+)/g)) {
      const e = m[1].trim().toLowerCase();
      if (!emails[e]) emails[e] = name;
    }
  }

  console.log(`Contacts: ${Object.keys(phones).length} phones, ${Object.keys(emails).length} emails mapped`);
  return { phones, emails };
}
