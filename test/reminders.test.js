// Teacher WhatsApp class reminders, offline: database and gowa are stubbed.
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

const classes = [{ id: 'c1', scheduledAt: new Date(Date.now() + 28 * 60000), students: 'Akash Verma',
  meetLink: 'https://meet.google.com/abc-defg-hij', topic: 'Quadratic equations', teacher: 'Vishwas Rao', phone: '99342 37343', remindedAt: null }];
people.pool = {
  query: async (sql, args = []) => {
    if (sql.includes('FROM "Class" c')) return { rows: classes.filter((c) => !c.remindedAt) };
    if (sql.includes('SELECT c."studentGroupJid"')) return { rows: [{ studentGroupJid: '120363000000000002@g.us', student: 'Akash Verma' }] };
    if (sql.startsWith('UPDATE "Class"')) {
      const c = classes.find((x) => x.id === args[0] && !x.remindedAt);
      if (c) c.remindedAt = new Date();
      return { rowCount: c ? 1 : 0 };
    }
    throw new Error(`unexpected query: ${sql}`);
  },
};
const sent = [];
gowa.sendText = async (device, jid, text) => { sent.push({ device, jid, text }); };

const { remindTeachers, teacherText, studentText } = require('../src/reminders');

test('the teacher and each student group get one WhatsApp reminder per class', async () => {
  await remindTeachers();
  await remindTeachers();
  assert.equal(sent.length, 2);
  assert.deepEqual([sent[1].device, sent[1].jid], ['student', '120363000000000002@g.us']);
  assert.match(sent[1].text, /^Hi Akash,\nYour class starts in (27|28) min, at .* IST\./);
  assert.match(sent[1].text, /Topic: Quadratic equations/);
  assert.match(sent[1].text, /Join on Google Meet: https:\/\/meet\.google\.com\/abc-defg-hij/);
  assert.match(sent[1].text, /join a few minutes early/);
  assert.deepEqual([sent[0].device, sent[0].jid], ['teacher', '919934237343@s.whatsapp.net']);
  assert.match(sent[0].text, /^Hi Vishwas,\nYour class with Akash starts in (27|28) min/);
  assert.match(sent[0].text, /Topic: Quadratic equations/);
  assert.match(sent[0].text, /meet\.google\.com\/abc-defg-hij/);
});

test('reminders go out 30 minutes before, never hours before', () => {
  const sql = require('fs').readFileSync(require.resolve('../src/reminders'), 'utf8');
  assert.match(sql, /interval '30 minutes'/);
});

test('a test reads as a test, and no topic means no topic line', () => {
  const row = { scheduledAt: new Date(Date.now() + 30 * 60000), meetLink: 'x', students: 'Riya Sen,Aarav Kumar' };
  assert.match(studentText({ ...row, topic: 'Test: Algebra' }, 'Riya Sen'), /Your test starts.*\nTopic: Algebra\n/);
  assert.doesNotMatch(studentText({ ...row, topic: null }, 'Riya Sen'), /Topic/);
  assert.match(teacherText({ ...row, teacher: 'Ravi' }), /with Riya and Aarav starts/);
});

test('database timestamps are read as UTC, so a 11:30 UTC class shows as 5:00 pm IST', () => {
  const { types } = require('pg');
  const at = types.getTypeParser(types.builtins.TIMESTAMP)('2026-10-06 11:30:00.000');
  assert.equal(at.toISOString(), '2026-10-06T11:30:00.000Z');
  assert.match(studentText({ scheduledAt: at, meetLink: 'x' }, 'A', at.getTime() - 30 * 60e3), /starts in 30 min, at 5:00 pm IST/);
});

test('only batches with the "Send reminders" switch on are reminded', () => {
  const sql = require('fs').readFileSync(require.resolve('../src/reminders'), 'utf8');
  assert.match(sql, /b\."waReminders"/);
});

test('without a teacher number, everything goes from the relay number', () => {
  const { execFileSync } = require('node:child_process');
  const env = { ...process.env, TEACHER_DEVICE_ID: '' };
  const out = execFileSync(process.execPath, ['-e', "process.stdout.write(require('./src/config').teacherDevice)"], { env, cwd: require('node:path').join(__dirname, '..') });
  assert.equal(String(out), 'student');
});
