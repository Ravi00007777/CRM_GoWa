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
    if (sql.includes('"parentJidAdded" = $3')) {
      Object.assign(rows[0], { parentJidAdded: args[2] }, args[3] ? { note: args[3] } : {});
      return { rowCount: 1 };
    }
    if (sql.startsWith('UPDATE "WaConversation" SET note = $3')) {
      Object.assign(rows[0], { note: args[2] }, sql.includes('"wantsNewGroup" = false') ? { wantsNewGroup: false } : {});
      return { rowCount: 1 };
    }
    if (sql.startsWith('UPDATE "WaConversation" SET "groupName" = $1')) {
      Object.assign(rows[0], { groupName: args[0] }, args[3] ? { note: args[3] } : {});
      return { rowCount: 1 };
    }
    if (sql.startsWith('UPDATE "WaConversation" SET "removeGroup" = false')) {
      Object.assign(rows[0], { removeGroup: false, studentGroupJid: null, teacherGroupJid: null, existingGroup: false });
      return { rowCount: 1 };
    }
    if (sql.startsWith('INSERT INTO "WaConversation"')) {
      Object.assign(rows[0], { studentGroupJid: args[3], wantsNewGroup: false, note: args[4], groupName: args[5], parentJidAdded: args[6] });
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
  addParticipants: async (device, jid, participants) => { calls.push(['add', device, jid, participants]); return { missing: [] }; },
  removeParticipants: async (device, jid, participants) => { calls.push(['remove', device, jid, participants]); },
  setGroupTopic: async () => {},
  createGroup: async (device, title, participants) => {
    calls.push(['create', device, title, participants]);
    return { jid: 'new@g.us', missing: [] };
  },
});

const groups = require('../src/groups');

const row = (extra) => ({ teacherId: 't1', studentId: 's1', teacherGroupJid: null, studentGroupJid: null,
  note: null, groupName: 'Batch', studentGroupInvite: null, existingGroup: false, wantsNewGroup: false, ...extra });
const PAIR = { teacher_id: 't1', student_id: 's1', teacher: 'Vishwas', student: 'Akash', batch: 'Renamed batch',
  student_jid: '918888888888@s.whatsapp.net', parent_jid: null, teacher_jid: '919999999999@s.whatsapp.net' };
const PARENT = '917777777777@s.whatsapp.net';

test.beforeEach(() => { calls = []; pairs = [PAIR]; groups.refresh(); });

test('a new batch alone makes no group; admin asking for one does', async () => {
  rows = [];
  await groups.reconcile();
  assert.deepEqual(calls, []); // student is in a batch, but nobody asked

  rows = [row({ wantsNewGroup: true, groupName: null })];
  groups.refresh();
  await groups.reconcile();
  assert.deepEqual(calls, [['create', 'student', 'Renamed batch', [PAIR.student_jid, '910000000000@s.whatsapp.net']]]);
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

test('the description is built from the batch links in the group\'s own format', () => {
  assert.equal(
    groups.groupDescription({
      meet_link: 'https://meet.google.com/ebh-oyye-fnj',
      schedule_sheet_link: 'https://docs.google.com/spreadsheets/d/abc/edit',
      drive_link: 'https://docs.google.com/spreadsheets/d/def/edit',
    }),
    'Join classes using this Google Meet link: https://meet.google.com/ebh-oyye-fnj\n\n' +
      'Class&AssignmentSchedule- \nhttps://docs.google.com/spreadsheets/d/abc/edit\n\n' +
      'Assignment and notes docs:\nhttps://docs.google.com/spreadsheets/d/def/edit');
  assert.equal(groups.groupDescription({ meet_link: 'https://meet.google.com/x' }), 'Join classes using this Google Meet link: https://meet.google.com/x');
});

test('changed batch links rewrite the group description once', async () => {
  process.env.GROUP_DESCRIPTIONS = 'on';
  pairs = [{ ...PAIR, meet_link: 'https://meet.google.com/x', drive_link: 'https://drive.google.com/new' }];
  rows = [row({ studentGroupJid: 'g@g.us', groupName: 'Renamed batch', groupTopicLink: null })];
  const writes = [];
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
    delete process.env.GROUP_DESCRIPTIONS;
  }
  assert.deepEqual(writes, [['student', 'g@g.us',
    'Join classes using this Google Meet link: https://meet.google.com/x\n\nAssignment and notes docs:\nhttps://drive.google.com/new']]);
});

test('a new group includes the parent when the site has their number', async () => {
  pairs = [{ ...PAIR, parent_jid: PARENT }];
  rows = [row({ wantsNewGroup: true, groupName: null })];
  await groups.reconcile();
  assert.deepEqual(calls[0], ['create', 'student', 'Renamed batch', [PAIR.student_jid, PARENT, '910000000000@s.whatsapp.net']]);
  assert.equal(rows[0].parentJidAdded, PARENT);
});

test('a parent number added or changed later is added to the existing group, once', async () => {
  const OLD = '915555555555@s.whatsapp.net';
  pairs = [{ ...PAIR, parent_jid: PARENT }];
  rows = [row({ studentGroupJid: 'g@g.us', groupName: 'Renamed batch', groupTopicLink: 'x', parentJidAdded: OLD })];
  groups.refresh();
  await groups.reconcile();
  groups.refresh();
  await groups.reconcile(); // already done: nothing more
  assert.deepEqual(calls.filter((c) => c[0] === 'add' || c[0] === 'remove'), [
    ['remove', 'student', 'g@g.us', [OLD]],
    ['add', 'student', 'g@g.us', [PARENT]],
  ]);
  assert.equal(rows[0].parentJidAdded, PARENT);
});

test('group descriptions are left alone until GROUP_DESCRIPTIONS=on', async () => {
  pairs = [{ ...PAIR, meet_link: 'https://meet.google.com/x' }];
  rows = [row({ studentGroupJid: 'g@g.us', groupName: 'Renamed batch', groupTopicLink: null })];
  let wrote = false;
  gowa.setGroupTopic = async () => { wrote = true; };
  await groups.reconcile();
  assert.equal(wrote, false);
});

test('a failed rename is noted once, not retried every pass', async () => {
  rows = [row({ studentGroupJid: 'g@g.us', groupName: 'Old batch', groupTopicLink: null })];
  gowa.renameGroup = async () => { throw new Error('not an admin'); };
  await groups.reconcile();
  assert.equal(rows[0].groupName, 'Renamed batch');
  assert.match(rows[0].note, /Could not rename the WhatsApp group to "Renamed batch": not an admin/);
  gowa.renameGroup = async (device, jid, name) => { calls.push(['rename', device, jid, name]); };
  await groups.reconcile();
  assert.equal(calls.filter((c) => c[0] === 'rename').length, 0);
});

test('a removed batch: the relay empties its group (keeping itself and admin), leaves, and forgets it', async () => {
  rows = [row({ studentGroupJid: 'g@g.us', removeGroup: true })];
  gowa.ownIds = async () => ['912222222222', '112451588780049'];
  gowa.groupParticipants = async () => ['912222222222@s.whatsapp.net', '910000000000@s.whatsapp.net', PAIR.student_jid, PARENT];
  await groups.reconcile();

  assert.deepEqual(calls.filter((c) => c[0] !== 'alert'), [
    ['remove', 'student', 'g@g.us', [PAIR.student_jid, PARENT]],
    ['leave', 'student', 'g@g.us'],
  ]);
  assert.equal(rows[0].studentGroupJid, null);
  assert.equal(rows[0].removeGroup, false);
});

test('a removed batch with a family\'s own linked group: the relay only leaves', async () => {
  rows = [row({ studentGroupJid: 'g@g.us', existingGroup: true, removeGroup: true })];
  await groups.reconcile();
  assert.deepEqual(calls, [['leave', 'student', 'g@g.us']]);
  assert.equal(rows[0].studentGroupJid, null);
});
