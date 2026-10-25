// Class reminders.
// - Every minute, for batches where admin pressed "Send reminders" on the AlmaEd site:
//   WhatsApp about each class starting within the next 30 minutes, and a last call ("starts in
//   2 min, please join now") 2 minutes before (late on purpose, so admin
//   can still move or cancel a class, or add an emergency one, before anyone is told): the
//   teacher directly (from the teacher-facing number), and every student group of the batch
//   (from the student-facing number), each greeted by name with the time and Meet link (never the topic). Each
//   class is claimed before sending, so everyone gets one reminder per class even across restarts.
// - Every 5 minutes: call the AlmaEd site's reminder job, which emails teacher and students and
//   rolls weekly classes forward; every minute, its 2-minute last-call emails (?only=last-call). The relay is always on, unlike GitHub's scheduler, which
//   only fires every few hours.
const cfg = require('./config');
const gowa = require('./gowa');
const people = require('./people');
const { toJid } = require('./redact');

const q = (sql, args) => people.pool.query(sql, args);

// Classes starting soon that haven't had this reminder (`col`): admin's "Send reminders" switch on.
// `from`/`to` are minutes from now: the 30-minute reminder skips a class under 3 minutes away (the
// last call covers it, so nobody gets both at once).
const due = (col, from, to) => `
  SELECT c.id, c."batchId", c."scheduledAt", c.topic,
         COALESCE(c."meetLink", b."meetLink") AS "meetLink", t.name AS teacher, t.phone,
         (SELECT string_agg(s.name, ',' ORDER BY s.name) FROM "BatchStudent" bs JOIN "User" s ON s.id = bs."studentId"
          WHERE bs."batchId" = b.id AND s."isActive") AS students
  FROM "Class" c JOIN "Batch" b ON b.id = c."batchId" JOIN "User" t ON t.id = b."teacherId"
  WHERE c.status = 'SCHEDULED' AND c."${col}" IS NULL
    AND c."scheduledAt" > now() + interval '${from} minutes' AND c."scheduledAt" <= now() + interval '${to} minutes'
    AND t."isActive" AND b."archivedAt" IS NULL AND b."waReminders" -- admin's "Send reminders" switch
  ORDER BY c."scheduledAt" LIMIT 10`;
const DUE = due('teacherWaRemindedAt', 3, 30);
const LAST_CALL = due('lastCallWaAt', 0, 2);

const time = (d) => new Date(d).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' });
const firstName = (name) => String(name ?? '').trim().split(/\s+/)[0] || '';
const nameList = (names) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

// The lines both messages share: when, what, and the link. A "Test: ..." topic reads as a test, but
// the topic itself is never sent: the planned topic often changes on the day.
function details(row, now) {
  const mins = Math.max(1, Math.round((new Date(row.scheduledAt).getTime() - now) / 60000));
  const isTest = /^Test:/.test(row.topic ?? '');
  return {
    what: isTest ? 'test' : 'class',
    when: `starts in ${mins} min, at ${time(row.scheduledAt)} IST.`,
    rest: `Join on Google Meet: ${row.meetLink}`,
  };
}

// To the teacher: their first name, and their students' first names (no batch name). `last`: the
// 2-minute last call.
function teacherText(row, now = Date.now(), last = false) {
  const d = details(row, now);
  const students = nameList(String(row.students ?? '').split(',').filter(Boolean).map(firstName));
  return `Hi ${firstName(row.teacher)},\nYour ${d.what}${students ? ` with ${students}` : ''} ${d.when}${last ? ' Please join now.' : ''}\n${d.rest}`;
}

// To one student's group (student, parent, admin): greets the student by first name.
function studentText(row, student, now = Date.now(), last = false) {
  const d = details(row, now);
  const hi = firstName(student);
  return `${hi ? `Hi ${hi}` : 'Hello'},\nYour ${d.what} ${d.when}\n${d.rest}\n${last ? 'Please join now.' : 'Please join a few minutes early.'}\n\nTeam AlmaED`;
}

// The batch's student groups (student, admin and the relay number), with whose group it is.
const GROUPS_OF_BATCH = `
  SELECT c."studentGroupJid", s.name AS student FROM "BatchStudent" bs
  JOIN "Batch" b ON b.id = bs."batchId"
  JOIN "User" s ON s.id = bs."studentId"
  JOIN "WaConversation" c ON c."teacherId" = b."teacherId" AND c."studentId" = bs."studentId"
  WHERE bs."batchId" = $1 AND c."studentGroupJid" IS NOT NULL AND NOT c."removeGroup"`;

// One reminder pass: each due class is claimed (its `col` stamped) before sending, so everyone gets it
// once even across restarts or overlapping passes.
async function remind(sql, col, last) {
  for (const row of (await q(sql)).rows) {
    const { rowCount } = await q(`UPDATE "Class" SET "${col}" = now() WHERE id = $1 AND "${col}" IS NULL`, [row.id]);
    if (rowCount !== 1) continue; // another pass got it
    if (row.phone) {
      try {
        await gowa.sendText(cfg.teacherDevice, toJid(row.phone, cfg.countryCode), teacherText(row, Date.now(), last));
      } catch (err) {
        console.error(`[reminders] teacher reminder for class ${row.id} failed:`, err.message);
      }
    }
    for (const g of (await q(GROUPS_OF_BATCH, [row.batchId])).rows) {
      await gowa.sendText(cfg.studentDevice, g.studentGroupJid, studentText(row, g.student, Date.now(), last))
        .catch((err) => console.error(`[reminders] group reminder for class ${row.id} failed:`, err.message));
    }
  }
}
const remindTeachers = () => remind(DUE, 'teacherWaRemindedAt', false);
// The last call, 2 minutes before: "starts in 2 min, please join now".
const lastCalls = () => remind(LAST_CALL, 'lastCallWaAt', true);

// `only`: 'last-call' asks the site for just its 2-minute reminder emails (every minute, so they're on time).
async function triggerSiteReminders(only) {
  if (!cfg.appUrl || !cfg.cronSecret) return;
  const res = await fetch(`${cfg.appUrl}/api/cron/class-reminders${only ? `?only=${only}` : ''}`, { headers: { Authorization: `Bearer ${cfg.cronSecret}` } });
  if (!res.ok) console.error(`[reminders] site reminder job${only ? ` (${only})` : ''} -> HTTP ${res.status}`);
}

function start() {
  const every = (ms, fn, what) => setInterval(() => fn().catch((err) => console.error(`[reminders] ${what}:`, err.message)), ms).unref();
  every(60e3, remindTeachers, 'teacher reminders');
  every(60e3, lastCalls, 'last-call reminders');
  every(60e3, () => triggerSiteReminders('last-call'), 'site last-call emails');
  every(5 * 60e3, () => triggerSiteReminders(), 'site reminder job');
  if (!cfg.appUrl || !cfg.cronSecret) console.warn('[reminders] APP_URL/CRON_SECRET not set: site reminder emails are not triggered from here');
}

module.exports = { start, remindTeachers, lastCalls, teacherText, studentText };
