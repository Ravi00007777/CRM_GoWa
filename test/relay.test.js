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
const realFetch = globalThis.fetch;
global.fetch = async (url, opts = {}) => {
  if (url.endsWith('/devices')) {
    return Response.json({ code: 'SUCCESS', results: [
      { id: 'teacher', jid: '911111111111@s.whatsapp.net' }, { id: 'student', jid: '912222222222@s.whatsapp.net' }] });
  }
  if (url.includes('/statics/media/')) return new Response('PDFDATA');
  const body = opts.body instanceof FormData ? Object.fromEntries(opts.body) : JSON.parse(opts.body);
  sent.push({ url, device: opts.headers['X-Device-Id'], body });
  return Response.json({ code: 'SUCCESS', results: { message_id: `out${sent.length}` } });
};

const T = '919876543210@s.whatsapp.net';
const S = '918765432109@s.whatsapp.net';
db.prepare("INSERT INTO teachers (id, name, wa_jid, payout_email) VALUES (1, 'Asha', ?, 'asha@pay.in')").run(T);
db.prepare("INSERT INTO parents (id, name, wa_jid, payment_email) VALUES (1, 'Mrs Sharma', ?, 'p@pay.in')").run(S);
db.prepare("INSERT INTO students (id, name, tag, parent_id, teacher_id) VALUES (1, 'Diya', 'diya', 1, 1)").run();
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
  assert.equal(sent[0].body.message, 'Teacher Asha (for Diya):\nmy number [number removed], email me [email removed]');
  assert.equal(db.prepare("SELECT content FROM messages WHERE wa_message_id='m1'").get().content,
    'my number [number removed], email me [email removed]');
});

test('student (LID sender, phone in from_lid) -> teacher device', async () => {
  sent.length = 0;
  await relay('912222222222@s.whatsapp.net', { id: 'm2', from: '251556368777322@lid', from_lid: S, body: 'ok' });
  assert.equal(sent[0].device, 'teacher');
  assert.equal(sent[0].body.phone, T);
});

test('unknown sender: ignored, nothing sent (no admin alert, no reply)', async () => {
  sent.length = 0;
  for (const id of ['u1', 'u2', 'u3']) await relay('teacher', { id, from: '915555555555@s.whatsapp.net', body: 'hi' });
  assert.equal(sent.length, 0);
});

test('number-only message flagged; contact card dropped; image nudges sender', async () => {
  sent.length = 0;
  await relay('teacher', { id: 'm3', from: T, body: '+91 98765 43210' });
  await relay('teacher', { id: 'm4', from: T, contact: { vcard: 'BEGIN:VCARD' } });
  await relay('teacher', { id: 'm5', from: T, image: 'statics/media/x.jpg' });
  const status = db.prepare("SELECT wa_message_id, status FROM messages WHERE wa_message_id IN ('m3','m4','m5') ORDER BY id").all();
  assert.deepEqual(status.map((r) => r.status), ['flagged', 'dropped', 'dropped']);
  assert.deepEqual(sent.map((s) => s.body.phone), [T, T]); // both nudges go back to the teacher, nothing relayed
  assert.match(sent[0].body.message, /Contact cards are not relayed/);
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
  assert.equal(sent[1].body.message, 'Teacher Asha (for Diya) - Test result:\n42/50, great work');
  assert.ok(db.prepare('SELECT test_result_sent_at FROM classes WHERE id = 1').get().test_result_sent_at);
});

test('multi-student teacher + sibling parent: #tag, swipe-reply, ask when unclear, ended assignment', async () => {
  const S2 = '917777777777@s.whatsapp.net';
  const R = '913333333333@s.whatsapp.net';
  db.prepare("INSERT INTO teachers (id, name, wa_jid) VALUES (2, 'Ravi', ?)").run(R);
  db.prepare("INSERT INTO parents (id, wa_jid) VALUES (2, ?)").run(S2);
  db.prepare("INSERT INTO students (id, name, tag, parent_id, teacher_id) VALUES (2, 'Rohan', 'rohan', 2, 1)").run(); // Asha's 2nd student
  db.prepare("INSERT INTO students (id, name, tag, parent_id, teacher_id) VALUES (3, 'Kabir', 'kabir', 1, 2)").run(); // Diya's brother, Ravi
  const msg = () => sent.at(-1).body;

  // Teacher with 2 students, no tag, no reply -> asked, nothing relayed
  sent.length = 0;
  await relay('teacher', { id: 'r1', from: T, body: 'homework done?' });
  assert.equal(sent.length, 1);
  assert.equal(msg().phone, T);
  assert.equal(msg().message, 'Which student? Start your message with #diya or #rohan.');

  // #tag routes and is stripped
  await relay('teacher', { id: 'r2', from: T, body: '#Rohan homework done?' });
  assert.deepEqual([sent.at(-1).device, msg().phone, msg().message], ['student', S2, 'Teacher Asha (for Rohan):\nhomework done?']);
  const outId = db.prepare("SELECT out_message_id FROM messages WHERE wa_message_id = 'r2'").get().out_message_id;
  assert.ok(outId);

  // Rohan's parent swipe-replies (only one child, but reply path also works); teacher swipe-replies to the relayed copy
  await relay('student', { id: 'r3', from: S2, body: 'yes', replied_to_id: 'r2' });
  assert.deepEqual([msg().phone, msg().message], [T, 'Student Rohan (#rohan):\nyes']);
  const toTeacher = db.prepare("SELECT out_message_id FROM messages WHERE wa_message_id = 'r3'").get().out_message_id;
  await relay('teacher', { id: 'r4', from: T, body: 'great', replied_to_id: toTeacher });
  assert.equal(msg().phone, S2);

  // Unknown tag refused; #list answers
  await relay('teacher', { id: 'r5', from: T, body: '#kabir hi' });
  assert.equal(msg().message, 'No student has the tag #kabir. Use #diya or #rohan.');
  await relay('teacher', { id: 'r6', from: T, body: '#list' });
  assert.equal(msg().message, 'Your students:\n#diya Diya\n#rohan Rohan');

  // Parent with 2 children (different teachers)
  await relay('student', { id: 'r7', from: S, body: 'test done' });
  assert.equal(msg().message, 'Which child? Start your message with #diya or #kabir.');
  await relay('student', { id: 'r8', from: S, body: '#kabir test done' });
  assert.deepEqual([sent.at(-1).device, msg().phone, msg().message], ['teacher', R, 'Student Kabir (#kabir):\ntest done']);

  // Assignment ended: reply to old conversation refused, not rerouted to the remaining student
  db.prepare('UPDATE students SET teacher_id = NULL WHERE id = 2').run();
  const before = sent.length;
  await relay('teacher', { id: 'r9', from: T, body: 'one more thing', replied_to_id: 'r2' });
  assert.equal(sent.length, before + 1);
  assert.deepEqual([msg().phone, msg().message], [T, 'That conversation has ended, so your message was not sent.']);
});

test('duplicate tag rejected by the DB; an ambiguous tag refuses instead of guessing', async () => {
  // Same teacher, different parents, same tag: the unique index is what stops a silent misroute.
  assert.throws(() => db.prepare("INSERT INTO students (id, name, tag, parent_id, teacher_id) VALUES (4, 'Rhea', 'diya', 2, 1)").run(),
    /UNIQUE constraint failed/);

  // If a duplicate ever predates the index, route() must refuse rather than pick one.
  db.exec('DROP INDEX students_teacher_tag');
  db.prepare("INSERT INTO students (id, name, tag, parent_id, teacher_id) VALUES (4, 'Rhea', 'diya', 2, 1)").run();
  sent.length = 0;
  await relay('teacher', { id: 'd1', from: T, body: '#diya homework done?' });
  assert.equal(sent.length, 1);
  assert.equal(sent.at(-1).body.phone, T); // refusal to the teacher, nothing relayed to either parent
  assert.match(sent.at(-1).body.message, /More than one student has the tag #diya/);
  db.prepare('DELETE FROM students WHERE id = 4').run();
  db.exec('CREATE UNIQUE INDEX students_teacher_tag ON students(teacher_id, tag) WHERE teacher_id IS NOT NULL');
});

test('unroutable contact card still answers the sender', async () => {
  db.prepare('UPDATE students SET teacher_id = 1 WHERE id = 2').run(); // Rohan back with Asha -> 2 students, no tag possible
  sent.length = 0;
  await relay('teacher', { id: 'd2', from: T, contact: { vcard: 'BEGIN:VCARD' } });
  assert.equal(sent.length, 1);
  assert.equal(sent.at(-1).body.phone, T);
  assert.match(sent.at(-1).body.message, /Contact cards are not relayed/);
  assert.equal(db.prepare("SELECT 1 FROM messages WHERE wa_message_id = 'd2'").get(), undefined); // no pair, no row
});

test('reassigning a student flags classes that still owe notes', async (t) => {
  const express = require('express');
  const app = express();
  app.use('/admin', express.json(), require('../src/admin'));
  const server = app.listen(0);
  t.after(() => server.close());
  const { port } = server.address();

  db.prepare(`INSERT INTO classes (id, teacher_id, student_id, held_at, notes_due_at, test_result_due_at)
    VALUES (2, 1, 2, '2026-09-14T11:00:00.000Z', '2026-09-15T11:00:00.000Z', '2036-09-21T05:30:00.000Z')`).run();
  sent.length = 0;
  const res = await realFetch(`http://127.0.0.1:${port}/admin/students/2`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
    body: JSON.stringify({ teacher_id: 2 }),
  });
  assert.equal(res.status, 200);
  assert.equal(db.prepare('SELECT needs_followup FROM classes WHERE id = 2').get().needs_followup, 1);
  assert.equal(sent.at(-1).body.phone, '910000000000@s.whatsapp.net');
  assert.match(sent.at(-1).body.message, /Rohan moved off teacher Asha: 1 class\(es\)/);
});
