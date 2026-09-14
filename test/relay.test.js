// Runs without gowa: global fetch is mocked, DB is in-memory.
Object.assign(process.env, {
  DB_PATH: ':memory:', GOWA_BASE_URL: 'http://gowa.test', GOWA_BASIC_AUTH: 'u:p',
  TEACHER_DEVICE_ID: 'teacher', STUDENT_DEVICE_ID: 'student', WEBHOOK_SECRET: 's3cret',
  ADMIN_WA_JID: '910000000000@s.whatsapp.net', ADMIN_TOKEN: 't', NOTES_SLA_HOURS: '24', REMINDER_GAP_HOURS: '12',
});

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { redact, assertSafeOutbound, toJid } = require('../src/redact');
const { dueDates } = require('../src/schedule');
const db = require('../src/db');
const { relay, verifySignature } = require('../src/relay');
const { runReminders } = require('../src/reminders');

const sent = [];
global.fetch = async (url, opts = {}) => {
  if (url.endsWith('/devices')) {
    return Response.json({ code: 'SUCCESS', results: [
      { id: 'teacher', jid: '911111111111@s.whatsapp.net' }, { id: 'student', jid: '912222222222@s.whatsapp.net' }] });
  }
  if (url.includes('/statics/media/')) return new Response('PDFDATA');
  const body = opts.body instanceof FormData ? Object.fromEntries(opts.body) : JSON.parse(opts.body);
  sent.push({ url, device: opts.headers['X-Device-Id'], body });
  return Response.json({ code: 'SUCCESS', results: { message_id: 'out1' } });
};

const T = '919876543210@s.whatsapp.net';
const S = '918765432109@s.whatsapp.net';
db.prepare("INSERT INTO teachers (id, name, wa_jid, payout_email) VALUES (1, 'Asha', ?, 'asha@pay.in')").run(T);
db.prepare("INSERT INTO students (id, name, parent_wa_jid, parent_payment_email) VALUES (1, 'Diya', ?, 'p@pay.in')").run(S);
db.prepare(`INSERT INTO classes (id, teacher_id, student_id, held_at, notes_due_at, test_result_due_at)
  VALUES (1, 1, 1, '2026-09-14T11:00:00.000Z', '2026-09-15T11:00:00.000Z', '2026-09-21T05:30:00.000Z')`).run();

test('redact: phone shapes, emails, wa links; keeps normal text', () => {
  for (const s of ['98765 43210', '+91-98765-43210', '(987) 654.3210', '919876543210', 'wa.me/919876543210', 'a@b.com']) {
    assert.equal(redact(s).flagged, true, s);
  }
  assert.deepEqual(redact('call me on 98765-43210 after class'),
    { text: 'call me on [number removed] after class', flagged: false });
  const keep = 'Class at 5:30 pm, test 45/50, meet.google.com/abc-defg-hij';
  assert.deepEqual(redact(keep), { text: keep, flagged: false });
});

test('outbound guard, JID normalisation, due dates', () => {
  assert.throws(() => assertSafeOutbound('pay a@b.com from 9876543210'));
  assert.doesNotThrow(() => assertSafeOutbound('pay a@b.com'));
  assert.equal(toJid('98765 43210', '91'), '919876543210@s.whatsapp.net');
  assert.throws(() => toJid('98765', '91'));
  // Monday 16:30 IST class -> notes +24h; test Sunday 20 Sep 11:00 IST -> result due Monday 11:00 IST
  assert.deepEqual(dueDates('2026-09-14T16:30:00+05:30', 24, 11), {
    held_at: '2026-09-14T11:00:00.000Z', notes_due_at: '2026-09-15T11:00:00.000Z', test_result_due_at: '2026-09-21T05:30:00.000Z' });
  // Sunday class -> next Sunday's test
  assert.equal(dueDates('2026-09-20T18:00:00+05:30', 0, 11).test_result_due_at, '2026-09-27T05:30:00.000Z');
});

test('HMAC signature', () => {
  const raw = Buffer.from('{"a":1}');
  const sig = 'sha256=' + crypto.createHmac('sha256', 's3cret').update(raw).digest('hex');
  assert.equal(verifySignature(raw, sig), true);
  assert.equal(verifySignature(raw, sig.replace(/.$/, '0')), false);
  assert.equal(verifySignature(raw, 'sha256=abc'), false);
});

test('teacher text -> redacted, sent via STUDENT device to parent', async () => {
  sent.length = 0;
  await relay('911111111111@s.whatsapp.net', { id: 'm1', from: T, body: 'my number 98765 43210, email me x@y.com' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].device, 'student');
  assert.equal(sent[0].body.phone, S);
  assert.equal(sent[0].body.message, 'Teacher Asha:\nmy number [number removed], email me [email removed]');
  assert.equal(db.prepare("SELECT content FROM messages WHERE wa_message_id='m1'").get().content,
    'my number [number removed], email me [email removed]');
});

test('student (LID sender, phone in from_lid) -> teacher device', async () => {
  sent.length = 0;
  await relay('912222222222@s.whatsapp.net', { id: 'm2', from: '251556368777322@lid', from_lid: S, body: 'ok' });
  assert.equal(sent[0].device, 'teacher');
  assert.equal(sent[0].body.phone, T);
});

test('number-only message flagged; contact card dropped; image nudges sender', async () => {
  sent.length = 0;
  await relay('teacher', { id: 'm3', from: T, body: '+91 98765 43210' });
  await relay('teacher', { id: 'm4', from: T, contact: { vcard: 'BEGIN:VCARD' } });
  await relay('teacher', { id: 'm5', from: T, image: 'statics/media/x.jpg' });
  const status = db.prepare("SELECT wa_message_id, status FROM messages WHERE wa_message_id IN ('m3','m4','m5') ORDER BY id").all();
  assert.deepEqual(status.map((r) => r.status), ['flagged', 'dropped', 'dropped']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.phone, T); // nudge back to teacher, not relayed
  assert.equal(db.prepare('SELECT notes_sent_at FROM classes WHERE id = 1').get().notes_sent_at, null);
});

test('reminders: 1st at due, 2nd after gap + admin alert + followup; document marks notes sent', async () => {
  sent.length = 0;
  const due = Date.parse('2026-09-15T11:00:00.000Z');
  await runReminders(due + 60e3);
  await runReminders(due + 2 * 60e3); // within gap -> nothing
  await runReminders(due + 12 * 3600e3 + 60e3);
  await runReminders(due + 30 * 3600e3); // capped at 2
  assert.deepEqual(sent.map((s) => s.body.phone), [T, T, '910000000000@s.whatsapp.net']);
  assert.equal(db.prepare('SELECT needs_followup FROM classes WHERE id = 1').get().needs_followup, 1);

  sent.length = 0;
  await relay('teacher', { id: 'm6', from: T, document: { path: 'statics/media/n/1-Asha_9876543210.pdf', caption: 'notes' } });
  assert.equal(sent[0].device, 'student');
  assert.equal(sent[0].body.file.name, 'class-1.pdf'); // original filename (may hold a number) never leaves
  assert.ok(db.prepare('SELECT notes_sent_at FROM classes WHERE id = 1').get().notes_sent_at);

  await relay('teacher', { id: 'm7', from: T, body: '#result 42/50, great work' });
  assert.equal(sent[1].body.message, 'Teacher Asha - Test result:\n42/50, great work');
  assert.ok(db.prepare('SELECT test_result_sent_at FROM classes WHERE id = 1').get().test_result_sent_at);
});
