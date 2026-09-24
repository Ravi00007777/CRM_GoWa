const crypto = require('node:crypto');
const path = require('node:path');
const cfg = require('./config');
const people = require('./people');
const groups = require('./groups');
const gowa = require('./gowa');
const { redact, toJid } = require('./redact');

function verifySignature(rawBody, header, secret = cfg.webhookSecret) {
  if (!rawBody || !header) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  const received = Buffer.from(String(header).replace(/^sha256=/, ''), 'hex');
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
}

const userPart = (j) => String(j ?? '').split('@')[0].split(':')[0];

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

// A message in one of AlmaEd's groups. The group says which conversation it is, so nothing has
// to be tagged. Only the one teacher or student in that group is relayed: the admin is there to
// watch, and anything the relay itself posted is skipped.
async function relayGroup(chatJid, p) {
  const side = await groups.sideOfGroup(chatJid);
  if (!side) return; // an ordinary group one of the relay numbers happens to be in

  const pair = await people.pairOf(side.teacherId, side.studentId);
  if (!pair) return console.log('[groups] message for a pair that is no longer assigned, ignored');

  // WhatsApp names the sender differently in a group than in a 1:1 chat, and gowa passes
  // several shapes through, so every candidate is checked against the one person expected here.
  const expected = userPart(side.isTeacher ? pair.teacher_jid : pair.parent_jid);
  const candidates = [p.participant, p.sender, p.from, p.from_lid].filter(Boolean).map(userPart);
  if (!candidates.includes(expected)) {
    return console.log(`[groups] ignored ${candidates.join('/') || 'unknown'} in ${chatJid}` +
      ` (only ${expected} is relayed from this group)`);
  }

  const ownDevice = side.isTeacher ? cfg.teacherDevice : cfg.studentDevice;
  const otherDevice = side.isTeacher ? cfg.studentDevice : cfg.teacherDevice;
  const to = side.isTeacher ? side.studentGroupJid : side.teacherGroupJid;

  const reply = (text) => gowa.sendText(ownDevice, chatJid, text);
  const direction = side.isTeacher ? 'TEACHER_TO_STUDENT' : 'STUDENT_TO_TEACHER';
  const log = (content, status, outId = null) => people.log({
    teacherId: side.teacherId, studentId: side.studentId, direction,
    waMessageId: p.id, outMessageId: outId, content, status,
  }).catch((err) => console.error('[relay] log failed:', err.message));

  const m = classify(p);
  if (m.kind === 'ignore') return;

  // Teachers write on the AlmaEd site (doubt chat and resources), which the outbox sends
  // on; their group only shows what students send.
  if (side.isTeacher) {
    log('[teacher wrote in the WhatsApp group; not relayed]', 'DROPPED');
    return reply('Please send messages and assignments from the AlmaEd website. Messages typed here are not passed on.');
  }

  if (m.kind === 'contact') {
    log('[contact card dropped]', 'DROPPED');
    return reply('Contact cards are not relayed. Please send the details as text.');
  }
  if (m.kind === 'unsupported') {
    log('[media dropped: only text and documents are relayed]', 'DROPPED');
    return reply('Images, audio, video and locations are not relayed. Please send text or a PDF/document.');
  }

  let body = m.kind === 'text' ? m.text : m.caption || '';
  const isResult = side.isTeacher && /#result\b/i.test(body);
  if (isResult) body = body.replace(/#result\b/gi, '').trim();

  const { text, flagged } = redact(body);
  if (flagged) {
    log(text, 'FLAGGED');
    return reply('That message was not passed on: it looked like a phone number or email address.');
  }

  const label = side.isTeacher
    ? `Teacher ${pair.teacher}${isResult ? ' - Test result' : ''}`
    : `Student ${pair.student}`;
  const out = text.trim() ? `${label}:\n${text}` : label;

  // The teacher reads and answers on the site, so the doubt thread gets the message first;
  // the copy in the teacher's WhatsApp group is only a phone notification.
  if (!side.isTeacher) {
    await people.saveDoubt({
      batchId: pair.batch_id, studentId: side.studentId, waMessageId: p.id,
      body: m.kind === 'document' ? `${text}\n[sent a document on WhatsApp]`.trim() : text,
    }).catch((err) => console.error('[relay] saving doubt failed:', err.message));
  }
  if (!to) return console.error(`[groups] ${chatJid} has no counterpart group yet`);

  let sent;
  if (m.kind === 'document') {
    if (!m.path) return log('[document not downloaded by gowa]', 'DROPPED');
    const file = await gowa.fetchMedia(m.path);
    sent = await gowa.sendFile(otherDevice, to, file, `${pair.tag}${m.ext}`, out);
  } else {
    sent = await gowa.sendText(otherDevice, to, out);
  }
  log(text, 'RELAYED', sent?.message_id || null);
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
  const chat = String(p?.chat_id || p?.from || '');
  const oneToOne = /@(s\.whatsapp\.net|lid)$/.test(chat);
  const isGroup = /@g\.us$/.test(chat);
  if (event !== 'message' || !p || p.is_from_me || (!oneToOne && !isGroup)) return res.sendStatus(200);
  if (p.id && await people.seen(p.id)) return res.sendStatus(200); // gowa retry of an already-handled message

  try {
    await (isGroup ? relayGroup(chat, p) : relay(deviceId, p));
    res.sendStatus(200);
  } catch (err) {
    console.error('[relay] failed:', err.message);
    res.sendStatus(500); // let gowa retry; the messages log makes the retry idempotent
  }
}

module.exports = { handleWebhook, relay, verifySignature };
