const crypto = require('node:crypto');
const path = require('node:path');
const cfg = require('./config');
const people = require('./people');
const gowa = require('./gowa');
const { redact, toJid } = require('./redact');

function verifySignature(rawBody, header, secret = cfg.webhookSecret) {
  if (!rawBody || !header) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  const received = Buffer.from(String(header).replace(/^sha256=/, ''), 'hex');
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

// AlmaEd holds the numbers; a sender may arrive as a phone JID, a LID, or both.
const findSender = (lookup, p) => lookup([p.from, p.from_lid].filter(Boolean));

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

// Which conversation a message belongs to. Never guesses: a leading #tag wins, then a swipe-reply to an
// earlier relayed message, then the only assigned student; otherwise the sender is asked and nothing is sent.
const TAG = /^\s*#([\w-]+)\s*/;
function route(pairs, body, prev, noun) {
  const tags = pairs.map((x) => `#${x.tag}`).join(' or ');
  const m = body.match(TAG);
  if (m) {
    // filter, not find: the unique index should make duplicates impossible, but a duplicate that slips in
    // must refuse rather than pick one at random and deliver to the wrong parent.
    const hits = pairs.filter((x) => x.tag === m[1].toLowerCase());
    if (hits.length === 1) return { pair: hits[0], body: body.slice(m[0].length) };
    return { refuse: hits.length
      ? `More than one ${noun} has the tag #${m[1]}, so your message was not sent. Please tell the admin.`
      : `No ${noun} has the tag #${m[1]}. Use ${tags}.` };
  }
  if (prev) {
    const pair = pairs.find((x) => x.teacher_id === prev.teacher_id && x.student_id === prev.student_id);
    return pair ? { pair, body } : { refuse: 'That conversation has ended, so your message was not sent.' };
  }
  if (pairs.length === 1) return { pair: pairs[0], body };
  return { refuse: `Which ${noun}? Start your message with ${tags}.` };
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
  const direction = isTeacher ? 'TEACHER_TO_STUDENT' : 'STUDENT_TO_TEACHER';
  const noun = isTeacher ? 'student' : 'child';

  const sender = await findSender(isTeacher ? people.findTeacher : people.findParent, p);
  if (!sender) {
    // Relay numbers may also receive ordinary chats, so unknown senders are only logged, never alerted.
    // The identifiers are logged because this is also what a mistyped phone number looks like, and
    // without them there is no way to tell that apart from an ordinary stranger messaging in.
    return console.log(`[relay] ignored message from unknown sender on ${role} number`,
      `(from=${p.from || '-'} from_lid=${p.from_lid || '-'})`);
  }
  const reply = (text) => gowa.sendText(ownDevice, sender.wa_jid, text);
  const pairs = await (isTeacher ? people.studentsOfTeacher : people.childrenOfParent)(sender.wa_jid);

  const m = classify(p);
  if (m.kind === 'ignore') return;
  let body = m.kind === 'text' ? m.text : m.caption || '';

  if (/^\s*#list\s*$/i.test(body)) {
    return reply(pairs.length
      ? `Your ${noun === 'child' ? 'children' : 'students'}:\n` +
        pairs.map((x) => `#${x.tag} ${x.student}${isTeacher ? '' : ` (teacher ${x.teacher})`}`).join('\n')
      : `No ${noun} is assigned to you.`);
  }
  if (!pairs.length) {
    await reply(`No ${noun} is assigned to you yet. The admin has been notified.`);
    return alertOnce(`unassigned:${role}:${sender.id}`,
      `${isTeacher ? 'Teacher' : 'Parent'} "${sender.name || sender.wa_jid}" (id ${sender.id}) sent a message but has no ${noun} assigned.`);
  }

  const isResult = isTeacher && /#result\b/i.test(body);
  if (isResult) body = body.replace(/#result\b/gi, '').trim();
  const prev = p.replied_to_id ? await people.pairOfMessage(p.replied_to_id) : null;
  const r = route(pairs, body, prev, noun);

  // Nothing to log against when routing failed, so a refusal leaves no row - see the media
  // branches below, which always answer the sender instead.
  const log = (content, status, outId = null) => r.pair && people.log({
    teacherId: r.pair.teacher_id, studentId: r.pair.student_id, direction,
    waMessageId: p.id, outMessageId: outId, content, status,
  }).catch((err) => console.error('[relay] log failed:', err.message));

  // Media is never relayed whatever it routes to, so the sender is always told - including when routing
  // failed, where there is no pair to log against and silence would look like a successful send.
  if (m.kind === 'contact') {
    log('[contact card dropped]', 'DROPPED');
    return reply('Contact cards are not relayed. Please send the details as text.');
  }
  if (m.kind === 'unsupported') {
    log('[media dropped: only text and documents are relayed]', 'DROPPED');
    return reply(isTeacher
      ? 'Images, audio, video and locations are not relayed. Please send notes as a PDF/document.'
      : 'Images, audio, video and locations are not relayed. Please send text or a PDF/document.');
  }
  if (r.refuse) return reply(r.refuse);

  const { pair } = r;
  const { text, flagged } = redact(r.body);
  if (flagged) return log(text, 'FLAGGED');

  const label = isTeacher
    ? `Teacher ${pair.teacher} (for ${pair.student})${isResult ? ' - Test result' : ''}`
    : `Student ${pair.student} (#${pair.tag})`;
  const out = text.trim() ? `${label}:\n${text}` : label;
  const to = isTeacher ? pair.parent_jid : pair.teacher_jid;

  let sent;
  if (m.kind === 'document') {
    if (!m.path) {
      log('[document not downloaded by gowa]', 'DROPPED');
      return alertOnce(`nodoc:${pair.teacher_id}:${pair.student_id}`,
        `${pair.teacher} / ${pair.student}: a document could not be relayed (gowa auto-download-media is off?).`);
    }
    const file = await gowa.fetchMedia(m.path);
    sent = await gowa.sendFile(otherDevice, to, file, `${pair.tag}${m.ext}`, out);
  } else {
    sent = await gowa.sendText(otherDevice, to, out);
  }

  log(text, 'RELAYED', sent?.message_id || null);
}

async function handleWebhook(req, res) {
  if (!verifySignature(req.rawBody, req.get('X-Hub-Signature-256'))) return res.sendStatus(401);

  const { event, device_id: deviceId, payload: p } = req.body || {};
  // Only 1:1 chats: skip groups, status updates (status@broadcast), broadcast lists and channels (@newsletter).
  const oneToOne = /@(s\.whatsapp\.net|lid)$/.test(String(p?.chat_id || p?.from || ''));
  if (event !== 'message' || !p || p.is_from_me || !oneToOne) return res.sendStatus(200);
  if (p.id && await people.seen(p.id)) return res.sendStatus(200); // gowa retry of an already-handled message

  try {
    await relay(deviceId, p);
    res.sendStatus(200);
  } catch (err) {
    console.error('[relay] failed:', err.message);
    res.sendStatus(500); // let gowa retry; the messages log makes the retry idempotent
  }
}

module.exports = { handleWebhook, relay, verifySignature };
