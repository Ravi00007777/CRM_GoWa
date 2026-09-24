// Website -> WhatsApp. Teachers write in the AlmaEd site's doubt chat and upload resources
// there; this sends each one to the student's WhatsApp group through the student-facing
// number. AlmaEd (on Vercel) cannot reach gowa, so the shared database is the mailbox: a row
// whose waMessageId is null has not been sent yet.
//
// Each row is claimed (waMessageId = 'sending:<id>') before anything is sent, so a crash or
// a restart mid-send can never send it twice. The price is at-most-once: a row claimed and
// then lost stays 'sending:' and needs a manual resend.
const path = require('node:path');
const cfg = require('./config');
const gowa = require('./gowa');
const people = require('./people');
const { redact } = require('./redact');

const q = (sql, args) => people.pool.query(sql, args);

// Only messages whose student already has a group are picked up; the rest wait for groups.js.
const PENDING_DOUBTS = `
  SELECT d.id, d.body, d."imageUrl", t.name AS teacher, c."teacherId", c."studentId", c."studentGroupJid"
  FROM "DoubtMessage" d
  JOIN "Batch" b ON b.id = d."batchId"
  JOIN "User" t ON t.id = b."teacherId"
  JOIN "WaConversation" c ON c."teacherId" = b."teacherId" AND c."studentId" = d."studentId"
  WHERE d."waMessageId" IS NULL AND d."senderId" = b."teacherId" AND c."studentGroupJid" IS NOT NULL
  ORDER BY d."createdAt" LIMIT 20`;

const PENDING_RESOURCES = `
  SELECT r.id, r.title, r.type, r."fileUrl", r."dueAt", b."teacherId", t.name AS teacher
  FROM "Resource" r JOIN "Batch" b ON b.id = r."batchId" JOIN "User" t ON t.id = b."teacherId"
  WHERE r."waMessageId" IS NULL ORDER BY r."createdAt" LIMIT 5`;

const GROUPS_OF_RESOURCE = `
  SELECT c."studentId", c."studentGroupJid" FROM "Resource" r
  JOIN "Batch" b ON b.id = r."batchId"
  JOIN "BatchStudent" bs ON bs."batchId" = r."batchId"
  JOIN "WaConversation" c ON c."teacherId" = b."teacherId" AND c."studentId" = bs."studentId"
  WHERE r.id = $1 AND c."studentGroupJid" IS NOT NULL`;

async function claim(table, id) {
  const { rowCount } = await q(
    `UPDATE "${table}" SET "waMessageId" = $2 WHERE id = $1 AND "waMessageId" IS NULL`, [id, `sending:${id}`]);
  return rowCount === 1;
}
const mark = (table, id, value) => q(`UPDATE "${table}" SET "waMessageId" = $2 WHERE id = $1`, [id, value]);

const log = (row, content, status, outId) => people.log({
  teacherId: row.teacherId, studentId: row.studentId, direction: 'TEACHER_TO_STUDENT',
  waMessageId: null, outMessageId: outId, content, status,
}).catch((err) => console.error('[outbox] log failed:', err.message));

async function sendDoubt(row) {
  if (!(await claim('DoubtMessage', row.id))) return; // another pass got it first
  const { text, flagged } = redact(row.body || '');
  const body = text.trim() || (row.imageUrl ? '[sent an image on the AlmaEd website]' : '');
  if (flagged || !body) {
    await mark('DoubtMessage', row.id, `skipped:${row.id}`);
    return log(row, text, flagged ? 'FLAGGED' : 'DROPPED', null);
  }
  const sent = await gowa.sendText(cfg.studentDevice, row.studentGroupJid, `Teacher ${row.teacher}:\n${body}`);
  await mark('DoubtMessage', row.id, sent?.message_id || `sent:${row.id}`);
  await log(row, body, 'RELAYED', sent?.message_id || null);
}

// Teachers share files as Google Drive links; only older resources are files in AlmaEd's storage.
const isDriveLink = (url) => /^https:\/\/(?:drive|docs)\.google\.com\//.test(url);

async function sendResource(row) {
  if (!(await claim('Resource', row.id))) return;
  let file = null;
  let ext = '';
  if (!isDriveLink(row.fileUrl)) {
    const res = await fetch(row.fileUrl);
    if (!res.ok) throw new Error(`download ${row.fileUrl} -> HTTP ${res.status}`);
    file = Buffer.from(await res.arrayBuffer());
    ext = path.extname(new URL(row.fileUrl).pathname) || '.pdf';
  }
  const due = row.dueAt ? `\nDue: ${new Date(row.dueAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST` : '';
  const { text: title } = redact(row.title);
  const caption = `Teacher ${row.teacher} - new ${String(row.type).toLowerCase()}: ${title}${due}`;

  const { rows } = await q(GROUPS_OF_RESOURCE, [row.id]);
  for (const g of rows) {
    try {
      const sent = file
        ? await gowa.sendFile(cfg.studentDevice, g.studentGroupJid, file, `${title}${ext}`, caption)
        : await gowa.sendText(cfg.studentDevice, g.studentGroupJid, `${caption}\n${row.fileUrl}`);
      await log({ ...row, studentId: g.studentId }, caption, 'RELAYED', sent?.message_id || null);
    } catch (err) {
      console.error(`[outbox] resource ${row.id} to ${g.studentGroupJid} failed:`, err.message);
    }
  }
  await mark('Resource', row.id, `sent:${row.id}`);
}

// One pass: doubts first (short, time-sensitive), then files.
async function flush() {
  for (const row of (await q(PENDING_DOUBTS)).rows) {
    await sendDoubt(row).catch((err) => console.error(`[outbox] doubt ${row.id} failed:`, err.message));
  }
  for (const row of (await q(PENDING_RESOURCES)).rows) {
    await sendResource(row).catch((err) => console.error(`[outbox] resource ${row.id} failed:`, err.message));
  }
}

function start() {
  let busy = false;
  setInterval(async () => {
    if (busy) return; // a slow pass (big file) must not overlap the next one
    busy = true;
    try { await flush(); } catch (err) { console.error('[outbox] pass failed:', err.message); }
    busy = false;
  }, 5e3).unref();
}

module.exports = { flush, start };
