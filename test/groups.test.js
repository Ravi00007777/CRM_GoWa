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
let pairs;
people.directory = async () => pairs;
people.pairOf = async (t, st) => pairs.find((p) => p.teacher_id === t && p.student_id === st);
people.pool = {
  query: async (sql, args = []) => {
    if (sql.startsWith('SELECT "teacherId"')) return { rows: rows.map((r) => ({ ...r })) };
    if (sql.includes('"existingGroup" = true')) {
      Object.assign(rows[0], { studentGroupJid: args[2], studentGroupInvite: null, existingGroup: true, note: null });
      return { rowCount: 1 };
    }
    if (sql.includes('"studentGroupInvite" = NULL, note = $3')) {
      Object.assign(rows[0], { studentGroupInvite: null, note: args[2] });
      return { rowCount: 1 };
    }
    if (sql.startsWith('UPDATE "WaConversation" SET note = $3')) {
      Object.assign(rows[0], { note: args[2] }, sql.includes('"wantsNewGroup" = false') ? { wantsNewGroup: false } : {});
      return { rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO "WaConversation"')) {
      Object.assign(rows[0], { studentGroupJid: args[3], wantsNewGroup: false, note: args[4], groupName: args[5] });
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
  createGroup: async (device, title, participants) => {
    calls.push(['create', device, title, participants]);
    return { jid: 'new@g.us', missing: [] };
  },
});

const groups = require('../src/groups');

const row = (extra) => ({ teacherId: 't1', studentId: 's1', teacherGroupJid: null, studentGroupJid: null,
  note: null, groupName: 'Batch', studentGroupInvite: null, existingGroup: false, wantsNewGroup: false, ...extra });
const PAIR = { teacher_id: 't1', student_id: 's1', teacher: 'Vishwas', student: 'Akash', batch: 'Renamed batch',
  parent_jid: '918888888888@s.whatsapp.net', teacher_jid: '919999999999@s.whatsapp.net' };

test.beforeEach(() => { calls = []; pairs = [PAIR]; groups.refresh(); });

test('a new batch alone makes no group; admin asking for one does', async () => {
  rows = [];
  await groups.reconcile();
  assert.deepEqual(calls, []); // student is in a batch, but nobody asked

  rows = [row({ wantsNewGroup: true, groupName: null })];
  groups.refresh();
  await groups.reconcile();
  assert.deepEqual(calls, [['create', 'student', 'Renamed batch', [PAIR.parent_jid, '910000000000@s.whatsapp.net']]]);
  assert.deepEqual([rows[0].studentGroupJid, rows[0].wantsNewGroup], ['new@g.us', false]);
});

test('a requested group waits, with a note, until the student has a phone and WhatsApp tag', async () => {
  pairs = [];
  rows = [row({ wantsNewGroup: true })];
  await groups.reconcile();
  assert.deepEqual(calls, []);
  assert.match(rows[0].note, /needs a phone number and a WhatsApp tag/);
  assert.equal(rows[0].wantsNewGroup, true);
});

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

test('the assignments folder line is added, replaced or removed, keeping the rest of the description', () => {
  const { withAssignmentsLink } = groups;
  assert.equal(withAssignmentsLink('', 'https://drive.google.com/a'), '📁 Assignments folder: https://drive.google.com/a');
  assert.equal(
    withAssignmentsLink('Class 10 parents\n📁 Assignments folder: https://drive.google.com/old', 'https://drive.google.com/new'),
    'Class 10 parents\n📁 Assignments folder: https://drive.google.com/new');
  assert.equal(withAssignmentsLink('Class 10 parents\n📁 Assignments folder: https://drive.google.com/old', null), 'Class 10 parents');
});

test('a changed Drive link is written into the group description once', async () => {
  pairs = [{ ...PAIR, drive_link: 'https://drive.google.com/new' }];
  rows = [row({ studentGroupJid: 'g@g.us', groupName: 'Renamed batch', groupTopicLink: null })];
  const writes = [];
  gowa.groupTopic = async () => 'Old parents group rules';
  gowa.setGroupTopic = async (device, jid, topic) => { writes.push([device, jid, topic]); };
  const realQuery = people.pool.query;
  people.pool.query = async (sql, args = []) => {
    if (sql.includes('"groupTopicLink" = $3')) { rows[0].groupTopicLink = args[2]; return { rowCount: 1 }; }
    return realQuery(sql, args);
  };
  try {
    await groups.reconcile();
    groups.refresh();
    await groups.reconcile(); // already written: nothing more
  } finally {
    people.pool.query = realQuery;
  }
  assert.deepEqual(writes, [['student', 'g@g.us', 'Old parents group rules\n📁 Assignments folder: https://drive.google.com/new']]);
  assert.equal(rows[0].groupTopicLink, 'https://drive.google.com/new');
});
