// The outbox sends a WaNotice to each student group of the batch and to the teacher, once.
Object.assign(process.env, {
  DATABASE_URL: 'postgresql://unused:unused@localhost:5432/unused',
  GOWA_BASE_URL: 'http://gowa.test', GOWA_BASIC_AUTH: 'u:p',
  TEACHER_DEVICE_ID: 'teacher', STUDENT_DEVICE_ID: 'student', WEBHOOK_SECRET: 's3cret',
  ADMIN_WA_JID: '910000000000@s.whatsapp.net', ADMIN_TOKEN: 't',
});

const test = require('node:test');
const assert = require('node:assert/strict');
const people = require('../src/people');

const notices = [{ id: 'n1', body: 'New class scheduled', batchId: 'b1', teacher_phone: '+91 98765 43210', waMessageId: null }];
const groups = ['120363000000000002@g.us', '120363000000000003@g.us'];
people.pool = {
  query: async (sql, args) => {
    if (sql.includes('FROM "WaNotice"')) return { rows: notices.filter((n) => n.waMessageId === null) };
    if (sql.includes('"studentGroupJid" FROM "BatchStudent"')) return { rows: groups.map((studentGroupJid) => ({ studentGroupJid })) };
    if (sql.startsWith('UPDATE "WaNotice"')) {
      const n = notices.find((x) => x.id === args[0]);
      if (sql.includes('IS NULL') && n.waMessageId !== null) return { rowCount: 0 };
      n.waMessageId = args[1];
      return { rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  },
};

const sent = [];
global.fetch = async (url, opts = {}) => {
  sent.push({ device: opts.headers['X-Device-Id'], body: JSON.parse(opts.body) });
  return Response.json({ code: 'SUCCESS', results: { message_id: `out${sent.length}` } });
};

const { flush } = require('../src/outbox');

test('a schedule notice reaches every student group and the teacher, and only once', async () => {
  await flush();
  assert.deepEqual(sent.map((s) => s.device), ['student', 'student', 'teacher']);
  assert.deepEqual(sent.map((s) => s.body.phone), [...groups, '919876543210@s.whatsapp.net']);
  assert.ok(sent.every((s) => s.body.message === 'New class scheduled'));
  assert.equal(notices[0].waMessageId, 'sent:n1');
  await flush();
  assert.equal(sent.length, 3);
});
