// Class reminders.
// - Every minute, for batches where admin pressed "Send reminders" on the AlmaEd site:
//   WhatsApp about each class starting within the next 3 hours: the teacher
//   directly (from the teacher-facing number), so they can prepare, and every student group of
//   the batch (from the student-facing number). Each class is claimed before sending, so
//   everyone gets one reminder per class even across restarts.
// - Every 5 minutes: call the AlmaEd site's reminder job, which emails teacher and students and
//   rolls weekly classes forward. The relay is always on, unlike GitHub's scheduler, which
//   only fires every few hours.
const cfg = require('./config');
const gowa = require('./gowa');
const people = require('./people');
const { toJid } = require('./redact');

const q = (sql, args) => people.pool.query(sql, args);

const DUE = `
  SELECT c.id, c."batchId", c."scheduledAt", c.topic, b.name AS batch,
         COALESCE(c."meetLink", b."meetLink") AS "meetLink", t.name AS teacher, t.phone
  FROM "Class" c JOIN "Batch" b ON b.id = c."batchId" JOIN "User" t ON t.id = b."teacherId"
  WHERE c.status = 'SCHEDULED' AND c."teacherWaRemindedAt" IS NULL
    AND c."scheduledAt" > now() AND c."scheduledAt" <= now() + interval '3 hours'
    AND t."isActive" AND b."archivedAt" IS NULL AND b."waReminders" -- admin's "Send reminders" switch
  ORDER BY c."scheduledAt" LIMIT 10`;

const ist = (d) => new Date(d).toLocaleString('en-IN', {
  timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
});

function reminderText(row, now = Date.now()) {
  const mins = Math.max(0, Math.round((new Date(row.scheduledAt).getTime() - now) / 60000));
  const inWhat = mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`;
  return `⏰ Class reminder\n${row.batch} starts ${ist(row.scheduledAt)} IST (in about ${inWhat}).\n` +
    (row.topic ? `Topic: ${row.topic}\n` : '') +
    `Please prepare for the class.\nJoin: ${row.meetLink}`;
}

// The batch's student groups: student, admin and the relay number.
const GROUPS_OF_BATCH = `
  SELECT c."studentGroupJid" FROM "BatchStudent" bs
  JOIN "Batch" b ON b.id = bs."batchId"
  JOIN "WaConversation" c ON c."teacherId" = b."teacherId" AND c."studentId" = bs."studentId"
  WHERE bs."batchId" = $1 AND c."studentGroupJid" IS NOT NULL AND NOT c."removeGroup"`;

function studentReminderText(row, now = Date.now()) {
  return reminderText(row, now).replace('Please prepare for the class.', 'Please join a few minutes early.') + '\n\nTeam AlmaED';
}

async function remindTeachers() {
  for (const row of (await q(DUE)).rows) {
    const { rowCount } = await q(
      'UPDATE "Class" SET "teacherWaRemindedAt" = now() WHERE id = $1 AND "teacherWaRemindedAt" IS NULL', [row.id]);
    if (rowCount !== 1) continue; // another pass got it
    if (row.phone) {
      try {
        await gowa.sendText(cfg.teacherDevice, toJid(row.phone, cfg.countryCode), reminderText(row));
      } catch (err) {
        console.error(`[reminders] teacher reminder for class ${row.id} failed:`, err.message);
      }
    }
    for (const g of (await q(GROUPS_OF_BATCH, [row.batchId])).rows) {
      await gowa.sendText(cfg.studentDevice, g.studentGroupJid, studentReminderText(row))
        .catch((err) => console.error(`[reminders] group reminder for class ${row.id} failed:`, err.message));
    }
  }
}

async function triggerSiteReminders() {
  if (!cfg.appUrl || !cfg.cronSecret) return;
  const res = await fetch(`${cfg.appUrl}/api/cron/class-reminders`, { headers: { Authorization: `Bearer ${cfg.cronSecret}` } });
  if (!res.ok) console.error(`[reminders] site reminder job -> HTTP ${res.status}`);
}

function start() {
  const every = (ms, fn, what) => setInterval(() => fn().catch((err) => console.error(`[reminders] ${what}:`, err.message)), ms).unref();
  every(60e3, remindTeachers, 'teacher reminders');
  every(5 * 60e3, triggerSiteReminders, 'site reminder job');
  if (!cfg.appUrl || !cfg.cronSecret) console.warn('[reminders] APP_URL/CRON_SECRET not set: site reminder emails are not triggered from here');
}

module.exports = { start, remindTeachers, reminderText, studentReminderText };
