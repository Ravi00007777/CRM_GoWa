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
let doubts = [];
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
  saveDoubt: async (row) => { doubts.push(row); },
  pairOfMessage: async (id) => {
    const row = logged.find((l) => l.waMessageId === id || l.outMessageId === id);
    return row && { teacher_id: row.teacherId, student_id: row.studentId };
  },
  seen: async (id) => logged.some((l) => l.waMessageId === id),
  refresh: () => {},
});

// Group membership comes from WaConversation; stubbed like the directory.
const groups = require('../src/groups');
const TEACHER_GROUP = '120363000000000001@g.us';
const STUDENT_GROUP = '120363000000000002@g.us';
groups.sideOfGroup = async (jid) => ({ teacherId: 't1', studentId: 's1', isTeacher: jid === TEACHER_GROUP });
people.pairOf = async (t, st) => pairs.find((x) => x.teacher_id === t && x.student_id === st);

const { relay, verifySignature, handleWebhook } = require('../src/relay');

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
  ({ teacher_id, teacher, teacher_jid, student_id, student, tag, parent_jid, batch_id: `b-${teacher_id}` });

function reset(...rows) {
  pairs = rows;
  logged = [];
  doubts = [];
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

test('a teacher on WhatsApp is pointed to the website; nothing is relayed or saved', async () => {
  reset(ASHA_DIYA);
  await relay('911111111111@s.whatsapp.net', { id: 'm1', from: T, body: '#diya homework?' });
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0].device, msg().phone], ['teacher', T]);
  assert.match(msg().message, /from the AlmaEd website/);
  assert.equal(doubts.length, 0);
});

test('a parent message is saved to the doubt thread, redacted, and not sent on', async () => {
  reset(ASHA_DIYA);
  await relay('912222222222@s.whatsapp.net', { id: 'm2', from: '251556368777322@lid', from_lid: S, body: 'done, call 98765 43210' });
  assert.equal(sent.length, 0);
  assert.deepEqual(doubts, [{ batchId: 'b-t1', studentId: 's1', body: 'done, call [number removed]', waMessageId: 'm2' }]);
  assert.deepEqual([logged.at(-1).direction, logged.at(-1).status], ['STUDENT_TO_TEACHER', 'RELAYED']);
});

test('unknown sender: ignored, nothing sent, nothing logged', async () => {
  reset(ASHA_DIYA);
  await relay('student', { id: 'u1', from: '915555555555@s.whatsapp.net', body: 'hi' });
  assert.equal(sent.length, 0);
  assert.equal(logged.length, 0);
});

test('contact details, contact cards and files are held back and the parent is told', async () => {
  reset(ASHA_DIYA);
  await relay('student', { id: 'm3', from: S, body: '+91 98765 43210' });
  await relay('student', { id: 'm4', from: S, contact: { vcard: 'BEGIN:VCARD' } });
  await relay('student', { id: 'm5', from: S, document: { path: 'statics/media/n/1.pdf' } });
  assert.deepEqual(logged.map((l) => l.status), ['FLAGGED', 'DROPPED', 'DROPPED']);
  assert.match(sent.at(-1).body.message, /Google Drive/);
  assert.equal(doubts.length, 0);
});

test('a parent with two children picks between them by #tag', async () => {
  reset(ASHA_DIYA, RAVI_KABIR);
  await relay('student', { id: 'r7', from: S, body: 'test done' });
  assert.equal(msg().message, 'Which child? Start your message with #diya or #kabir.');
  await relay('student', { id: 'r8', from: S, body: '#Kabir test done' });
  assert.deepEqual(doubts, [{ batchId: 'b-t2', studentId: 's3', body: 'test done', waMessageId: 'r8' }]);
  await relay('student', { id: 'r9', from: S, body: '#list' });
  assert.equal(msg().message, 'Your children:\n#diya Diya (teacher Asha)\n#kabir Kabir (teacher Ravi)');
});

test('a duplicate tag refuses rather than saving to the wrong thread', async () => {
  reset(ASHA_DIYA, pair('t2', 'Ravi', R, 's9', 'Divya', 'diya', S));
  await relay('student', { id: 'd1', from: S, body: '#diya hello' });
  assert.match(msg().message, /More than one child has the tag #diya/);
  assert.equal(doubts.length, 0);
});

async function groupMessage(chat, payload) {
  const req = { body: { event: 'message', device_id: 'x', payload: { chat_id: chat, ...payload } }, rawBody: null, get: () => '' };
  req.rawBody = Buffer.from(JSON.stringify(req.body));
  req.get = () => 'sha256=' + crypto.createHmac('sha256', 's3cret').update(req.rawBody).digest('hex');
  let status;
  await handleWebhook(req, { sendStatus: (c) => { status = c; } });
  return status;
}

test('student group: the parent\'s message goes to the doubt thread; others in the group are ignored', async () => {
  reset(ASHA_DIYA);
  assert.equal(await groupMessage(STUDENT_GROUP, { id: 'g1', participant: S, body: 'what is q3?' }), 200);
  assert.deepEqual(doubts, [{ batchId: 'b-t1', studentId: 's1', body: 'what is q3?', waMessageId: 'g1' }]);
  await groupMessage(STUDENT_GROUP, { id: 'g2', participant: '910000000000@s.whatsapp.net', body: 'admin note' });
  assert.equal(doubts.length, 1);
  assert.equal(sent.length, 0);
});

test('an old teacher group: the teacher is pointed to the website, nothing is saved', async () => {
  reset(ASHA_DIYA);
  await groupMessage(TEACHER_GROUP, { id: 'g3', participant: T, body: 'hello' });
  assert.equal(doubts.length, 0);
  assert.deepEqual([sent[0].device, msg().phone], ['teacher', TEACHER_GROUP]);
  assert.match(msg().message, /from the AlmaEd website/);
});
