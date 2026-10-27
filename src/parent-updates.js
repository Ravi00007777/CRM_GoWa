// Weekly parent updates: the AlmaEd site's Admin → Parent updates page (ai_class_summaries rows a
// mentor approved, status 'send') → the student's WhatsApp group, where the parent is, from the
// student-facing number. Each row is claimed ('sending') before it is sent, so a restart or two
// overlapping passes can never send it twice; then 'sent'. A student with no group: 'failed', and
// the site shows it, so it can be approved again once the group exists.
const cfg = require('./config');
const gowa = require('./gowa');
const people = require('./people');

const q = (sql, args) => people.pool.query(sql, args);

const DUE = `SELECT id, "studentId", text FROM ai_class_summaries WHERE status = 'send' ORDER BY "approvedAt" LIMIT 10`;
const GROUP = `
  SELECT "studentGroupJid" FROM "WaConversation"
  WHERE "studentId" = $1 AND "studentGroupJid" IS NOT NULL AND NOT "removeGroup"
  ORDER BY "updatedAt" DESC LIMIT 1`;

async function sendParentUpdates() {
  for (const row of (await q(DUE)).rows) {
    const { rowCount } = await q(`UPDATE ai_class_summaries SET status = 'sending' WHERE id = $1 AND status = 'send'`, [row.id]);
    if (rowCount !== 1) continue; // another pass got it
    const jid = (await q(GROUP, [row.studentId])).rows[0]?.studentGroupJid;
    if (!jid) {
      await q(`UPDATE ai_class_summaries SET status = 'failed' WHERE id = $1`, [row.id]);
      continue;
    }
    try {
      await gowa.sendText(cfg.studentDevice, jid, row.text);
      await q(`UPDATE ai_class_summaries SET status = 'sent' WHERE id = $1`, [row.id]);
    } catch (err) {
      // Left as 'sending' (at most once): admin sees it stuck, and can send it by hand.
      console.error(`[parent-updates] update ${row.id} failed:`, err.message);
    }
  }
}

function start() {
  setInterval(() => sendParentUpdates().catch((err) => console.error('[parent-updates]', err.message)), 60e3).unref();
}

module.exports = { start, sendParentUpdates };
