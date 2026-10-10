// Demo class WhatsApp messages, offline: database and gowa are stubbed.
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

const demo = {
  id: 'd1', scheduledAt: new Date(Date.now() + 25 * 60000), topic: 'Quadratics', meetLink: 'https://meet.google.com/abc-defg-hij',
  teacher: 'Priya Sharma', teacher_phone: '98765 43210', student: 'Aarav Kumar', student_phone: '9123456780', parent_phone: '+91 91234 56781',
  confirmed: null, reminded: null,
};
people.pool = {
  query: async (sql, args = []) => {
    if (sql.includes('FROM "DemoClass" d')) {
      const due = sql.includes('"waRemindedAt" IS NULL');
      return { rows: [demo].filter((d) => (due ? !d.reminded : !d.confirmed)) };
    }
    if (sql.startsWith('UPDATE "DemoClass" SET "waConfirmedAt"')) {
      const hit = !demo.confirmed;
      demo.confirmed = new Date();
      return { rowCount: hit ? 1 : 0 };
    }
    if (sql.startsWith('UPDATE "DemoClass" SET "waRemindedAt"')) {
      const hit = !demo.reminded;
      demo.reminded = new Date();
      return { rowCount: hit ? 1 : 0 };
    }
    throw new Error(`unexpected query: ${sql}`);
  },
};
let sent = [];
gowa.sendText = async (device, jid, text) => { sent.push({ device, jid, text }); };

const { confirmDemos, remindDemos, confirmText } = require('../src/demos');

test('a booked demo is confirmed once: teacher from the teacher number, student and parent from the student number', async () => {
  await confirmDemos();
  await confirmDemos();
  assert.deepEqual(sent.map((m) => [m.device, m.jid]), [
    ['teacher', '919876543210@s.whatsapp.net'],
    ['student', '919123456780@s.whatsapp.net'],
    ['student', '919123456781@s.whatsapp.net'],
  ]);
  assert.match(sent[0].text, /^Hi Priya,\nA demo class with Aarav is booked for .* IST\./);
  assert.match(sent[1].text, /^Hi Aarav,\nYour AlmaED demo class is booked for/);
  assert.match(sent[1].text, /Topic: Quadratics\nJoin on Google Meet: https:\/\/meet\.google\.com\/abc-defg-hij/);
});

test('the reminder goes out once, 30 minutes before, to the same three people', async () => {
  sent = [];
  await remindDemos();
  await remindDemos();
  assert.equal(sent.length, 3);
  assert.match(sent[0].text, /Your demo class with Aarav starts in (24|25) min/);
  assert.match(sent[1].text, /^Hi Aarav,\nYour demo class starts in (24|25) min/);
});

test('no topic means no topic line', () => {
  assert.doesNotMatch(confirmText({ ...demo, topic: null }, 'student'), /Topic/);
});

test('demo queries skip cancelled and past demos, and remind only within 30 minutes', () => {
  const src = require('fs').readFileSync(require.resolve('../src/demos'), 'utf8');
  assert.match(src, /d\.status = 'SCHEDULED' AND d\."scheduledAt" > now\(\)/);
  assert.match(src, /interval '30 minutes'/);
});
