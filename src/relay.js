const crypto = require('node:crypto');
const path = require('node:path');
const db = require('./db');
const cfg = require('./config');
const gowa = require('./gowa');
const { redact, toJid } = require('./redact');

function verifySignature(rawBody, header, secret = cfg.webhookSecret) {
  if (!rawBody || !header) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  const received = Buffer.from(String(header).replace(/^sha256=/, ''), 'hex');
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

const q = {
  teacherByJid: db.prepare('SELECT * FROM teachers WHERE wa_jid = ?'),
  studentByJid: db.prepare('SELECT * FROM students WHERE parent_wa_jid = ?'),
  // Teacher<->student is always 1:1, so the latest class identifies the other party.
  classForTeacher: db.prepare(`
    SELECT c.*, s.parent_wa_jid AS other_jid FROM classes c JOIN students s ON s.id = c.student_id
    WHERE c.teacher_id = ? ORDER BY c.held_at DESC, c.id DESC LIMIT 1`),
  classForStudent: db.prepare(`
    SELECT c.*, t.wa_jid AS other_jid FROM classes c JOIN teachers t ON t.id = c.teacher_id
    WHERE c.student_id = ? ORDER BY c.held_at DESC, c.id DESC LIMIT 1`),
  seen: db.prepare('SELECT 1 FROM messages WHERE wa_message_id = ?'),
  log: db.prepare(`INSERT OR IGNORE INTO messages (class_id, direction, wa_message_id, content, status, sent_at)
                   VALUES (?, ?, ?, ?, ?, ?)`),
  notesSent: db.prepare('UPDATE classes SET notes_sent_at = ? WHERE id = ? AND notes_sent_at IS NULL'),
  resultSent: db.prepare('UPDATE classes SET test_result_sent_at = ? WHERE id = ? AND test_result_sent_at IS NULL'),
};

function findSender(role, p) {
  const lookup = role === 'teacher' ? q.teacherByJid : q.studentByJid;
  for (const v of [p.from, p.from_lid]) {
    if (!v) continue;
    const tries = [String(v)];
    try { tries.push(toJid(v)); } catch { /* LID or malformed: raw value only */ }
    for (const jid of tries) {
      const row = lookup.get(jid);
      if (row) return row;
    }
  }
  return null;
}

function classify(p) {
  if (p.contact || /BEGIN:VCARD/i.test(p.body || '')) return { kind: 'contact' };
  if (p.document) {
    const d = typeof p.document === 'string' ? { path: p.document } : p.document;
    const name = d.filename || d.file_name || d.path || '';
    if (/\.vcf$/i.test(name) || /vcard/i.test(d.mime_type || '')) return { kind: 'contact' };
    const ext = path.extname(d.path || name);
    return { kind: 'document', path: d.path, caption: d.caption || '', ext: /^\.[a-z0-9]{1,5}$/i.test(ext) ? ext : '' };
  }
  if (['image', 'video', 'audio', 'sticker', 'video_note', 'location'].some((k) => p[k])) return { kind: 'unsupported' };
  if (p.body) return { kind: 'text', text: p.body };
  return { kind: 'ignore' }; // reactions, polls, etc.
}

// At most one admin alert per key per day, and alert failures never fail the webhook
// (a failed webhook makes gowa retry, which would repeat the alert).
// ponytail: in-memory, resets on restart; persist in SQLite if restarts cause repeat alerts.
const DAY = 24 * 3600e3;
const lastAlert = new Map();
async function alertOnce(key, text) {
  const now = Date.now();
  if (now - (lastAlert.get(key) || 0) < DAY) return;
  lastAlert.set(key, now);
  try { await gowa.alertAdmin(text); } catch (err) { console.error('[relay] admin alert failed:', err.message); }
}

async function relay(deviceId, p) {
  const role = await gowa.roleOfDevice(deviceId);
  if (!role) return console.warn('[relay] event from unknown device, ignored');

  const isTeacher = role === 'teacher';
  const ownDevice = isTeacher ? cfg.teacherDevice : cfg.studentDevice;
  const otherDevice = isTeacher ? cfg.studentDevice : cfg.teacherDevice;
  const direction = isTeacher ? 'teacher_to_student' : 'student_to_teacher';

  const sender = findSender(role, p);
  if (!sender) {
    // Relay numbers may also receive ordinary chats, so unknown senders are only logged, never alerted.
    return console.log(`[relay] ignored message from unknown sender on ${role} number`);
  }
  const senderJid = isTeacher ? sender.wa_jid : sender.parent_wa_jid;

  const cls = (isTeacher ? q.classForTeacher : q.classForStudent).get(sender.id);
  if (!cls) {
    await gowa.sendText(ownDevice, senderJid, 'No class is scheduled for you yet. The admin has been notified.');
    return alertOnce(`noclass:${role}:${sender.id}`, `${role} "${sender.name}" (id ${sender.id}) sent a message but has no class.`);
  }

  const now = new Date().toISOString();
  const log = (content, status) => q.log.run(cls.id, direction, p.id || null, content, status, now);
  const m = classify(p);

  if (m.kind === 'ignore') return;
  if (m.kind === 'contact') return log('[contact card dropped]', 'dropped');
  if (m.kind === 'unsupported') {
    log('[media dropped: only text and documents are relayed]', 'dropped');
    return gowa.sendText(ownDevice, senderJid, isTeacher
      ? 'Images, audio, video and locations are not relayed. Please send notes as a PDF/document.'
      : 'Images, audio, video and locations are not relayed. Please send text or a PDF/document.');
  }

  let body = m.kind === 'text' ? m.text : m.caption;
  const isResult = isTeacher && /#result\b/i.test(body);
  if (isResult) body = body.replace(/#result\b/gi, '').trim();

  const { text, flagged } = redact(body);
  if (flagged) return log(text, 'flagged');

  const label = `${isTeacher ? 'Teacher' : 'Student'} ${sender.name}${isResult ? ' - Test result' : ''}`;
  const out = text.trim() ? `${label}:\n${text}` : label;

  if (m.kind === 'document') {
    if (!m.path) {
      log('[document not downloaded by gowa]', 'dropped');
      return gowa.alertAdmin(`Class #${cls.id}: a document could not be relayed (gowa auto-download-media is off?).`);
    }
    const file = await gowa.fetchMedia(m.path);
    await gowa.sendFile(otherDevice, cls.other_jid, file, `class-${cls.id}${m.ext}`, out);
  } else {
    await gowa.sendText(otherDevice, cls.other_jid, out);
  }

  log(text, 'relayed');
  if (isResult) q.resultSent.run(now, cls.id);
  else if (isTeacher && m.kind === 'document') q.notesSent.run(now, cls.id);
}

async function handleWebhook(req, res) {
  if (!verifySignature(req.rawBody, req.get('X-Hub-Signature-256'))) return res.sendStatus(401);

  const { event, device_id: deviceId, payload: p } = req.body || {};
  // Only 1:1 chats: skip groups, status updates (status@broadcast), broadcast lists and channels (@newsletter).
  const oneToOne = /@(s\.whatsapp\.net|lid)$/.test(String(p?.chat_id || p?.from || ''));
  if (event !== 'message' || !p || p.is_from_me || !oneToOne) return res.sendStatus(200);
  if (p.id && q.seen.get(p.id)) return res.sendStatus(200); // gowa retry of an already-handled message

  try {
    await relay(deviceId, p);
    res.sendStatus(200);
  } catch (err) {
    console.error('[relay] failed:', err.message);
    res.sendStatus(500); // let gowa retry; the messages log makes the retry idempotent
  }
}

module.exports = { handleWebhook, relay, verifySignature };
