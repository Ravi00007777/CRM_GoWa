// Website -> WhatsApp outbox, offline: the database and gowa are both stubbed.
Object.assign(process.env, {
  DATABASE_URL: 'postgresql://unused:unused@localhost:5432/unused',
  GOWA_BASE_URL: 'http://gowa.test', GOWA_BASIC_AUTH: 'u:p',
  TEACHER_DEVICE_ID: 'teacher', STUDENT_DEVICE_ID: 'student', WEBHOOK_SECRET: 's3cret',
  ADMIN_WA_JID: '910000000000@s.whatsapp.net', ADMIN_TOKEN: 't',
});

const test = require('node:test');
const assert = require('node:assert/strict');
const people = require('../src/people');

const GROUP = '120363000000000000@g.us';
let doubts;
let logged;
people.log = async (row) => { logged.push(row); };
people.pool = {
  query: async (sql, args = []) => {
    if (sql.includes('FROM "DoubtMessage" d')) {
      return { rows: doubts.filter((d) => d.waMessageId === null).map((d) => ({ ...d, studentGroupJid: GROUP })) };
    }
    if (sql.includes('FROM "Resource" r JOIN')) return { rows: [] };
    if (sql.startsWith('UPDATE "DoubtMessage"') && sql.includes('IS NULL')) {
      const d = doubts.find((x) => x.id === args[0] && x.waMessageId === null);
      if (d) d.waMessageId = args[1];
      return { rowCount: d ? 1 : 0 };
    }
    if (sql.startsWith('UPDATE "DoubtMessage"')) {
      doubts.find((x) => x.id === args[0]).waMessageId = args[1];
      return { rowCount: 1 };
    }
    throw new Error(`unexpected query: ${sql}`);
  },
};

const sent = [];
global.fetch = async (url, opts = {}) => {
  sent.push({ url, device: opts.headers?.['X-Device-Id'], body: JSON.parse(opts.body || '{}') });
  return { ok: true, json: async () => ({ code: 'SUCCESS', results: { message_id: `wa-${sent.length}` } }) };
};

const outbox = require('../src/outbox');

const doubt = (id, body) => ({ id, body, imageUrl: null, teacher: 'Vishwas', teacherId: 't1', studentId: 's1', waMessageId: null });

test.beforeEach(() => { doubts = []; logged = []; sent.length = 0; });

test('a teacher message on the site goes to the student group from the student number, once', async () => {
  doubts = [doubt('d1', 'Homework: page 12')];
  await outbox.flush();
  await outbox.flush(); // already sent: nothing more goes out

  assert.equal(sent.length, 1);
  assert.equal(sent[0].device, 'student');
  assert.deepEqual(sent[0].body, { phone: GROUP, message: 'Teacher Vishwas:\nHomework: page 12' });
  assert.equal(doubts[0].waMessageId, 'wa-1');
  assert.equal(logged[0].status, 'RELAYED');
});

test('a message that is only a phone number is not sent, and is not retried', async () => {
  doubts = [doubt('d2', '98765 43210')];
  await outbox.flush();
  await outbox.flush();

  assert.equal(sent.length, 0);
  assert.equal(doubts[0].waMessageId, 'skipped:d2');
  assert.equal(logged[0].status, 'FLAGGED');
});
