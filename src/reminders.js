const cron = require('node-cron');
const db = require('./db');
const cfg = require('./config');
const gowa = require('./gowa');

const H = 3600e3;
const KINDS = [
  { due: 'notes_due_at', sent: 'notes_sent_at', count: 'reminder_count',
    what: 'Class notes', how: (tag) => `Please send them here as a PDF/document, with the caption starting with #${tag}.` },
  { due: 'test_result_due_at', sent: 'test_result_sent_at', count: 'test_reminder_count',
    what: 'Sunday test result', how: (tag) => `Please send it here starting with #${tag} #result.` },
].map((k) => ({
  ...k,
  select: db.prepare(`
    SELECT c.id, c.${k.due} AS due, c.${k.count} AS n, t.wa_jid, t.name AS teacher, s.name AS student, s.tag
    FROM classes c JOIN teachers t ON t.id = c.teacher_id JOIN students s ON s.id = c.student_id
    WHERE c.${k.due} <= ? AND c.${k.sent} IS NULL AND c.${k.count} < 2
      AND s.teacher_id = c.teacher_id`), // unassigned teachers can't deliver, so don't chase them
  bump: db.prepare(`UPDATE classes SET ${k.count} = ${k.count} + 1,
    needs_followup = CASE WHEN ${k.count} + 1 >= 2 THEN 1 ELSE needs_followup END WHERE id = ?`),
}));

async function runReminders(now = Date.now()) {
  for (const k of KINDS) {
    for (const r of k.select.all(new Date(now).toISOString())) {
      // Reminder 1 at due time, reminder 2 one gap later (otherwise both fire 15 minutes apart).
      if (Date.parse(r.due) + r.n * cfg.reminderGapHours * H > now) continue;
      try {
        await gowa.sendText(cfg.teacherDevice, r.wa_jid,
          `Reminder ${r.n + 1}/2: ${k.what} for ${r.student} (class #${r.id}) is overdue. ${k.how(r.tag)}`);
        k.bump.run(r.id);
        if (r.n + 1 >= 2) {
          await gowa.alertAdmin(`Class #${r.id}: ${k.what} still missing after 2 reminders ` +
            `(teacher ${r.teacher}, student ${r.student}). Marked needs_followup.`);
        }
      } catch (err) {
        console.error(`[reminders] class ${r.id}:`, err.message);
      }
    }
  }
}

function start() {
  let running = false;
  cron.schedule('*/15 * * * *', async () => {
    if (running) return;
    running = true;
    try { await runReminders(); } finally { running = false; }
  });
}

module.exports = { start, runReminders };
