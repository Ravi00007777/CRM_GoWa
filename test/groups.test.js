// Linking a student's existing WhatsApp group, offline: gowa and the database are stubbed.
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

let rows;
let calls;
people.directory = async () => [];
people.pairOf = async () => ({ batch: 'Renamed batch' });
people.pool = {
  query: async (sql, args = []) => {
    if (sql.startsWith('SELECT "teacherId"')) return { rows: rows.map((r) => ({ ...r })) };
    if (sql.includes('"existingGroup" = true')) {
      Object.assign(rows[0], { studentGroupJid: args[2], studentGroupInvite: null, existingGroup: true, note: null });
      return { rowCount: 1 };
    }
    if (sql.includes('note = $3')) {
      Object.assign(rows[0], { studentGroupInvite: null, note: args[2] });
      return { rowCount: 1 };
    }
    throw new Error(`unexpected query: ${sql}`);
  },
};
Object.assign(gowa, {
  joinGroupWithLink: async (device, link) => {
    calls.push(['join', device, link]);
    if (link.endsWith('BAD')) throw new Error('invite link revoked');
    return 'old@g.us';
  },
  leaveGroup: async (device, jid) => { calls.push(['leave', device, jid]); },
  renameGroup: async (device, jid, name) => { calls.push(['rename', device, jid, name]); },
  alertAdmin: async (text) => { calls.push(['alert', text]); },
});

const groups = require('../src/groups');

const row = (extra) => ({ teacherId: 't1', studentId: 's1', teacherGroupJid: null, studentGroupJid: null,
  note: null, groupName: 'Batch', studentGroupInvite: null, existingGroup: false, ...extra });

test.beforeEach(() => { calls = []; groups.refresh(); });

test('a pasted invite link: the student number joins it, switches to it, and leaves the group it had made', async () => {
  rows = [row({ studentGroupJid: 'made@g.us', studentGroupInvite: 'https://chat.whatsapp.com/AbCdEfGhIjK' })];
  await groups.reconcile();
  assert.deepEqual(calls, [
    ['join', 'student', 'https://chat.whatsapp.com/AbCdEfGhIjK'],
    ['leave', 'student', 'made@g.us'],
  ]);
  assert.deepEqual([rows[0].studentGroupJid, rows[0].existingGroup, rows[0].studentGroupInvite], ['old@g.us', true, null]);

  // Next pass: the existing group is used as it is, never renamed after the batch.
  calls = [];
  groups.refresh();
  await groups.reconcile();
  assert.deepEqual(calls, []);
});

test('a bad link is not retried forever: it is cleared, noted for admin, and admin is alerted', async () => {
  rows = [row({ studentGroupInvite: 'https://chat.whatsapp.com/xxxxxxxxxxBAD' })];
  await groups.reconcile();
  assert.equal(rows[0].studentGroupInvite, null);
  assert.match(rows[0].note, /invite link revoked/);
  assert.equal(calls.at(-1)[0], 'alert');
});
