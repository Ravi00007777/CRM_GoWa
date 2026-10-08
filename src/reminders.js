// Class reminders.
// - Every minute, for batches where admin pressed "Send reminders" on the AlmaEd site:
//   WhatsApp about each class starting within the next 30 minutes (late on purpose, so admin
//   can still move or cancel a class, or add an emergency one, before anyone is told): the
//   teacher directly (from the teacher-facing number), and every student group of the batch
//   (from the student-facing number), each greeted by name with the topic and Meet link. Each
//   class is claimed before sending, so everyone gets one reminder per class even across restarts.
// - Every 5 minutes: call the AlmaEd site's reminder job, which emails teacher and students and
//   rolls weekly classes forward. The relay is always on, unlike GitHub's scheduler, which
//   only fires every few hours.
const cfg = require('./config');
const gowa = require('./gowa');
const people = require('./people');
const { toJid } = require('./redact');

const q = (sql, args) => people.pool.query(sql, args);

const DUE = `
  SELECT c.id, c."batchId", c."scheduledAt", c.topic,
         COALESCE(c."meetLink", b."meetLink") AS "meetLink", t.name AS teacher, t.phone,
         (SELECT string_agg(s.name, ',' ORDER BY s.name) FROM "BatchStudent" bs JOIN "User" s ON s.id = bs."studentId"
          WHERE bs."batchId" = b.id AND s."isActive") AS students
  FROM "Class" c JOIN "Batch" b ON b.id = c."batchId" JOIN "User" t ON t.id = b."teacherId"
  WHERE c.status = 'SCHEDULED' AND c."teacherWaRemindedAt" IS NULL
    AND c."scheduledAt" > now() AND c."scheduledAt" <= now() + interval '30 minutes'
    AND t."isActive" AND b."archivedAt" IS NULL AND b."waReminders" -- admin's "Send reminders" switch
  ORDER BY c."scheduledAt" LIMIT 10`;

const time = (d) => new Date(d).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' });
const firstName = (name) => String(name ?? '').trim().split(/\s+/)[0] || '';
const nameList = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

// The lines both messages share: when, what, and the link. A "Test: ..." topic reads as a test.
function details(row, now) {
  const mins = Math.max(1, Math.round((new Date(row.scheduledAt).getTime() - now) / 60000));
  const isTest = /^Test:/.test(row.topic ?? '');
  const topic = (row.topic ?? '').replace(/^Test:\s*/, '');
  return {
    what: isTest ? 'test' : 'class',
    when: `starts in ${mins} min, at ${time(row.scheduledAt)} IST.`,
    rest: (topic ? `Topic: ${topic}\n` : '') + `Join on Google Meet: ${row.meetLink}`,
  };
}

// To the teacher: their first name, and their students' first names (no batch name).
function teacherText(row, now = Date.now()) {
  const d = details(row, now);
  const students = nameList(String(row.students ?? '').split(',').filter(Boolean).map(firstName));
  return `Hi ${firstName(row.teacher)},\nYour ${d.what}${students ? ` with ${students}` : ''} ${d.when}\n${d.rest}`;
}

// To one student's group (student, parent, admin): greets the student by first name.
function studentText(row, student, now = Date.now()) {
  const d = details(row, now);
  const hi = firstName(student);
  return `${hi ? `Hi ${hi}` : 'Hello'},\nYour ${d.what} ${d.when}\n${d.rest}\nPlease join a few minutes early.\n\nTeam AlmaED`;
}

// The batch's student groups (student, admin and the relay number), with whose group it is.
const GROUPS_OF_BATCH = `
  SELECT c."studentGroupJid", s.name AS student FROM "BatchStudent" bs
  JOIN "Batch" b ON b.id = bs."batchId"
  JOIN "User" s ON s.id = bs."studentId"
  JOIN "WaConversation" c ON c."teacherId" = b."teacherId" AND c."studentId" = bs."studentId"
  WHERE bs."batchId" = $1 AND c."studentGroupJid" IS NOT NULL AND NOT c."removeGroup"`;

async function remindTeachers() {
  for (const row of (await q(DUE)).rows) {
    const { rowCount } = await q(
      'UPDATE "Class" SET "teacherWaRemindedAt" = now() WHERE id = $1 AND "teacherWaRemindedAt" IS NULL', [row.id]);
    if (rowCount !== 1) continue; // another pass got it
    if (row.phone) {
      try {
        await gowa.sendText(cfg.teacherDevice, toJid(row.phone, cfg.countryCode), teacherText(row));
      } catch (err) {
        console.error(`[reminders] teacher reminder for class ${row.id} failed:`, err.message);
      }
    }
    for (const g of (await q(GROUPS_OF_BATCH, [row.batchId])).rows) {
      await gowa.sendText(cfg.studentDevice, g.studentGroupJid, studentText(row, g.student))
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

module.exports = { start, remindTeachers, teacherText, studentText };
