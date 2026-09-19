// Runs without gowa and without a database: global fetch is mocked and the AlmaEd directory
// is replaced with an in-memory stand-in, so the suite stays offline.
Object.assign(process.env, {
  DATABASE_URL: 'postgresql://unused:unused@localhost:5432/unused',
  GOWA_BASE_URL: 'http://gowa.test', GOWA_BASIC_AUTH: 'u:p',
  TEACHER_DEVICE_ID: 'teacher', STUDENT_DEVICE_ID: 'student', WEBHOOK_SECRET: 's3cret',
  ADMIN_WA_JID: '910000000000@s.whatsapp.net', ADMIN_TOKEN: 't',
});

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { redact, assertSafeOutbound, toJid } = require('../src/redact');

// Stub the directory before relay.js is loaded. relay.js calls people.x() rather than
// destructuring, so replacing the exports here is enough.
const people = require('../src/people');
const T = '919876543210@s.whatsapp.net'; // teacher Asha
const R = '913333333333@s.whatsapp.net'; // teacher Ravi
const S = '918765432109@s.whatsapp.net'; // Diya's and Kabir's parent
const S2 = '917777777777@s.whatsapp.net'; // Rohan's parent

let pairs = [];
let logged = [];
const user = (j) => String(j).split('@')[0].split(':')[0];
Object.assign(people, {
  studentsOfTeacher: async (jid) => pairs.filter((p) => user(p.teacher_jid) === user(jid)),
  childrenOfParent: async (jid) => pairs.filter((p) => user(p.parent_jid) === user(jid)),
  findTeacher: async (jids) => {
    const hit = pairs.find((p) => jids.some((j) => j && user(p.teacher_jid) === user(j)));
    return hit && { id: hit.teacher_id, name: hit.teacher, wa_jid: hit.teacher_jid };
  },
  findParent: async (jids) => {
    const hit = pairs.find((p) => jids.some((j) => j && user(p.parent_jid) === user(j)));
    return hit && { id: hit.student_id, name: hit.student, wa_jid: hit.parent_jid };
  },
  log: async (row) => { logged.push(row); },
  pairOfMessage: async (id) => {
    const row = logged.find((l) => l.waMessageId === id || l.outMessageId === id);
    return row && { teacher_id: row.teacherId, student_id: row.studentId };
  },
  seen: async (id) => logged.some((l) => l.waMessageId === id),
  refresh: () => {},
});

const { relay, verifySignature } = require('../src/relay');

const sent = [];
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

const pair = (teacher_id, teacher, teacher_jid, student_id, student, tag, parent_jid) =>
  ({ teacher_id, teacher, teacher_jid, student_id, student, tag, parent_jid });

function reset(...rows) {
  pairs = rows;
  logged = [];
  sent.length = 0;
}
const msg = () => sent.at(-1).body;
const ASHA_DIYA = pair('t1', 'Asha', T, 's1', 'Diya', 'diya', S);
const ASHA_ROHAN = pair('t1', 'Asha', T, 's2', 'Rohan', 'rohan', S2);
const RAVI_KABIR = pair('t2', 'Ravi', R, 's3', 'Kabir', 'kabir', S);

test('redact: phone shapes, emails, wa links; keeps normal text', () => {
  for (const s of ['98765 43210', '+91-98765-43210', '(987) 654.3210', '919876543210', 'wa.me/919876543210', 'a@b.com']) {
    assert.equal(redact(s).flagged, true, s);
  }
  assert.deepEqual(redact('call me on 98765-43210 after class'),
    { text: 'call me on [number removed] after class', flagged: false });
  const keep = 'Class at 5:30 pm, test 45/50, meet.google.com/abc-defg-hij';
  assert.deepEqual(redact(keep), { text: keep, flagged: false });
});

test('outbound guard and JID normalisation', () => {
  assert.throws(() => assertSafeOutbound('pay a@b.com from 9876543210'));
  assert.doesNotThrow(() => assertSafeOutbound('pay a@b.com'));
  assert.equal(toJid('98765 43210', '91'), '919876543210@s.whatsapp.net');
  assert.throws(() => toJid('98765', '91'));
});

test('HMAC signature', () => {
  const raw = Buffer.from('{"a":1}');
  const sig = 'sha256=' + crypto.createHmac('sha256', 's3cret').update(raw).digest('hex');
  assert.equal(verifySignature(raw, sig), true);
  assert.equal(verifySignature(raw, sig.replace(/.$/, '0')), false);
});

test('teacher text -> redacted, sent via STUDENT device to the parent number', async () => {
  reset(ASHA_DIYA);
  await relay('911111111111@s.whatsapp.net', { id: 'm1', from: T, body: 'my number 98765 43210, email me x@y.com' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].device, 'student');
  assert.equal(msg().phone, S);
  assert.equal(msg().message, 'Teacher Asha (for Diya):\nmy number [number removed], email me [email removed]');
  assert.equal(logged.at(-1).status, 'RELAYED');
  assert.equal(logged.at(-1).direction, 'TEACHER_TO_STUDENT');
});

test('student (LID sender, phone in from_lid) -> teacher device', async () => {
  reset(ASHA_DIYA);
  await relay('912222222222@s.whatsapp.net', { id: 'm2', from: '251556368777322@lid', from_lid: S, body: 'ok' });
  assert.equal(sent[0].device, 'teacher');
  assert.equal(msg().phone, T);
  assert.equal(logged.at(-1).direction, 'STUDENT_TO_TEACHER');
});

test('unknown sender: ignored, nothing sent, nothing logged', async () => {
  reset(ASHA_DIYA);
  await relay('teacher', { id: 'u1', from: '915555555555@s.whatsapp.net', body: 'hi' });
  assert.equal(sent.length, 0);
  assert.equal(logged.length, 0);
});

test('contact details are held back; media is dropped and the sender is told', async () => {
  reset(ASHA_DIYA);
  await relay('teacher', { id: 'm3', from: T, body: '+91 98765 43210' });
  await relay('teacher', { id: 'm4', from: T, contact: { vcard: 'BEGIN:VCARD' } });
  await relay('teacher', { id: 'm5', from: T, image: 'statics/media/x.jpg' });
  assert.deepEqual(logged.map((l) => l.status), ['FLAGGED', 'DROPPED', 'DROPPED']);
  assert.deepEqual(sent.map((s) => s.body.phone), [T, T]); // both nudges go back to the sender
  assert.match(sent[0].body.message, /Contact cards are not relayed/);
});

test('documents are relayed under the tag, never the original filename', async () => {
  reset(ASHA_DIYA);
  await relay('teacher', { id: 'm6', from: T, document: { path: 'statics/media/n/1-Asha_9876543210.pdf', caption: 'notes' } });
  assert.equal(sent[0].device, 'student');
  assert.equal(msg().file.name, 'diya.pdf');
});

test('#result is relayed as a test result', async () => {
  reset(ASHA_DIYA);
  await relay('teacher', { id: 'm7', from: T, body: '#result 42/50, great work' });
  assert.equal(msg().message, 'Teacher Asha (for Diya) - Test result:\n42/50, great work');
});

test('one teacher, several students: #tag, swipe-reply, ask when unclear', async () => {
  reset(ASHA_DIYA, ASHA_ROHAN, RAVI_KABIR);

  // No tag and more than one student -> asked, nothing relayed
  await relay('teacher', { id: 'r1', from: T, body: 'homework done?' });
  assert.equal(msg().phone, T);
  assert.equal(msg().message, 'Which student? Start your message with #diya or #rohan.');

  // #tag routes and is stripped; case does not matter
  await relay('teacher', { id: 'r2', from: T, body: '#Rohan homework done?' });
  assert.deepEqual([sent.at(-1).device, msg().phone, msg().message],
    ['student', S2, 'Teacher Asha (for Rohan):\nhomework done?']);

  // Swipe-reply to the relayed copy resolves to the same conversation
  const out = logged.at(-1).outMessageId;
  await relay('student', { id: 'r3', from: S2, body: 'yes', replied_to_id: out });
  assert.deepEqual([msg().phone, msg().message], [T, 'Student Rohan (#rohan):\nyes']);

  // Unknown tag refused; #list answers
  await relay('teacher', { id: 'r5', from: T, body: '#kabir hi' });
  assert.equal(msg().message, 'No student has the tag #kabir. Use #diya or #rohan.');
  await relay('teacher', { id: 'r6', from: T, body: '#list' });
  assert.equal(msg().message, 'Your students:\n#diya Diya\n#rohan Rohan');
});

test('a parent with two children picks between them', async () => {
  reset(ASHA_DIYA, RAVI_KABIR);
  await relay('student', { id: 'r7', from: S, body: 'test done' });
  assert.equal(msg().message, 'Which child? Start your message with #diya or #kabir.');
  await relay('student', { id: 'r8', from: S, body: '#kabir test done' });
  assert.deepEqual([sent.at(-1).device, msg().phone, msg().message], ['teacher', R, 'Student Kabir (#kabir):\ntest done']);
});

test('an ended assignment refuses instead of rerouting to the remaining student', async () => {
  reset(ASHA_DIYA, ASHA_ROHAN);
  await relay('teacher', { id: 'e1', from: T, body: '#rohan one' });
  const out = logged.at(-1).outMessageId;
  reset(ASHA_DIYA); // Rohan moved to another teacher in AlmaEd
  logged.push({ teacherId: 't1', studentId: 's2', waMessageId: 'e1', outMessageId: out });
  await relay('teacher', { id: 'e2', from: T, body: 'one more thing', replied_to_id: out });
  assert.deepEqual([msg().phone, msg().message], [T, 'That conversation has ended, so your message was not sent.']);
});

test('a duplicate tag refuses rather than delivering to the wrong parent', async () => {
  reset(ASHA_DIYA, pair('t1', 'Asha', T, 's9', 'Divya', 'diya', S2));
  await relay('teacher', { id: 'd1', from: T, body: '#diya hello' });
  assert.equal(msg().phone, T);
  assert.match(msg().message, /More than one student has the tag #diya/);
});
