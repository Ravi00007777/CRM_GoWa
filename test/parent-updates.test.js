// Weekly parent updates, offline: database and gowa are stubbed.
Object.assign(process.env, {
  DATABASE_URL: 'postgresql://unused:unused@localhost:5432/unused',
  GOWA_BASE_URL: 'http://gowa.test', GOWA_BASIC_AUTH: 'u:p',
  TEACHER_DEVICE_ID: 'teacher', STUDENT_DEVICE_ID: 'student', WEBHOOK_SECRET: 's3cret',
  ADMIN_WA_JID: '910000000000@s.whatsapp.net', ADMIN_TOKEN: 't',
});

const test = require('node:test');
const assert = require('node:assert/strict');
const people = require('../src/people');
const gowa = require('../src/gowa');

const rows = [
  { id: 'u1', studentId: 's1', text: 'Weekly update for Riya', status: 'send' },
  { id: 'u2', studentId: 's2', text: 'Weekly update for Aarav', status: 'send' },
  { id: 'u3', studentId: 's1', text: 'a draft', status: 'draft' },
];
people.pool = {
  query: async (sql, args = []) => {
    if (sql.includes("WHERE status = 'send' ORDER BY")) return { rows: rows.filter((r) => r.status === 'send') };
    if (sql.includes('FROM "WaConversation"')) return { rows: args[0] === 's1' ? [{ studentGroupJid: '120363000000000002@g.us' }] : [] };
    const set = /SET status = '(\w+)'/.exec(sql)?.[1];
    if (set) {
      const r = rows.find((x) => x.id === args[0] && (!sql.includes("AND status = 'send'") || x.status === 'send'));
      if (r) r.status = set;
      return { rowCount: r ? 1 : 0 };
    }
    throw new Error(`unexpected query: ${sql}`);
  },
};
const sent = [];
gowa.sendText = async (device, jid, text) => { sent.push({ device, jid, text }); };

const { sendParentUpdates } = require('../src/parent-updates');

test('approved updates go to the student group once; no group means failed; drafts stay', async () => {
  await sendParentUpdates();
  await sendParentUpdates();
  assert.deepEqual(sent, [{ device: 'student', jid: '120363000000000002@g.us', text: 'Weekly update for Riya' }]);
  assert.deepEqual(rows.map((r) => r.status), ['sent', 'failed', 'draft']);
});
