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

const classes = [{ id: 'c1', scheduledAt: new Date(Date.now() + 150 * 60000), batch: 'VishAkash',
  meetLink: 'https://meet.google.com/abc-defg-hij', topic: 'Quadratic equations', teacher: 'Vishwas', phone: '99342 37343', remindedAt: null }];
people.pool = {
  query: async (sql, args = []) => {
    if (sql.includes('FROM "Class" c')) return { rows: classes.filter((c) => !c.remindedAt) };
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

const { remindTeachers, reminderText } = require('../src/reminders');

test('the teacher gets one WhatsApp reminder per class, from the teacher number', async () => {
  await remindTeachers();
  await remindTeachers();
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0].device, sent[0].jid], ['teacher', '919934237343@s.whatsapp.net']);
  assert.match(sent[0].text, /VishAkash starts .* IST \(in about 2 h (29|30) min\)/);
  assert.match(sent[0].text, /Topic: Quadratic equations/);
  assert.match(sent[0].text, /Please prepare/);
  assert.match(sent[0].text, /meet\.google\.com\/abc-defg-hij/);
});

test('short lead times read in minutes', () => {
  assert.match(reminderText({ scheduledAt: new Date(Date.now() + 45 * 60000), batch: 'B', meetLink: 'x' }), /in about (44|45) min/);
});
