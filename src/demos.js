// Demo classes (AlmaEd admin → Demo classes): one-off classes with a demo teacher and a student
// who may not have an account. Every minute:
// - a confirmation for each newly booked demo, and
// - a reminder for each demo starting within the next 30 minutes,
// to the demo teacher from the teacher-facing number, and to the student and their parent from
// the student-facing number, one to one. Each demo is claimed before sending, so nobody gets a
// message twice, even across restarts. The site sends the matching emails.
const cfg = require('./config');
const gowa = require('./gowa');
const people = require('./people');
const { toJid } = require('./redact');

const q = (sql, args) => people.pool.query(sql, args);

const SELECT = `
  SELECT d.id, d."scheduledAt", d.topic, d."meetLink",
         t.name AS teacher, t.phone AS teacher_phone,
         COALESCE(s.name, d."studentName") AS student,
         COALESCE(s.phone, d."studentPhone") AS student_phone,
         COALESCE(s."parentPhone", d."parentPhone") AS parent_phone
  FROM "DemoClass" d
  JOIN "DemoTeacher" t ON t.id = d."teacherId"
  LEFT JOIN "User" s ON s.id = d."studentId"
  WHERE d.status = 'SCHEDULED' AND d."scheduledAt" > now()`;
const TO_CONFIRM = `${SELECT} AND d."waConfirmedAt" IS NULL ORDER BY d."scheduledAt" LIMIT 10`;
const DUE = `${SELECT} AND d."waRemindedAt" IS NULL AND d."scheduledAt" <= now() + interval '30 minutes'
  ORDER BY d."scheduledAt" LIMIT 10`;

const when = (d) => new Date(d).toLocaleString('en-IN', {
  timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
});
const time = (d) => new Date(d).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' });
const first = (name) => String(name ?? '').trim().split(/\s+/)[0] || '';
const topicLine = (row) => (row.topic ? `Topic: ${row.topic}\n` : '');

function confirmText(row, to) {
  if (to === 'teacher') {
    return `Hi ${first(row.teacher)},\nA demo class with ${first(row.student)} is booked for ${when(row.scheduledAt)} IST.\n` +
      `${topicLine(row)}Join on Google Meet: ${row.meetLink}\nWe'll remind you 30 minutes before.`;
  }
  return `Hi ${first(row.student)},\nYour AlmaED demo class is booked for ${when(row.scheduledAt)} IST.\n` +
    `${topicLine(row)}Join on Google Meet: ${row.meetLink}\nWe'll remind you 30 minutes before.\n\nTeam AlmaED`;
}

function reminderText(row, to, now = Date.now()) {
  const mins = Math.max(1, Math.round((new Date(row.scheduledAt).getTime() - now) / 60000));
  const startsAt = `starts in ${mins} min, at ${time(row.scheduledAt)} IST.`;
  if (to === 'teacher') {
    return `Hi ${first(row.teacher)},\nYour demo class with ${first(row.student)} ${startsAt}\n${topicLine(row)}Join on Google Meet: ${row.meetLink}`;
  }
  return `Hi ${first(row.student)},\nYour demo class ${startsAt}\n${topicLine(row)}Join on Google Meet: ${row.meetLink}\n` +
    'Please join a few minutes early.\n\nTeam AlmaED';
}

// One message per person: the teacher from the teacher number; the student and, if different,
// the parent from the student number. A number that isn't a valid WhatsApp number is skipped.
async function sendAll(row, textFor, what) {
  const send = async (device, phone, text, who) => {
    if (!phone) return;
    try {
      await gowa.sendText(device, toJid(phone, cfg.countryCode), text);
    } catch (err) {
      console.error(`[demos] ${what} to ${who} for demo ${row.id} failed:`, err.message);
    }
  };
  await send(cfg.teacherDevice, row.teacher_phone, textFor('teacher'), 'teacher');
  await send(cfg.studentDevice, row.student_phone, textFor('student'), 'student');
  const sameNumber = String(row.parent_phone ?? '').replace(/\D/g, '').slice(-10) === String(row.student_phone ?? '').replace(/\D/g, '').slice(-10);
  if (!sameNumber) await send(cfg.studentDevice, row.parent_phone, textFor('student'), 'parent');
}

async function confirmDemos() {
  for (const row of (await q(TO_CONFIRM)).rows) {
    const { rowCount } = await q('UPDATE "DemoClass" SET "waConfirmedAt" = now() WHERE id = $1 AND "waConfirmedAt" IS NULL', [row.id]);
    if (rowCount !== 1) continue;
    await sendAll(row, (to) => confirmText(row, to), 'confirmation');
  }
}

async function remindDemos() {
  for (const row of (await q(DUE)).rows) {
    const { rowCount } = await q('UPDATE "DemoClass" SET "waRemindedAt" = now() WHERE id = $1 AND "waRemindedAt" IS NULL', [row.id]);
    if (rowCount !== 1) continue;
    await sendAll(row, (to) => reminderText(row, to), 'reminder');
  }
}

let warned = false;
function start() {
  const tick = () =>
    confirmDemos()
      .then(remindDemos)
      .catch((err) => {
        // Before the site's demo tables exist (prisma/sql/2026-10-10-demo-classes.sql), say so once.
        if (/DemoClass|DemoTeacher/.test(err.message) && warned) return;
        warned = true;
        console.error('[demos]', err.message);
      });
  setInterval(tick, 60e3).unref();
}

module.exports = { start, confirmDemos, remindDemos, confirmText, reminderText };
